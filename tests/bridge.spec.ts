import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MOBILE_ERROR_CODES,
  MOBILE_ERROR_FIELDS,
  RpcBridge,
  TOKEN_HEADER,
  type FetchCarrier,
  type GatewayCarrier,
} from '../src/bridge.js'
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
  let eventKey: string
  let carrierCalls: { url: string, body: string }[]
  let carrier: FetchCarrier
  let helloCount: number
  let helloArgs: { deviceId: string, deviceName?: string } | null
  let inventoryValue: unknown
  let healthValue: unknown
  let bridge: RpcBridge

  const PREFIX = 'svc.dsh.test.'
  const GATEWAY_ID = 'd56a1098-8519-43a1-9dce-fb99863bf5bb'

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-mobile-bridge-'))
    tokens = new TokenStore(join(dir, 'tokens.json'))
    await tokens.load()
    const { code } = tokens.createPairingCode(120)
    const paired = (await tokens.redeemPairingCode(code, 'test-phone', 90, 10))!
    validToken = paired.token
    eventKey = paired.eventKey

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
    helloArgs = null
    inventoryValue = null
    healthValue = { status: 'ok', pluginVersion: '0.2.0', instanceId: 'test' }

    const nc = { subscribe: () => fakeSubscription([]) } as never
    bridge = new RpcBridge(nc, {
      instanceId: 'test',
      gatewayId: GATEWAY_ID,
      instanceName: 'test-mac',
      carrier,
      tokens,
      tokenTtlDays: 90,
      maxDevices: 10,
      onHello: (deviceId, deviceName) => { helloCount += 1; helloArgs = { deviceId, deviceName } },
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
    onStaleRespond?: (eventId: string, result: unknown) => void
    onFileWatch?: (sessionId: string) => void
    onFileUnwatch?: (sessionId: string) => void
    onSessionOpened?: (sessionId: string) => void
    /** Per-call override, for hosts that reject the first shape they are sent. */
    invoke?: (request: { namespace: string, method: string, args: Record<string, unknown> }, calls: any[]) => Promise<unknown>
    /** Carrier-side failure decoding, so tests exercise codes instead of messages. */
    failure?: (error: unknown) => { code: string, message: string, details: object }
    /** What the fake connection reports as its publish ceiling, in bytes. */
    maxPayload?: number
  } = {}): { calls: any[] } {
    const calls: any[] = []
    const gateway: GatewayCarrier = {
      invoke: async request => {
        calls.push(request)
        return options.invoke === undefined ? options.value ?? { accepted: true } : await options.invoke(request, calls)
      },
      stream: async request => {
        calls.push(request)
        const values = options.stream ?? []
        return (async function* () { yield* values })()
      },
      wireStream: {
        failure: options.failure ?? (error => {
          return { code: 'gateway/internal', message: String(error), details: {} }
        }),
      },
    }
    const nc = {
      subscribe: () => fakeSubscription([]),
      ...(options.maxPayload === undefined ? {} : { info: { max_payload: options.maxPayload } }),
    } as never
    bridge = new RpcBridge(nc, {
      instanceId: 'test', instanceName: 'test', carrier, gateway, tokens,
      tokenTtlDays: 90, maxDevices: 10,
      onHello: () => { helloCount += 1 },
      onHostDescribe: () => options.host,
      onWorkspaceList: () => options.workspaces,
      ...(options.onRespond === undefined ? {} : { onRespond: options.onRespond }),
      ...(options.onStaleRespond === undefined ? {} : { onStaleRespond: options.onStaleRespond }),
      ...(options.onFileWatch === undefined ? {} : { onFileWatch: options.onFileWatch }),
      ...(options.onFileUnwatch === undefined ? {} : { onFileUnwatch: options.onFileUnwatch }),
      ...(options.onSessionOpened === undefined ? {} : { onSessionOpened: options.onSessionOpened }),
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
      instanceId: 'test', instanceName: 'test', carrier, tokens, tokenTtlDays: 90, maxDevices: 1,
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

  it('maps command, reference, preset, and goal calls to current Remote arguments', async () => {
    const gateway = useGateway({ value: { ref: { id: 'goal-1', revision: 1 } } })
    for (const [rpcId, method, payload] of [
      ['command-list', 'command.list', { sessionId: 's1' }],
      ['command-run', 'command.execute', { sessionId: 's1', line: '/plan', images: [] }],
      ['file-upload', 'file.upload', { sessionId: 's1', data: 'AAE=', name: 'notes.txt' }],
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
      { namespace: 'commands', method: 'execute', args: { agentId: 's1', line: '/plan', submittedAttachments: [] } },
      { namespace: 'fileUploads', method: 'upload', args: { agentId: 's1', request: { data: 'AAE=', name: 'notes.txt' } } },
      { namespace: 'fileReferences', method: 'list', args: { agentId: 's1', query: 'src' } },
      { namespace: 'sessionReferenceResolver', method: 'candidates', args: { agentId: 's1', query: 'research' } },
      { namespace: 'agentPresets', method: 'select', args: { agentId: 's1', agentPreset: 'coding' } },
      { namespace: 'goals', method: 'create', args: { agentId: 's1', request: { objective: 'ship', maxGoalRounds: 4 } } },
      { namespace: 'goals', method: 'edit', args: { agentId: 's1', ref: { id: 'goal-1', revision: 1 }, request: { objective: 'land' } } },
      { namespace: 'goals', method: 'pause', args: { agentId: 's1', ref: { id: 'goal-1', revision: 2 } } },
    ])
  })

  it('maps the goal state, workspace file, and host hand-off methods', async () => {
    const gateway = useGateway({ value: { activation: 'armed' } })
    for (const [rpcId, method, payload] of [
      ['goal-get', 'goal.get', { sessionId: 's1' }],
      ['feedback-list', 'feedback.list', { sessionId: 's1' }],
      ['feedback-put', 'feedback.put', {
        sessionId: 's1', messageId: 'm1', rating: 'positive', ifVersion: null,
      }],
      ['feedback-delete', 'feedback.delete', { sessionId: 's1', messageId: 'm1', ifVersion: 'v1' }],
      ['file-list-root', 'file.list', { sessionId: 's1' }],
      ['file-list-path', 'file.list', { sessionId: 's1', path: 'src' }],
      ['file-read', 'file.read', { sessionId: 's1', path: 'src/a.ts', offset: 5, limit: 20 }],
      ['file-bytes', 'file.bytes', { sessionId: 's1', path: 'shot.png', length: 1024 }],
      ['file-stat', 'file.stat', { sessionId: 's1', path: 'src/a.ts' }],
      ['file-related', 'file.related', { sessionId: 's1', path: 'docs/readme.md', relativePath: 'img/shot.png' }],
      ['file-reveal', 'file.reveal', { sessionId: 's1', path: 'C:/repo/a.ts' }],
      ['host-open', 'host.openPath', { path: 'C:/repo/a.ts' }],
      ['workspace-unarchive', 'workspace.unarchiveSession', { sessionId: 's1' }],
    ] as const) {
      const msg = makeMsg(`${PREFIX}${method}`, { type: 'client-request', rpcId, method, payload }, validToken)
      await drive(msg)
      expect(replyJson(msg).result.ok).toBe(true)
    }
    expect(gateway.calls).toEqual([
      { namespace: 'goals', method: 'get', args: { agentId: 's1' } },
      {
        namespace: 'messageFeedback', method: 'list',
        args: { request: { sessionId: 's1' } },
      },
      {
        namespace: 'messageFeedback', method: 'put',
        args: { request: { sessionId: 's1', messageId: 'm1', rating: 'positive', ifVersion: null } },
      },
      {
        namespace: 'messageFeedback', method: 'delete',
        args: { request: { sessionId: 's1', messageId: 'm1', ifVersion: 'v1' } },
      },
      // The workspace root is `.`: a live host rejects an empty path.
      { namespace: 'workspaceFiles', method: 'list', args: { workspaceFileScopeId: 's1', path: '.' } },
      { namespace: 'workspaceFiles', method: 'list', args: { workspaceFileScopeId: 's1', path: 'src' } },
      {
        namespace: 'workspaceFiles', method: 'read',
        args: { workspaceFileScopeId: 's1', path: 'src/a.ts', range: { offset: 5, limit: 20 } },
      },
      {
        namespace: 'workspaceFiles', method: 'readBytes',
        args: { workspaceFileScopeId: 's1', path: 'shot.png', options: { range: { length: 1024 } } },
      },
      { namespace: 'workspaceFiles', method: 'stat', args: { workspaceFileScopeId: 's1', path: 'src/a.ts' } },
      {
        // dsh 0.1.7 folded `readRelated` into `readBytes` with a base file.
        namespace: 'workspaceFiles', method: 'readBytes',
        args: {
          workspaceFileScopeId: 's1',
          path: 'img/shot.png',
          options: { baseFile: 'docs/readme.md' },
        },
      },
      { namespace: 'session', method: 'openWorkspacePath', args: { request: { path: 'C:/repo/a.ts', action: 'reveal' } } },
      { namespace: 'session', method: 'openWorkspacePath', args: { request: { path: 'C:/repo/a.ts' } } },
      { namespace: 'workspace', method: 'unarchiveSession', args: { request: { sessionId: 's1' } } },
    ])
  })

  it('reports a refused answer so the bridge can retire the App’s stale card', async () => {
    const stale: { eventId: string, result: unknown }[] = []
    useGateway({
      onRespond: async () => false,
      onStaleRespond: (eventId, result) => { stale.push({ eventId, result }) },
    })
    const msg = makeMsg(`${PREFIX}respond`, {
      type: 'client-response',
      rpcId: 'event-9',
      result: { ok: true, value: { sessionId: 's1', approvalId: 'event-9', outcome: 'allowed-once' } },
    }, validToken)
    await drive(msg)
    expect(replyJson(msg)).toEqual({ accepted: false, reason: 'not-pending' })
    expect(stale).toEqual([{
      eventId: 'event-9',
      result: { ok: true, value: { sessionId: 's1', approvalId: 'event-9', outcome: 'allowed-once' } },
    }])
  })

  it('arms the job roster of the Session the App opens', async () => {
    const opened: string[] = []
    useGateway({
      stream: [{
        type: 'snapshot', cursor: 1, records: [], hasMore: false, projections: { asOfSeq: 1, values: {} },
      }],
      onSessionOpened: sessionId => { opened.push(sessionId) },
    })
    const msg = makeMsg(`${PREFIX}subagent.history`, {
      type: 'client-request', rpcId: 'open-1', method: 'subagent.history',
      payload: { parentSessionId: 'p1', childSessionId: 'c1', mode: 'continuable', maxMessages: 5 },
    }, validToken)
    await drive(msg)
    // A subagent transcript arms the child's own roster, not the parent's.
    expect(opened).toEqual(['c1'])
  })

  it('derives the subagent catalog from the parent projection on 0.1.7 hosts', async () => {
    const gateway = useGateway({
      invoke: async request => {
        if (request.method === 'projections') {
          return {
            asOfSeq: 4,
            values: {
              subagentCatalog: [
                { id: 'child-1', createdAt: 1, mode: 'continuable', label: 'worker' },
                { id: 'child-2', createdAt: 2, mode: 'unknown' },
              ],
            },
          }
        }
        return {
          items: [
            { sessionId: 'p1', agentAvailable: true, running: true, blank: false, updatedAt: 9 },
            { sessionId: 'child-1', parentSessionId: 'p1', agentAvailable: true, running: true, blank: false, updatedAt: 9 },
            { sessionId: 'child-2', parentSessionId: 'child-1', agentAvailable: false, running: false, blank: false, updatedAt: 9 },
          ],
        }
      },
    })
    const msg = makeMsg(`${PREFIX}subagent.list`, {
      type: 'client-request', rpcId: 'sub-list', method: 'subagent.list', payload: { parentSessionId: 'p1' },
    }, validToken)
    await drive(msg)
    expect(replyJson(msg).result.value).toEqual({
      entries: [
        { kind: 'child', id: 'child-1', mode: 'continuable', label: 'worker', activity: 'running', hasChildren: true },
        { kind: 'child', id: 'child-2', mode: 'one-shot', activity: 'inactive', hasChildren: false },
      ],
      parentAvailable: true,
    })
    expect(gateway.calls.map(call => `${call.namespace}/${call.method}`))
      .toEqual(['session/projections', 'session/list'])
  })

  it('falls back to subagents/list on Hosts that predate the parent projection', async () => {
    const legacyCatalog = {
      entries: [{ kind: 'child', id: 'c1', mode: 'one-shot', activity: 'inactive', hasChildren: false }],
      parentAvailable: false,
    }
    const gateway = useGateway({
      invoke: async request => {
        if (request.namespace === 'session') {
          throw Object.assign(new Error('no active Remote method exports this endpoint'), {
            code: 'gateway/invocation-unavailable',
          })
        }
        return legacyCatalog
      },
      failure: error => ({
        code: (error as { code?: string }).code ?? 'gateway/internal',
        message: String(error),
        details: {},
      }),
    })
    const msg = makeMsg(`${PREFIX}subagent.list`, {
      type: 'client-request', rpcId: 'sub-legacy', method: 'subagent.list', payload: { parentSessionId: 'p1' },
    }, validToken)
    await drive(msg)
    expect(replyJson(msg).result.value).toEqual(legacyCatalog)
    expect(gateway.calls.at(-1)).toEqual({
      namespace: 'subagents', method: 'list', args: { parentSessionId: 'p1' },
    })
  })

  it('base64-encodes the native bytes dsh 0.1.7 returns from a file read', async () => {
    useGateway({
      value: {
        absolutePath: '/repo/shot.png', version: 'v1', bytes: 3, offset: 0,
        data: new Uint8Array([1, 2, 250]), eof: true,
      },
    })
    const msg = makeMsg(`${PREFIX}file.bytes`, {
      type: 'client-request', rpcId: 'bytes-1', method: 'file.bytes',
      payload: { sessionId: 's1', path: 'shot.png', length: 3 },
    }, validToken)
    await drive(msg)
    const reply = replyJson(msg)
    expect(reply.result.ok).toBe(true)
    expect(reply.result.value.data).toBe(Buffer.from([1, 2, 250]).toString('base64'))
    expect(reply.result.value.version).toBe('v1')
  })

  it('retries the pre-0.1.7 readBytes and readRelated shapes when a Host rejects them', async () => {
    const legacy = { absolutePath: '/repo/shot.png', version: 'v1', offset: 0, data: 'AAE=', eof: true }
    const gateway = useGateway({
      invoke: async request => {
        // A Host older than 0.1.7 answers the current shape with a validation
        // failure: the window is top-level, and a related read has its own method.
        if (request.args.options !== undefined) {
          throw Object.assign(new Error('args fields do not match the descriptor'), { code: 'gateway/arguments-invalid' })
        }
        return request.method === 'readRelated' ? legacy : legacy
      },
      failure: error => ({
        code: (error as { code?: string }).code ?? 'gateway/internal',
        message: String(error),
        details: {},
      }),
    })

    const bytes = makeMsg(`${PREFIX}file.bytes`, {
      type: 'client-request', rpcId: 'bytes-legacy', method: 'file.bytes',
      payload: { sessionId: 's1', path: 'shot.png', length: 16 },
    }, validToken)
    await drive(bytes)
    expect(replyJson(bytes).result.ok).toBe(true)

    const related = makeMsg(`${PREFIX}file.related`, {
      type: 'client-request', rpcId: 'related-legacy', method: 'file.related',
      payload: { sessionId: 's1', path: 'docs/readme.md', relativePath: 'img/shot.png' },
    }, validToken)
    await drive(related)
    expect(replyJson(related).result.ok).toBe(true)

    expect(gateway.calls).toEqual([
      {
        namespace: 'workspaceFiles', method: 'readBytes',
        args: { workspaceFileScopeId: 's1', path: 'shot.png', options: { range: { length: 16 } } },
      },
      {
        namespace: 'workspaceFiles', method: 'readBytes',
        args: { workspaceFileScopeId: 's1', path: 'shot.png', range: { length: 16 } },
      },
      {
        namespace: 'workspaceFiles', method: 'readBytes',
        args: { workspaceFileScopeId: 's1', path: 'img/shot.png', options: { baseFile: 'docs/readme.md' } },
      },
      {
        namespace: 'workspaceFiles', method: 'readRelated',
        args: { workspaceFileScopeId: 's1', path: 'docs/readme.md', relativePath: 'img/shot.png' },
      },
    ])
  })

  it('surfaces a real file failure instead of retrying the legacy shape', async () => {
    useGateway({
      invoke: async () => {
        throw Object.assign(new Error('no entry at "gone.png"'), { code: 'workspace-file/not-found' })
      },
      failure: error => ({
        code: (error as { code?: string }).code ?? 'gateway/internal',
        message: String(error),
        details: {},
      }),
    })
    const msg = makeMsg(`${PREFIX}file.bytes`, {
      type: 'client-request', rpcId: 'bytes-missing', method: 'file.bytes',
      payload: { sessionId: 's1', path: 'gone.png', length: 16 },
    }, validToken)
    await drive(msg)
    const reply = replyJson(msg)
    expect(reply.result.ok).toBe(false)
    // `workspace-file/not-found` has no frozen equivalent, so it collapses to
    // the vocabulary's catch-all instead of failing the App's parse outright.
    expect(reply.result.error).toEqual({
      code: 'internal',
      message: 'workspace-file/not-found: Error: no entry at "gone.png"',
      details: {},
    })
  })

  it('keeps a Host failure the frozen vocabulary names, details and all', async () => {
    useGateway({
      invoke: async () => {
        throw Object.assign(new Error('session "child-1" is owned by subagent routing'), {
          code: 'session/agent-busy',
        })
      },
      failure: error => ({
        code: (error as { code?: string }).code ?? 'gateway/internal',
        message: (error as Error).message,
        details: { reason: 'use subagent delivery for this child session' },
      }),
    })
    const msg = makeMsg(`${PREFIX}command.list`, {
      type: 'client-request', rpcId: 'cmds-child', method: 'command.list', payload: { sessionId: 'child-1' },
    }, validToken)
    await drive(msg)
    expect(replyJson(msg).result.error).toEqual({
      code: 'agent-busy',
      message: 'session "child-1" is owned by subagent routing',
      details: { reason: 'use subagent delivery for this child session' },
    })
  })

  it('collapses an unmapped Host failure and still names the original code', async () => {
    useGateway({
      invoke: async () => {
        throw Object.assign(new Error('lookup provider "agent" did not resolve the requested identity'), {
          code: 'gateway/lookup-not-found',
        })
      },
      failure: error => ({
        code: (error as { code?: string }).code ?? 'gateway/internal',
        message: (error as Error).message,
        details: { endpoint: 'commands/list', field: 'agentId' },
      }),
    })
    const msg = makeMsg(`${PREFIX}command.list`, {
      type: 'client-request', rpcId: 'cmds-unknown', method: 'command.list', payload: { sessionId: 's1' },
    }, validToken)
    await drive(msg)
    expect(replyJson(msg).result.error).toEqual({
      code: 'internal',
      message: 'gateway/lookup-not-found: lookup provider "agent" did not resolve the requested identity',
      details: {},
    })
  })

  it('falls back when a mapped code arrives without the details the App requires', async () => {
    // `session/agent-busy` maps to `agent-busy`, whose frozen schema requires a
    // string `reason`; a Host that omitted it must not produce a code the App
    // then rejects as a whole.
    useGateway({
      invoke: async () => {
        throw Object.assign(new Error('busy'), { code: 'session/agent-busy' })
      },
      failure: error => ({
        code: (error as { code?: string }).code ?? 'gateway/internal',
        message: (error as Error).message,
        details: {},
      }),
    })
    const msg = makeMsg(`${PREFIX}command.list`, {
      type: 'client-request', rpcId: 'cmds-no-reason', method: 'command.list', payload: { sessionId: 's1' },
    }, validToken)
    await drive(msg)
    expect(replyJson(msg).result.error).toEqual({
      code: 'internal',
      message: 'session/agent-busy: busy',
      details: {},
    })
  })

  /**
   * The frozen vocabulary as the App's `rpcErrorSchema` declares it
   * (`dsh-mobile/packages/protocol/src/vendor/api/rpc.schema.ts`). Copied, not
   * imported: the App is a separate repository and the two ship
   * independently — `dsh-mobile/scripts/verify-plugin-contract.mjs` is what
   * checks this list against the real schema when both checkouts are present.
   */
  const FROZEN_MOBILE_CODES = [
    'bad-request', 'cancelled', 'session-not-found', 'model-unavailable',
    'session-conflict', 'invalid-time-zone', 'workspace-attach-failed',
    'workspace-not-found', 'workspace-invalid-path', 'workspace-name-conflict',
    'workspace-move-invalid', 'directory-unreadable', 'directory-exists',
    'directory-create-failed', 'directory-picker-unavailable',
    'agent-preset-read-only', 'agent-preset-locked', 'agent-preset-conflict',
    'agent-preset-not-found', 'agent-preset-invalid', 'agent-busy',
    'attachment-error', 'queue-item-not-found', 'steer-unavailable',
    'command-error', 'unknown-command', 'settings-rejected', 'settings-conflict',
    'credential-rejected', 'model-discovery-failed', 'title-invalid',
    'fork-unavailable', 'subagent-parent-unavailable', 'subagent-not-found',
    'subagent-catalog-diagnostic', 'subagent-not-resumable',
    'subagent-unauthorized', 'subagent-delivery-unavailable', 'internal',
  ]

  it('maps every Host code it names onto a code the App can parse', () => {
    const frozen = new Set(FROZEN_MOBILE_CODES)
    expect(FROZEN_MOBILE_CODES).toHaveLength(39)
    expect(Object.keys(MOBILE_ERROR_FIELDS).sort()).toEqual([...FROZEN_MOBILE_CODES].sort())
    for (const [host, code] of Object.entries(MOBILE_ERROR_CODES)) {
      expect(frozen.has(code), `${host} -> ${code}`).toBe(true)
    }
  })

  it('arms the workspace file watch through the bridge hook', async () => {
    const watched: { sessionId: string, path: string | undefined }[] = []
    useGateway({ onFileWatch: (sessionId, path) => { watched.push({ sessionId, path }) } })
    const msg = makeMsg(`${PREFIX}file.watch`, {
      type: 'client-request', rpcId: 'watch-1', method: 'file.watch', payload: { sessionId: 's1', path: 'src' },
    }, validToken)
    await drive(msg)
    expect(replyJson(msg).result.value).toEqual({ watching: true })
    expect(watched).toEqual([{ sessionId: 's1', path: 'src' }])
  })

  it('refuses the workspace file watch when no watcher is wired', async () => {
    useGateway({})
    const msg = makeMsg(`${PREFIX}file.watch`, {
      type: 'client-request', rpcId: 'watch-2', method: 'file.watch', payload: { sessionId: 's1' },
    }, validToken)
    await drive(msg)
    expect(replyJson(msg).result.ok).toBe(false)
    expect(replyJson(msg).result.error.message).toBe('mobile-forbidden')
  })

  it('releases the workspace file watch without failing a closing browser', async () => {
    const released: string[] = []
    useGateway({ onFileUnwatch: sessionId => { released.push(sessionId) } })
    let msg = makeMsg(`${PREFIX}file.unwatch`, {
      type: 'client-request', rpcId: 'unwatch-1', method: 'file.unwatch', payload: { sessionId: 's1' },
    }, validToken)
    await drive(msg)
    expect(replyJson(msg).result.value).toEqual({ watching: false })
    expect(released).toEqual(['s1'])

    // No hook and no session id are both non-errors: releasing is best-effort.
    msg = makeMsg(`${PREFIX}file.unwatch`, {
      type: 'client-request', rpcId: 'unwatch-2', method: 'file.unwatch', payload: {},
    }, validToken)
    await drive(msg)
    expect(replyJson(msg).result.ok).toBe(true)
    expect(released).toEqual(['s1'])
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

  it('trims a history page to what one publish carries, keeping the newest records', async () => {
    // The Hub serves `max_payload: 1 MiB` and the client refuses anything
    // larger, so a Session whose window exceeds it could never be opened at
    // all: the App's read failed and the transcript stayed empty.
    const records = Array.from({ length: 12 }, (_, index) => ({
      type: 'event',
      event: { type: 'assistant/message', seq: index + 1, time: index, data: { text: 'x'.repeat(600) } },
    }))
    useGateway({
      maxPayload: 4096,
      stream: [{ type: 'snapshot', cursor: 12, records, hasMore: false, projections: { asOfSeq: 12, values: {} } }],
      value: { records, hasMore: true },
    })
    const tail = makeMsg(`${PREFIX}session.history`, {
      type: 'client-request', rpcId: 'trim-tail', method: 'session.history',
      payload: { sessionId: 's1', maxMessages: 120 },
    }, validToken)
    await drive(tail)
    const reply = replyJson(tail)
    expect(reply.result.ok).toBe(true)
    const seqs = reply.result.value.events.map((entry: any) => entry.event.seq)
    expect(seqs.length).toBeGreaterThan(0)
    expect(seqs.length).toBeLessThan(records.length)
    expect(seqs).toEqual(
      records.slice(records.length - seqs.length).map(record => record.event.seq),
    )
    // Dropped records are still reachable, so the page must say there are more.
    expect(reply.result.value.hasMore).toBe(true)
    expect(tail.replies[0]!.length).toBeLessThanOrEqual(4096)

    const page = makeMsg(`${PREFIX}session.history`, {
      type: 'client-request', rpcId: 'trim-page', method: 'session.history',
      payload: { sessionId: 's1', beforeSeq: 12, maxMessages: 120 },
    }, validToken)
    await drive(page)
    const pageReply = replyJson(page)
    expect(pageReply.result.value.events.length).toBe(seqs.length)
    expect(pageReply.result.value.events.at(-1).event.seq).toBe(12)
    expect(pageReply.result.value.hasMore).toBe(true)
    expect(page.replies[0]!.length).toBeLessThanOrEqual(4096)
  })

  it('caps a single record too large for one publish instead of dropping it', async () => {
    // There is no window smaller than one record to ask for, so a record this
    // big has to arrive short: dropping it (or failing the page) would strand
    // every older page behind it.
    const huge = 'x'.repeat(6000)
    useGateway({
      maxPayload: 4096,
      stream: [{
        type: 'snapshot', cursor: 1, hasMore: false,
        records: [{ type: 'event', event: { type: 'tool/result', seq: 1, time: 0, data: { text: huge } } }],
      }],
    })
    const msg = makeMsg(`${PREFIX}session.history`, {
      type: 'client-request', rpcId: 'capped', method: 'session.history',
      payload: { sessionId: 's1', maxMessages: 120 },
    }, validToken)
    await drive(msg)
    const reply = replyJson(msg)
    expect(reply.result.ok).toBe(true)
    const events = reply.result.value.events
    expect(events).toHaveLength(1)
    // Shape survives the cap: same type, same seq, only the long string is cut.
    expect(events[0].event.type).toBe('tool/result')
    expect(events[0].event.seq).toBe(1)
    expect(events[0].event.data.text).toContain('已截断')
    expect(events[0].event.data.text.length).toBeLessThan(huge.length)
    // Nothing older is left behind, so the page must not claim there is.
    expect(reply.result.value.hasMore).toBe(false)
    expect(msg.replies[0]!.length).toBeLessThanOrEqual(4096)
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

  it('hello carries the device name the app states, so a phone can rename itself', async () => {
    const msg = makeMsg(`${PREFIX}hello`, {
      type: 'client-request', rpcId: 'r7b', method: 'hello',
      payload: { deviceName: 'Pixel 8 · Android 16' },
    }, validToken)
    await drive(msg)
    expect(helloArgs?.deviceName).toBe('Pixel 8 · Android 16')
    // The id has to be the caller, otherwise the rename would land on whatever
    // device the bridge happened to see last.
    expect(helloArgs?.deviceId).toBe(tokens.list().find(device => device.name === 'test-phone')?.id)
  })

  it('hello without a device name leaves the stored one alone', async () => {
    const msg = makeMsg(`${PREFIX}hello`, { type: 'client-request', rpcId: 'r7c', method: 'hello', payload: {} }, validToken)
    await drive(msg)
    expect(helloCount).toBe(1)
    expect(helloArgs?.deviceName).toBeUndefined()
  })

  it('hello records the event key and installation id and returns the gateway identity', async () => {
    const installationId = '0e4d8614-fef3-4e31-82ec-b442974c0956'
    const msg = makeMsg(`${PREFIX}hello`, {
      type: 'client-request', rpcId: 'r7d', method: 'hello',
      payload: { deviceName: 'Pixel 8', eventKey, installationId },
    }, validToken)
    await drive(msg)

    expect(replyJson(msg).result.value).toEqual({
      ok: true,
      gatewayId: GATEWAY_ID,
      gatewayName: 'test-mac',
    })
    expect(tokens.hasLegacyActiveDevices()).toBe(false)
    expect(tokens.list()[0]).toMatchObject({
      name: 'test-phone',
      installationId,
      eventCapable: true,
    })
  })

  it('serves the plugin compatibility manifest after token auth', async () => {
    const msg = makeMsg(`${PREFIX}mobile.info`, { type: 'client-request', rpcId: 'r-info', method: 'mobile.info', payload: {} }, validToken)
    await drive(msg)
    const reply = replyJson(msg)
    expect(reply.result.value).toEqual({
      pluginVersion: '0.2.38',
      mobileApi: 2,
      features: [
        'plus-menu', 'command-directory', 'multi-image', 'durable-attachment-order',
        'plugin-inventory', 'health-check', 'typert-remote-v2', 'session-history-pages',
        'session-control', 'workspace-follow', 'remote-event-results', 'reference-candidates', 'file-uploads',
        'workspace-files', 'workspace-watch', 'workspace-stat', 'message-feedback', 'workspace-unarchive', 'goal-state', 'open-path',
        'permission-presets',
      ],
      instanceName: 'test-mac',
      gatewayId: GATEWAY_ID,
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
