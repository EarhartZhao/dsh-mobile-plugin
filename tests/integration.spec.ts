/**
 * Integration test over a real nats-server child process: the plugin side
 * (RpcBridge + EventBridge) and a simulated app exchange over the wire.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, headers, type Msg, type NatsConnection } from 'nats'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RpcBridge, TOKEN_HEADER, type FetchCarrier } from '../src/bridge.js'
import { EventBridge, type EventStreams, type StreamFrame } from '../src/events.js'
import { TokenStore } from '../src/tokens.js'

const PORT = 14222 + Math.floor(Math.random() * 1000)
const SERVER_URL = `nats://127.0.0.1:${PORT}`
const INSTANCE = 'itest'

let server: ChildProcess
let pluginNc: NatsConnection
let appNc: NatsConnection
let dir: string
let tokens: TokenStore
let eventBridge: EventBridge
let muxFrames: StreamFrame[] = []
let muxSignal: AbortSignal | null = null
let carrierCalls: string[] = []

async function* muxStream(signal: AbortSignal): AsyncIterable<StreamFrame> {
  muxSignal = signal
  let cursor = 0
  while (!signal.aborted) {
    if (cursor < muxFrames.length) yield muxFrames[cursor++]
    else await new Promise(r => setTimeout(r, 10))
  }
}

beforeAll(async () => {
  const debug = process.env.NATS_TRACE === '1'
  server = spawn('nats-server', ['-p', String(PORT), ...(debug ? ['-DV'] : [])], { stdio: debug ? ['ignore', 'inherit', 'inherit'] : 'ignore' })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('nats-server start timeout')), 8000)
    const probe = setInterval(async () => {
      try {
        const nc = await connect({ servers: SERVER_URL, timeout: 500, maxReconnectAttempts: 0 })
        await nc.close()
        clearInterval(probe)
        clearTimeout(timer)
        resolve()
      } catch { /* not up yet */ }
    }, 200)
  })

  dir = await mkdtemp(join(tmpdir(), 'dsh-mobile-itest-'))
  tokens = new TokenStore(join(dir, 'tokens.json'))
  await tokens.load()

  const carrier: FetchCarrier = {
    fetch: (async (input: RequestInfo | URL) => {
      const req = input as Request
      carrierCalls.push(new URL(req.url).pathname)
      const body = JSON.parse(await req.text())
      return new Response(JSON.stringify({
        type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { sessions: [] } },
      }))
    }) as typeof fetch,
  }

  pluginNc = await connect({ servers: SERVER_URL })
  eventBridge = new EventBridge(pluginNc, {
    events: {
      mux: (_req, signal) => muxStream(signal),
      host: (_req, signal) => muxStream(signal),
    },
  } as EventStreams, { instanceId: INSTANCE, coalesceMs: 0 })
  eventBridge.start()

  const bridge = new RpcBridge(pluginNc, {
    instanceId: INSTANCE,
    carrier,
    tokens,
    tokenTtlDays: 90,
    maxDevices: 10,
    onHello: () => eventBridge.replayPending(),
  })
  bridge.start()

  await pluginNc.flush() // subscription must reach the server before requests arrive
  appNc = await connect({ servers: SERVER_URL })
}, 20000)

afterAll(async () => {
  await appNc?.drain()
  await pluginNc?.drain()
  await eventBridge?.stop()
  server?.kill()
  await rm(dir, { recursive: true, force: true })
})

/**
 * Explicit-inbox request instead of nc.request(): the nats request-mux has
 * shown flaky reply correlation under vitest workers, while the real app's
 * transport correlates replies by the echoed rpcId anyway.
 */
async function appRequest(method: string, payload: unknown, token?: string) {
  const inbox = `_INBOX.itest.${crypto.randomUUID()}`
  const msgPromise = new Promise<Msg>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('reply timeout')), 5000)
    const sub = appNc.subscribe(inbox, {
      callback: (err, msg) => {
        clearTimeout(timeout)
        sub.unsubscribe()
        if (err) reject(err)
        else resolve(msg)
      },
    })
  })
  await appNc.flush()
  const h = headers()
  if (token !== undefined) h.set(TOKEN_HEADER, token)
  appNc.publish(
    `svc.dsh.${INSTANCE}.${method}`,
    JSON.stringify({ type: 'client-request', rpcId: `app-${method}`, method, payload }),
    { reply: inbox, headers: h },
  )
  return msgPromise
}

describe('integration over real NATS', () => {
  it('runs the full flow: pair, gated RPC, events, hello replay', async () => {
    // 1. RPC without token is rejected
    const denied = await appRequest('session.list', {})
    expect(JSON.parse(denied.string()).result.error.message).toBe('mobile-unauthenticated')

    // 2. Pair to get a token
    const pairReply = await appRequest('pair', { code: '', deviceName: 'itest' })
    expect(JSON.parse(pairReply.string()).result.ok).toBe(false) // wrong code

    const { code } = tokens.createPairingCode(120)
    const paired = await appRequest('pair', { code, deviceName: 'itest' })
    const token = JSON.parse(paired.string()).result.value.token as string
    expect(typeof token).toBe('string')

    // 3. Gated RPC with token reaches the carrier
    const ok = await appRequest('session.list', {}, token)
    expect(JSON.parse(ok.string()).result.value.sessions).toEqual([])
    expect(carrierCalls).toContain('/api/session.list')

    // 4. Event frames flow plugin -> app
    const received: string[] = []
    const sub = appNc.subscribe(`evt.dsh.${INSTANCE}.mux`)
    await appNc.flush()
    void (async () => {
      for await (const m of sub) received.push(JSON.parse(m.string()).method)
    })()

    muxFrames.push({ rpcId: 'f1', payload: { type: 'approval/requested', sessionId: 's1', approvalId: 'ap1', toolName: 'bash' } })
    await new Promise(r => setTimeout(r, 300))
    expect(received).toContain('approval/requested')

    // 5. hello replays pending answerables
    received.length = 0
    await appRequest('hello', {}, token)
    await new Promise(r => setTimeout(r, 300))
    expect(received).toContain('approval/requested')

    // 6. Resolving the approval clears the pending replay
    muxFrames.push({ rpcId: 'f2', payload: { type: 'approval/resolved', sessionId: 's1', approvalId: 'ap1', outcome: 'approved' } })
    await new Promise(r => setTimeout(r, 300))
    received.length = 0
    await appRequest('hello', {}, token)
    await new Promise(r => setTimeout(r, 300))
    expect(received).not.toContain('approval/requested')

    sub.unsubscribe()
  }, 15000)
})
