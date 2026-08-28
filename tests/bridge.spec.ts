import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RpcBridge, TOKEN_HEADER, type FetchCarrier } from '../src/bridge.js'
import { TokenStore } from '../src/tokens.js'

interface FakeMsg {
  subject: string
  data: Uint8Array
  headers?: { get(key: string): string | undefined }
  replies: Uint8Array[]
  respond(data: Uint8Array): void
}

function makeMsg(subject: string, envelope: unknown, token?: string): FakeMsg {
  const replies: Uint8Array[] = []
  return {
    subject,
    data: new TextEncoder().encode(JSON.stringify(envelope)),
    headers: token === undefined ? undefined : { get: (k: string) => k === TOKEN_HEADER ? token : undefined },
    replies,
    respond(data: Uint8Array) { replies.push(data) },
  }
}

function replyJson(msg: FakeMsg): any {
  expect(msg.replies).toHaveLength(1)
  return JSON.parse(new TextDecoder().decode(msg.replies[0]))
}

/** Minimal async-iterable subscription fed imperatively. */
function fakeSubscription(queue: FakeMsg[]) {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<FakeMsg>>(resolve => {
          const msg = queue.shift()
          if (msg !== undefined) resolve({ value: msg, done: false })
          else resolve({ value: undefined as never, done: true })
        }),
      }
    },
    unsubscribe() {},
  }
}

describe('RpcBridge', () => {
  let dir: string
  let tokens: TokenStore
  let validToken: string
  let carrierCalls: { url: string, body: string }[]
  let carrier: FetchCarrier
  let helloCount: number
  let bridge: RpcBridge

  const PREFIX = 'svc.dsh.test.'

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-mobile-bridge-'))
    tokens = new TokenStore(join(dir, 'tokens.json'))
    await tokens.load()
    const { code } = tokens.createPairingCode(120)
    validToken = (await tokens.redeemPairingCode(code, 'test-phone', 90, 10))!.token

    carrierCalls = []
    carrier = {
      fetch: (async (input: RequestInfo | URL) => {
        const req = input as Request
        const body = await req.text()
        carrierCalls.push({ url: req.url, body })
        const rpcId = JSON.parse(body).rpcId
        return new Response(JSON.stringify({
          type: 'server-response', rpcId, result: { ok: true, value: { echoed: true } },
        }))
      }) as typeof fetch,
    }
    helloCount = 0

    const nc = { subscribe: () => fakeSubscription([]) } as never
    bridge = new RpcBridge(nc, {
      instanceId: 'test',
      carrier,
      tokens,
      tokenTtlDays: 90,
      maxDevices: 10,
      onHello: () => { helloCount += 1 },
    })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  // Drive the private handler directly: NATS plumbing is integration-tested separately.
  async function drive(msg: FakeMsg): Promise<void> {
    await (bridge as any).handle(msg)
  }

  it('redeems a pairing code without a token', async () => {
    const store = tokens
    const { code } = store.createPairingCode(120)
    const msg = makeMsg(`${PREFIX}pair`, {
      type: 'client-request', rpcId: 'r1', method: 'pair',
      payload: { code, deviceName: 'new-phone' },
    })
    await drive(msg)
    const reply = replyJson(msg)
    expect(reply.result.ok).toBe(true)
    expect(typeof reply.result.value.token).toBe('string')
  })

  it('rejects requests without a token', async () => {
    const msg = makeMsg(`${PREFIX}session.list`, { type: 'client-request', rpcId: 'r2', method: 'session.list', payload: {} })
    await drive(msg)
    const reply = replyJson(msg)
    expect(reply.result.ok).toBe(false)
    expect(reply.result.error.message).toBe('mobile-unauthenticated')
    expect(carrierCalls).toHaveLength(0)
  })

  it('rejects requests with a revoked token', async () => {
    const device = tokens.validate(validToken)!
    await tokens.revoke(device.id)
    const msg = makeMsg(`${PREFIX}session.list`, { type: 'client-request', rpcId: 'r3', method: 'session.list', payload: {} }, validToken)
    await drive(msg)
    expect(replyJson(msg).result.error.message).toBe('mobile-unauthenticated')
    expect(carrierCalls).toHaveLength(0)
  })

  it('rejects methods outside the whitelist', async () => {
    const msg = makeMsg(`${PREFIX}settings.update`, { type: 'client-request', rpcId: 'r4', method: 'settings.update', payload: {} }, validToken)
    await drive(msg)
    expect(replyJson(msg).result.error.message).toBe('mobile-forbidden')
    expect(carrierCalls).toHaveLength(0)
  })

  it('forwards whitelisted methods to the carrier and relays the response', async () => {
    const envelope = { type: 'client-request', rpcId: 'r5', method: 'session.list', payload: {} }
    const msg = makeMsg(`${PREFIX}session.list`, envelope, validToken)
    await drive(msg)
    expect(carrierCalls).toHaveLength(1)
    expect(carrierCalls[0].url).toBe('http://mobile.internal/api/session.list')
    expect(JSON.parse(carrierCalls[0].body)).toEqual(envelope)
    const reply = replyJson(msg)
    expect(reply.rpcId).toBe('r5')
    expect(reply.result.value.echoed).toBe(true)
  })

  it('routes respond to /api/respond', async () => {
    const msg = makeMsg(`${PREFIX}respond`, { type: 'client-response', rpcId: 'r6', result: { ok: true, value: {} } }, validToken)
    await drive(msg)
    expect(carrierCalls[0].url).toBe('http://mobile.internal/api/respond')
  })

  it('hello triggers the pending-frame replay without touching the carrier', async () => {
    const msg = makeMsg(`${PREFIX}hello`, { type: 'client-request', rpcId: 'r7', method: 'hello', payload: {} }, validToken)
    await drive(msg)
    expect(helloCount).toBe(1)
    expect(replyJson(msg).result.ok).toBe(true)
    expect(carrierCalls).toHaveLength(0)
  })

  it('malformed payloads get a gate-shaped error instead of a hang', async () => {
    const replies: Uint8Array[] = []
    const msg: FakeMsg = {
      subject: `${PREFIX}session.list`,
      data: new TextEncoder().encode('not json'),
      replies,
      respond(data: Uint8Array) { replies.push(data) },
    }
    await drive(msg)
    const reply = replyJson(msg)
    expect(reply.result.error.message).toBe('mobile-forbidden')
  })
})
