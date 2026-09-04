import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RpcBridge, TOKEN_HEADER, type FetchCarrier, type GatewayCarrier } from '../src/bridge.js'
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
  let inventoryValue: unknown
  let healthValue: unknown
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
    inventoryValue = null
    healthValue = { status: 'ok', pluginVersion: '0.2.0', instanceId: 'test' }

    const nc = { subscribe: () => fakeSubscription([]) } as never
    bridge = new RpcBridge(nc, {
      instanceId: 'test',
      carrier,
      tokens,
      tokenTtlDays: 90,
      maxDevices: 10,
      onHello: () => { helloCount += 1 },
      onInventory: () => inventoryValue,
      onHealth: () => healthValue,
    })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  // Drive the private handler directly: NATS plumbing is integration-tested separately.
  async function drive(msg: FakeMsg): Promise<void> {
    await (bridge as any).handle(msg)
  }

  function useGateway(options: {
    value?: unknown
    stream?: unknown[]
    host?: unknown
    workspaces?: unknown
    onRespond?: (rpcId: string, result: unknown) => Promise<boolean>
  } = {}): { calls: any[] } {
    const calls: any[] = []
    const gateway: GatewayCarrier = {
      invoke: async request => { calls.push(request); return options.value ?? { accepted: true } },
      stream: async request => {
        calls.push(request)
        const values = options.stream ?? []
        return (async function* () { yield* values })()
      },
      wireStream: { failure: error => ({ code: 'gateway/internal', message: String(error), details: {} }) },
    }
    const nc = { subscribe: () => fakeSubscription([]) } as never
    bridge = new RpcBridge(nc, {
      instanceId: 'test', carrier, gateway, tokens,
      tokenTtlDays: 90, maxDevices: 10,
      onHello: () => { helloCount += 1 },
      onHostDescribe: () => options.host,
      onWorkspaceList: () => options.workspaces,
      ...(options.onRespond === undefined ? {} : { onRespond: options.onRespond }),
    })
    return { calls }
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

  it('reports the device limit separately from an invalid pairing code', async () => {
    const invalid = makeMsg(`${PREFIX}pair`, {
      type: 'client-request', rpcId: 'pair-invalid', method: 'pair',
      payload: { code: 'NOPE1234', deviceName: 'new-phone' },
    })
    await drive(invalid)
    expect(replyJson(invalid).result.error.message).toBe('mobile-pair-failed')

    const { code } = tokens.createPairingCode(120)
    const limitedNc = { subscribe: () => fakeSubscription([]) } as never
    bridge = new RpcBridge(limitedNc, {
      instanceId: 'test', carrier, tokens, tokenTtlDays: 90, maxDevices: 1,
      onHello: () => { helloCount += 1 },
    })
    const limited = makeMsg(`${PREFIX}pair`, {
      type: 'client-request', rpcId: 'pair-limit', method: 'pair',
      payload: { code, deviceName: 'new-phone' },
    })
    await drive(limited)
    expect(replyJson(limited).result.error.message).toBe('mobile-device-limit')
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

  it('adapts legacy session calls to current Gateway endpoints and named args', async () => {
    const gateway = useGateway({ value: { items: [] } })
    let msg = makeMsg(`${PREFIX}session.list`, {
      type: 'client-request', rpcId: 'g-list', method: 'session.list', payload: {},
    }, validToken)
    await drive(msg)
    expect(gateway.calls[0]).toEqual({ namespace: 'session', method: 'list', args: { _request: {} } })
    expect(replyJson(msg).result.value).toEqual({ items: [] })

    msg = makeMsg(`${PREFIX}session.prompt`, {
      type: 'client-request', rpcId: 'g-prompt', method: 'session.prompt',
      payload: { sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'hi' }] },
    }, validToken)
    await drive(msg)
    expect(gateway.calls[1]).toEqual({
      namespace: 'session', method: 'prompt',
      args: { request: { requestId: 'g-prompt', sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'hi' }] } },
    })
  })

  it('maps command, reference, preset, and goal calls to alpha.5 Remote arguments', async () => {
    const gateway = useGateway({ value: { ref: { id: 'goal-1', revision: 1 } } })
    for (const [rpcId, method, payload] of [
      ['command-list', 'command.list', { sessionId: 's1' }],
      ['command-run', 'command.execute', { sessionId: 's1', line: '/plan', images: [] }],
      ['reference-files', 'reference.files', { sessionId: 's1', query: 'src' }],
      ['reference-sessions', 'reference.sessions', { sessionId: 's1', query: 'research' }],
      ['preset', 'agentPreset.select', { sessionId: 's1', agentPreset: 'coding' }],
      ['goal-create', 'goal.create', { sessionId: 's1', objective: 'ship', maxGoalRounds: 4 }],
      ['goal-edit', 'goal.edit', { sessionId: 's1', ref: { id: 'goal-1', revision: 1 }, objective: 'land' }],
      ['goal-pause', 'goal.pause', { sessionId: 's1', ref: { id: 'goal-1', revision: 2 } }],
    ] as const) {
      const msg = makeMsg(`${PREFIX}${method}`, { type: 'client-request', rpcId, method, payload }, validToken)
      await drive(msg)
      expect(replyJson(msg).result.ok).toBe(true)
    }
    expect(gateway.calls).toEqual([
      { namespace: 'commands', method: 'list', args: { agentId: 's1' } },
      { namespace: 'commands', method: 'execute', args: { agentId: 's1', line: '/plan', images: [] } },
      { namespace: 'fileReferences', method: 'list', args: { agentId: 's1', query: 'src' } },
      { namespace: 'sessionReferenceResolver', method: 'candidates', args: { agentId: 's1', query: 'research' } },
      { namespace: 'agentPresets', method: 'select', args: { agentId: 's1', agentPreset: 'coding' } },
      { namespace: 'goals', method: 'create', args: { agentId: 's1', request: { objective: 'ship', maxGoalRounds: 4 } } },
      { namespace: 'goals', method: 'edit', args: { agentId: 's1', ref: { id: 'goal-1', revision: 1 }, request: { objective: 'land' } } },
      { namespace: 'goals', method: 'pause', args: { agentId: 's1', ref: { id: 'goal-1', revision: 2 } } },
    ])
  })

  it('serves removed host/workspace baselines and converts session follow snapshots', async () => {
    const host = { version: 'dev', cwd: 'C:\\repo', attachedSessions: 0, home: 'C:\\Users\\test', canOpenPath: false }
    const workspaces = { items: [], archivedSessionIds: [] }
    const gateway = useGateway({
      host, workspaces,
      stream: [{
        type: 'snapshot', cursor: 2,
        records: [{ type: 'event', event: { type: 'user/message', seq: 2, time: 1, data: {} } }],
        hasMore: false, projections: { asOfSeq: 2, values: {} },
      }],
    })
    let msg = makeMsg(`${PREFIX}host.describe`, { type: 'client-request', rpcId: 'g-host', method: 'host.describe', payload: {} }, validToken)
    await drive(msg)
    expect(replyJson(msg).result.value).toEqual(host)

    msg = makeMsg(`${PREFIX}workspace.list`, { type: 'client-request', rpcId: 'g-ws', method: 'workspace.list', payload: {} }, validToken)
    await drive(msg)
    expect(replyJson(msg).result.value).toEqual(workspaces)

    msg = makeMsg(`${PREFIX}session.history`, {
      type: 'client-request', rpcId: 'g-history', method: 'session.history',
      payload: { sessionId: 's1', maxMessages: 50 },
    }, validToken)
    await drive(msg)
    expect(gateway.calls[0]).toEqual({
      namespace: 'session', method: 'follow',
      args: { request: { address: { kind: 'session', sessionId: 's1' }, maxMessages: 50 } },
    })
    expect(replyJson(msg).result.value).toEqual({
      events: [{ event: { type: 'user/message', seq: 2, time: 1, data: {} } }],
      hasMore: false,
      projections: { asOfSeq: 2, values: {} },
    })
  })

  it('uses follow cursor for history pages and expands packed chunk records', async () => {
    const gateway = useGateway({
      stream: [{
        type: 'snapshot', cursor: 9,
        records: [{
          type: 'chunks',
          event: {
            type: 'chunkrow/text-chunks', seq: 6, time: 100,
            data: { turn: 1, step: 1, index: 0, dt: [2, 3], texts: ['a', 'b', 'c'] },
          },
        }],
        hasMore: true, projections: { asOfSeq: 9, values: {} },
      }],
      value: {
        records: [{ type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } }],
        hasMore: false,
      },
    })
    let msg = makeMsg(`${PREFIX}session.history`, {
      type: 'client-request', rpcId: 'tail', method: 'session.history', payload: { sessionId: 's1', maxMessages: 20 },
    }, validToken)
    await drive(msg)
    expect(replyJson(msg).result.value.events.map((entry: any) => entry.event)).toEqual([
      { type: 'assistant/chunk', seq: 6, time: 100, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'a' } } },
      { type: 'assistant/chunk', seq: 7, time: 102, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'b' } } },
      { type: 'assistant/chunk', seq: 8, time: 105, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'c' } } },
    ])

    msg = makeMsg(`${PREFIX}session.history`, {
      type: 'client-request', rpcId: 'page', method: 'session.history', payload: { sessionId: 's1', beforeSeq: 6, maxMessages: 20 },
    }, validToken)
    await drive(msg)
    expect(gateway.calls.at(-1)).toEqual({
      namespace: 'session', method: 'page',
      args: { request: { address: { kind: 'session', sessionId: 's1' }, throughSeq: 9, beforeSeq: 6, maxMessages: 20 } },
    })
    expect(replyJson(msg).result.value.events[0].event.type).toBe('turn/start')
  })

  it('allows the three RPC methods used by durable images and ordering', async () => {
    for (const method of ['session.attachment', 'workspace.insertBefore', 'workspace.insertSessionBefore']) {
      const envelope = { type: 'client-request', rpcId: `r-${method}`, method, payload: {} }
      const msg = makeMsg(`${PREFIX}${method}`, envelope, validToken)
      await drive(msg)
      expect(carrierCalls.at(-1)?.url).toBe(`http://mobile.internal/api/${method}`)
      expect(JSON.parse(carrierCalls.at(-1)?.body ?? '{}')).toEqual(envelope)
      expect(replyJson(msg).result.value.echoed).toBe(true)
    }
  })

  it('routes legacy respond to /api/respond without a Gateway', async () => {
    const msg = makeMsg(`${PREFIX}respond`, { type: 'client-response', rpcId: 'r6', result: { ok: true, value: {} } }, validToken)
    await drive(msg)
    expect(carrierCalls[0].url).toBe('http://mobile.internal/api/respond')
  })

  it('settles Gateway Remote Events and returns a legacy receipt', async () => {
    const responses: unknown[] = []
    useGateway({
      onRespond: async (rpcId, result) => {
        responses.push({ rpcId, result })
        return true
      },
    })
    const result = { ok: true, value: { sessionId: 's1', approvalId: 'a1', outcome: 'allowed-once' } }
    const msg = makeMsg(`${PREFIX}respond`, { type: 'client-response', rpcId: 'event-1', result }, validToken)
    await drive(msg)
    expect(replyJson(msg)).toEqual({ accepted: true })
    expect(responses).toEqual([{ rpcId: 'event-1', result }])
    expect(carrierCalls).toHaveLength(0)
  })

  it('hello triggers the pending-frame replay without touching the carrier', async () => {
    const msg = makeMsg(`${PREFIX}hello`, { type: 'client-request', rpcId: 'r7', method: 'hello', payload: {} }, validToken)
    await drive(msg)
    expect(helloCount).toBe(1)
    expect(replyJson(msg).result.ok).toBe(true)
    expect(carrierCalls).toHaveLength(0)
  })

  it('serves the plugin compatibility manifest after token auth', async () => {
    const msg = makeMsg(`${PREFIX}mobile.info`, { type: 'client-request', rpcId: 'r-info', method: 'mobile.info', payload: {} }, validToken)
    await drive(msg)
    const reply = replyJson(msg)
    expect(reply.result.value).toEqual({
      pluginVersion: '0.2.1',
      mobileApi: 2,
      features: [
        'plus-menu', 'command-directory', 'multi-image', 'durable-attachment-order',
        'plugin-inventory', 'health-check', 'typert-remote-v2', 'session-history-pages',
        'session-control', 'workspace-follow', 'remote-event-results', 'reference-candidates',
      ],
    })
    expect(carrierCalls).toHaveLength(0)
  })

  it('serves the authenticated mobile health snapshot without using the carrier', async () => {
    const msg = makeMsg(`${PREFIX}mobile.health`, { type: 'client-request', rpcId: 'r-health', method: 'mobile.health', payload: {} }, validToken)
    await drive(msg)
    expect(replyJson(msg).result.value).toEqual(healthValue)
    expect(carrierCalls).toHaveLength(0)
  })

  it('serves the read-only inventory and reports an absent host service', async () => {
    const snapshot = { entries: [{ entryId: 'entry', moduleName: 'mobile', enabled: true, fiberPhase: 'active' }] }
    inventoryValue = snapshot
    let msg = makeMsg(`${PREFIX}mobile.inventory`, { type: 'client-request', rpcId: 'r-inv', method: 'mobile.inventory', payload: {} }, validToken)
    await drive(msg)
    expect(replyJson(msg).result.value).toEqual(snapshot)
    expect(carrierCalls).toHaveLength(0)

    inventoryValue = null
    msg = makeMsg(`${PREFIX}mobile.inventory`, { type: 'client-request', rpcId: 'r-inv-missing', method: 'mobile.inventory', payload: {} }, validToken)
    await drive(msg)
    expect(replyJson(msg).result.error.message).toBe('mobile-forbidden')
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
