/**
 * Integration test over a real nats-server child process: the plugin side
 * (RpcBridge + EventBridge) and a simulated app exchange over the wire.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, headers, type Msg, type NatsConnection } from 'nats'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RpcBridge, TOKEN_HEADER, type FetchCarrier, type GatewayCarrier } from '../src/bridge.js'
import { EventBridge, type EventStreams, type StreamFrame } from '../src/events.js'
import { TokenStore } from '../src/tokens.js'

// A wide, suite-local port range keeps this server clear of the other suites'
// servers; the readiness wait below tolerates a loaded machine.
const PORT = 14222 + Math.floor(Math.random() * 2000)
const SERVER_URL = `nats://127.0.0.1:${PORT}`
const INSTANCE = 'itest'
const NATS_SERVER_BIN = process.env.NATS_SERVER_BIN ?? 'nats-server'
const HAS_NATS = spawnSync(NATS_SERVER_BIN, ['-v'], { stdio: 'ignore' }).status === 0
const integrationTest = HAS_NATS ? it : it.skip

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
  if (!HAS_NATS) return
  const debug = process.env.NATS_TRACE === '1'
  server = spawn(NATS_SERVER_BIN, ['-p', String(PORT), ...(debug ? ['-DV'] : [])], { stdio: debug ? ['ignore', 'inherit', 'inherit'] : 'ignore' })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('nats-server start timeout')), 20_000)
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
  if (!HAS_NATS) return
  await appNc?.drain()
  await pluginNc?.drain()
  await eventBridge?.stop()
  server?.kill()
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
})

/**
 * Explicit-inbox request instead of nc.request(): the nats request-mux has
 * shown flaky reply correlation under vitest workers, while the real app's
 * transport correlates replies by the echoed rpcId anyway.
 */
async function appRequest(method: string, payload: unknown, token?: string, instance = INSTANCE) {
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
    `svc.dsh.${instance}.${method}`,
    JSON.stringify({ type: 'client-request', rpcId: `app-${method}`, method, payload }),
    { reply: inbox, headers: h },
  )
  return msgPromise
}

describe('integration over real NATS', () => {
integrationTest('runs the full flow: pair, gated RPC, events, hello replay', async () => {
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

  /**
   * One history read answered from a canned host page, over the same real
   * server: the ceiling under test here is the server's own `max_payload`, not
   * a number the test picked.
   * @param records - the page the fake host returns.
   * @param instance - namespace to run the throwaway bridge on.
   * @returns the reply an App-shaped client received.
   */
  async function historyReplyFor(records: unknown[], instance: string): Promise<Msg> {
    const gateway = {
      invoke: async () => ({ records, hasMore: true }),
      stream: async () => (async function* snapshots() {
        yield {
          type: 'snapshot', cursor: records.length, records, hasMore: false,
          projections: { asOfSeq: records.length, values: {} },
        }
      })(),
      wireStream: { failure: (error: unknown) => ({ code: 'internal', message: String(error), details: {} }) },
    } as unknown as GatewayCarrier
    const bridge = new RpcBridge(pluginNc, {
      instanceId: instance, instanceName: instance, gateway, tokens, tokenTtlDays: 90, maxDevices: 10,
    })
    bridge.start()
    await pluginNc.flush()
    const { code } = tokens.createPairingCode(120)
    const token = (await tokens.redeemPairingCode(code, instance, 90, 10))?.token ?? ''
    try {
      return await appRequest('session.history', { sessionId: 's1', maxMessages: 120 }, token, instance)
    } finally {
      await bridge.stop()
    }
  }

  integrationTest('answers a page bigger than one publish with the newest records', async () => {
    // 8 × 400 KiB ≈ 3.2 MiB, past the 1 MiB every NATS server starts at. The
    // client refuses an oversized publish itself, so before the trim this read
    // reached neither the Hub nor the phone — the Session simply looked empty.
    const records = Array.from({ length: 8 }, (_, index) => ({
      type: 'event',
      event: { type: 'assistant/message', seq: index + 1, time: index, data: { text: 'x'.repeat(400 * 1024) } },
    }))
    expect(pluginNc.info?.max_payload).toBe(1024 * 1024)
    const reply = await historyReplyFor(records, 'itest-trim')
    const parsed = JSON.parse(reply.string())
    expect(parsed.result.ok).toBe(true)
    const seqs = parsed.result.value.events.map((entry: { event: { seq: number } }) => entry.event.seq)
    expect(seqs.length).toBeGreaterThan(0)
    expect(seqs.length).toBeLessThan(records.length)
    expect(seqs).toEqual(records.slice(records.length - seqs.length).map(record => record.event.seq))
    expect(seqs.at(-1)).toBe(records.length)
    // Short, not lost: the App keeps walking back from the oldest record it got.
    expect(parsed.result.value.hasMore).toBe(true)
    expect(reply.data.length).toBeLessThanOrEqual(1024 * 1024)
  }, 15000)

  integrationTest('caps a single record too big for one publish instead of failing the read', async () => {
    // There is no window smaller than one record to ask for, so this one has to
    // arrive short: failing it would strand every older page behind it.
    const huge = 'x'.repeat(2 * 1024 * 1024)
    const reply = await historyReplyFor(
      [{ type: 'event', event: { type: 'tool/result', seq: 1, time: 0, data: { text: huge } } }],
      'itest-cap',
    )
    const parsed = JSON.parse(reply.string())
    expect(parsed.result.ok).toBe(true)
    expect(parsed.result.value.events).toHaveLength(1)
    // Shape survives: same type, same seq, only the long string is cut.
    expect(parsed.result.value.events[0].event.type).toBe('tool/result')
    expect(parsed.result.value.events[0].event.seq).toBe(1)
    expect(parsed.result.value.events[0].event.data.text).toContain('已截断')
    expect(parsed.result.value.events[0].event.data.text.length).toBeLessThan(huge.length)
    expect(reply.data.length).toBeLessThanOrEqual(1024 * 1024)
  }, 15000)
})
