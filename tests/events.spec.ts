import { describe, expect, it } from 'vitest'
import { EventBridge, GatewayEventAdapter, openEventStream, type EventStreams, type StreamFrame } from '../src/events.js'

function fakeNc() {
  const published: { subject: string, body: string }[] = []
  return {
    published,
    publish(subject: string, body: string) { published.push({ subject, body }) },
  }
}

function frame(rpcId: string, payload: StreamFrame['payload']): StreamFrame {
  return { rpcId, payload }
}

async function* toStream(frames: StreamFrame[], signal: AbortSignal): AsyncIterable<StreamFrame> {
  for (const f of frames) {
    if (signal.aborted) return
    yield f
  }
  // Keep the stream open like the real one until aborted.
  await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve()) })
}

function fakeApi(muxFrames: StreamFrame[], hostFrames: StreamFrame[] = []): EventStreams {
  return {
    events: {
      mux: (_req, signal) => toStream(muxFrames, signal),
      host: (_req, signal) => toStream(hostFrames, signal),
    },
  }
}

async function* objectStream(values: unknown[], signal: AbortSignal): AsyncIterable<unknown> {
  for (const value of values) {
    if (signal.aborted) return
    yield value
  }
  await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
}

async function take(
  iterator: AsyncIterator<StreamFrame>,
  count: number,
): Promise<StreamFrame[]> {
  const frames: StreamFrame[] = []
  while (frames.length < count) {
    const next = await iterator.next()
    if (next.done) break
    frames.push(next.value)
  }
  return frames
}

describe('openEventStream', () => {
  it('passes the 0.1.7 uplink and peer ahead of the signal', async () => {
    const controller = new AbortController()
    const calls: unknown[][] = []
    const stream = await openEventStream({
      // Exactly the arity the 0.1.7 Gateway publishes.
      open: (endpoint: never, payload: never, uplink: never, peer: never, signal: never) => {
        calls.push([endpoint, payload, uplink, peer, signal])
        return Promise.resolve(objectStream([], controller.signal))
      },
    }, controller.signal)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.slice(0, 2)).toEqual(['$events', { args: {} }])
    expect(calls[0]?.[3]).toBeUndefined()
    expect(calls[0]?.[4]).toBe(controller.signal)
    // The Gateway releases a Gateway-owned stream's uplink immediately, so the
    // iterable handed over must already be finished instead of throwing.
    const uplink = calls[0]?.[2] as AsyncIterable<unknown>
    await expect(uplink[Symbol.asyncIterator]().next()).resolves.toEqual({ value: undefined, done: true })
    expect(stream).toBeDefined()
  })

  it('keeps the legacy three-argument call for older Hosts', async () => {
    const controller = new AbortController()
    const calls: unknown[][] = []
    await openEventStream({
      open(endpoint: never, payload: never, signal: never): Promise<AsyncIterable<unknown>> {
        calls.push([endpoint, payload, signal])
        return Promise.resolve(objectStream([], controller.signal))
      },
    }, controller.signal)
    expect(calls).toEqual([['$events', { args: {} }, controller.signal]])
  })
})

describe('EventBridge', () => {
  it('publishes frames with the ServerRequest envelope', async () => {
    const nc = fakeNc()
    const bridge = new EventBridge(nc as never, fakeApi([
      frame('f1', { type: 'session/event', sessionId: 's1', event: { type: 'turn/start' } }),
    ]), { instanceId: 'test', coalesceMs: 0 })
    bridge.start()
    await new Promise(r => setTimeout(r, 20))
    await bridge.stop()

    expect(nc.published).toHaveLength(1)
    expect(nc.published[0].subject).toBe('evt.dsh.test.mux')
    const envelope = JSON.parse(nc.published[0].body)
    expect(envelope.type).toBe('server-request')
    expect(envelope.rpcId).toBe('f1')
    expect(envelope.method).toBe('session/event')
    expect(envelope.payload.sessionId).toBe('s1')
  })

  it('tracks pending approvals and replays them, clearing on resolve', async () => {
    const nc = fakeNc()
    const bridge = new EventBridge(nc as never, fakeApi([
      frame('a1', { type: 'approval/requested', sessionId: 's1', approvalId: 'ap1', toolName: 'bash' }),
      frame('a2', { type: 'approval/requested', sessionId: 's1', approvalId: 'ap2', toolName: 'bash' }),
      frame('a3', { type: 'approval/resolved', sessionId: 's1', approvalId: 'ap1', outcome: 'approved' }),
    ]), { instanceId: 'test', coalesceMs: 0 })
    bridge.start()
    await new Promise(r => setTimeout(r, 20))

    nc.published.length = 0
    bridge.replayPending()
    expect(nc.published).toHaveLength(1)
    expect(JSON.parse(nc.published[0].body).rpcId).toBe('a2')
    await bridge.stop()
  })

  it('clears pending questions on question/resolved', async () => {
    const nc = fakeNc()
    const bridge = new EventBridge(nc as never, fakeApi([
      frame('q1', { type: 'question/requested', sessionId: 's1', questions: [] }),
      frame('q2', { type: 'question/resolved', sessionId: 's1', questionRpcId: 'q1', outcome: 'answered' }),
    ]), { instanceId: 'test', coalesceMs: 0 })
    bridge.start()
    await new Promise(r => setTimeout(r, 20))

    nc.published.length = 0
    bridge.replayPending()
    expect(nc.published).toHaveLength(0)
    await bridge.stop()
  })

  it('coalesces projection frames to latest-per-key within the window', async () => {
    const nc = fakeNc()
    const bridge = new EventBridge(nc as never, fakeApi([
      frame('p1', { type: 'session/projection', sessionId: 's1', key: 'title', value: 'a', seq: 1 }),
      frame('p2', { type: 'session/projection', sessionId: 's1', key: 'title', value: 'b', seq: 2 }),
      frame('p3', { type: 'session/event', sessionId: 's1', event: { type: 'turn/start' } }),
    ]), { instanceId: 'test', coalesceMs: 30 })
    bridge.start()
    await new Promise(r => setTimeout(r, 80))
    await bridge.stop()

    const projections = nc.published.filter(p => JSON.parse(p.body).method === 'session/projection')
    const others = nc.published.filter(p => JSON.parse(p.body).method !== 'session/projection')
    expect(projections).toHaveLength(1)
    expect(JSON.parse(projections[0].body).rpcId).toBe('p2')
    expect(others).toHaveLength(1)
  })
})

describe('GatewayEventAdapter', () => {
  it('adapts answerable events and settles them through $events/result', async () => {
    const requests: Request[] = []
    const controller = new AbortController()
    const adapter = new GatewayEventAdapter({
      wireStream: {
        open: async (_endpoint, _payload, signal) => objectStream([
          { type: 'ready', clientId: 'client-1', host: { home: '/home/test' } },
          {
            type: 'waterfall', event: 'approval/request', eventId: 'event-1', agentId: 'session-1',
            request: { toolName: 'bash', callId: 'call-1', reason: 'needs access' },
          },
        ], signal),
      },
      stream: async ({ namespace, method, signal = controller.signal }) => {
        expect([namespace, method]).toEqual(['session', 'control'])
        return objectStream([], signal)
      },
    }, {
      fetch: async (request) => {
        requests.push(request)
        const body = await request.clone().json() as { rpcId: string }
        return new Response(JSON.stringify({
          type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: undefined },
        }), { headers: { 'content-type': 'application/json' } })
      },
    })

    const iterator = adapter.events.mux({ rpcId: 'mux' }, controller.signal)[Symbol.asyncIterator]()
    const [approval] = await take(iterator, 1)
    expect(approval.payload).toEqual({
      type: 'approval/requested', sessionId: 'session-1', approvalId: 'event-1',
      toolName: 'bash', callId: 'call-1', reason: 'needs access',
    })

    await expect(adapter.respond('event-1', {
      ok: true, value: { outcome: 'allowed-once' },
    })).resolves.toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('http://mobile.internal/api/$events/result')
    await expect(requests[0].clone().json()).resolves.toMatchObject({
      method: '$events/result',
      payload: {
        args: {
          clientId: 'client-1', eventId: 'event-1',
          outcome: { kind: 'result', value: 'allowed-once' },
        },
      },
    })
    controller.abort()
    await iterator.return?.()
  })

  it('projects control baseline and incremental queue, jobs, and projections', async () => {
    const controller = new AbortController()
    const adapter = new GatewayEventAdapter({
      wireStream: { open: async (_endpoint, _payload, signal) => objectStream([], signal) },
      stream: async ({ namespace, method, signal = controller.signal }) => {
        expect([namespace, method]).toEqual(['session', 'control'])
        return objectStream([
          {
            type: 'baseline', value: {
              queues: { s1: [{ id: 'q1', placement: 'followup', message: { content: [{ type: 'text', text: 'queued' }] } }] },
              jobs: { s1: [{ id: 'job-1' }] },
              projections: { s1: { asOfSeq: 4, values: { title: 'First title' } } },
            },
          },
          { type: 'queue', sessionId: 's1', items: [] },
          { type: 'jobs', sessionId: 's1', jobs: [] },
          { type: 'projection', sessionId: 's1', key: 'title', value: 'New title', seq: 5 },
        ], signal)
      },
    })

    const iterator = adapter.events.mux({ rpcId: 'mux' }, controller.signal)[Symbol.asyncIterator]()
    const frames = await take(iterator, 6)
    expect(frames.map(frame => frame.payload.type)).toEqual([
      'session/queue', 'session/jobs', 'session/projection',
      'session/queue', 'session/jobs', 'session/projection',
    ])
    expect(frames[0].payload.items).toEqual([{
      id: 'q1', placement: 'followup',
      message: {
        id: 'q1', role: 'user', content: [{ type: 'text', text: 'queued' }],
        source: { kind: 'user' },
      },
    }])
    expect(frames.at(-1)?.payload).toMatchObject({ key: 'title', value: 'New title', seq: 5 })
    controller.abort()
    await iterator.return?.()
  })

  it('derives legacy queue frames from the inbox projection (0.1.6-alpha.2+)', async () => {
    const controller = new AbortController()
    const adapter = new GatewayEventAdapter({
      wireStream: { open: async (_endpoint, _payload, signal) => objectStream([], signal) },
      stream: async ({ namespace, method, signal = controller.signal }) => {
        expect([namespace, method]).toEqual(['session', 'control'])
        return objectStream([
          {
            type: 'baseline',
            value: {
              jobs: {},
              projections: {
                s1: {
                  asOfSeq: 7,
                  values: {
                    inbox: {
                      'next-turn': [{ id: 'm1', content: [{ type: 'text', text: 'queued turn' }], source: { kind: 'user', rpcId: 'r1' } }],
                      'next-step': [
                        { id: 'm2', content: [{ type: 'text', text: 'steer' }], source: { kind: 'user' } },
                        { id: 'm3', content: [{ type: 'text', text: 'injected' }], source: { kind: 'plugin' } },
                      ],
                    },
                  },
                },
              },
            },
          },
        ], signal)
      },
    })

    const iterator = adapter.events.mux({ rpcId: 'mux' }, controller.signal)[Symbol.asyncIterator]()
    const frames = await take(iterator, 2)
    const queueFrame = frames[0]
    expect(queueFrame.payload).toMatchObject({ type: 'session/queue', sessionId: 's1' })
    expect(queueFrame.payload.items).toEqual([
      {
        id: 'm1', placement: 'queued',
        message: {
          id: 'm1', role: 'user', content: [{ type: 'text', text: 'queued turn' }],
          source: { kind: 'user', rpcId: 'r1' },
        },
      },
      {
        id: 'm2', placement: 'steering',
        message: {
          id: 'm2', role: 'user', content: [{ type: 'text', text: 'steer' }],
          source: { kind: 'user' },
        },
      },
      {
        id: 'm3', placement: 'context',
        message: {
          id: 'm3', role: 'user', content: [{ type: 'text', text: 'injected' }],
          source: { kind: 'user' },
        },
      },
    ])
    expect(frames[1].payload).toMatchObject({ type: 'session/projection', key: 'inbox', seq: 7 })
    controller.abort()
    await iterator.return?.()
  })

  it('projects workspace follow frames and retains the latest snapshot', async () => {
    const controller = new AbortController()
    const workspace = { workspaceId: 'w1', name: 'One' }
    const renamed = { workspaceId: 'w1', name: 'Renamed' }
    const adapter = new GatewayEventAdapter({
      wireStream: { open: async (_endpoint, _payload, signal) => objectStream([], signal) },
      stream: async ({ namespace, method, signal = controller.signal }) => {
        expect([namespace, method]).toEqual(['workspace', 'follow'])
        return objectStream([
          { type: 'baseline', value: { items: [workspace], archivedSessionIds: ['old'] } },
          { type: 'upsert', workspace: renamed },
          { type: 'order', workspaceIds: ['w1'] },
          { type: 'archived', archivedSessionIds: ['new'] },
        ], signal)
      },
    })

    const iterator = adapter.events.host({ rpcId: 'host' }, controller.signal)[Symbol.asyncIterator]()
    const frames = await take(iterator, 5)
    expect(frames.map(frame => frame.payload.type)).toEqual([
      'host/workspace-changed', 'host/archived-sessions-changed',
      'host/workspace-changed', 'host/workspace-order-changed',
      'host/archived-sessions-changed',
    ])
    await expect(adapter.workspaceSnapshot()).resolves.toEqual({ items: [renamed], archivedSessionIds: ['new'] })
    controller.abort()
    await iterator.return?.()
  })

  it('follows the 0.1.7 job roster and republishes it as session/jobs frames', async () => {
    const controller = new AbortController()
    const calls: { namespace: string, method: string, args: Record<string, unknown> }[] = []
    const adapter = new GatewayEventAdapter({
      wireStream: { open: async (_endpoint, _payload, signal) => objectStream([], signal) },
      invoke: async () => ({ items: [] }),
      stream: async (request) => {
        calls.push({ namespace: request.namespace, method: request.method, args: request.args })
        const signal = request.signal ?? controller.signal
        if (request.namespace === 'job') {
          return objectStream([
            {
              type: 'rows',
              jobs: [{
                id: 'bash-1', kind: 'bash', label: 'npm test', status: 'running', startedAt: 5,
                owner: 's1', progress: '2/3', output: { total: 0, earliest: 0, spillPaths: ['C:/tmp/spill'] },
              }],
            },
            { type: 'rows', jobs: [] },
          ], signal)
        }
        return objectStream([], signal)
      },
    })
    // The bridge arms this when the App opens a transcript, not for every row
    // a session list mentions: each roster is a live Host stream.
    adapter.watchJobs('s1')

    const iterator = adapter.events.mux({ rpcId: 'mux' }, controller.signal)[Symbol.asyncIterator]()
    const frames = await take(iterator, 2)
    expect(calls).toContainEqual({
      namespace: 'job', method: 'list', args: { request: { sessionId: 's1' } },
    })
    // Registry internals (owner, progress, output, spill paths) stay on the Host.
    expect(frames.map(frame => frame.payload)).toEqual([
      {
        type: 'session/jobs', sessionId: 's1',
        jobs: [{ id: 'bash-1', kind: 'bash', label: 'npm test', status: 'running', startedAt: 5 }],
      },
      { type: 'session/jobs', sessionId: 's1', jobs: [] },
    ])

    // A reconnecting App starts from an empty store and would otherwise see no
    // roster until a job changed.
    adapter.replayJobs()
    const replayed = await take(iterator, 1)
    expect(replayed[0]?.payload).toEqual({ type: 'session/jobs', sessionId: 's1', jobs: [] })
    controller.abort()
    await iterator.return?.()
  })

  it('forwards workspace file observations as host remote events', async () => {
    const controller = new AbortController()
    const calls: { namespace: string; method: string; args: Record<string, unknown> }[] = []
    const adapter = new GatewayEventAdapter({
      wireStream: { open: async (_endpoint, _payload, signal) => objectStream([], signal) },
      invoke: async () => ({ items: [{ sessionId: 's1', cwd: '/repo' }] }),
      stream: async (request) => {
        calls.push({ namespace: request.namespace, method: request.method, args: request.args })
        if (request.namespace === 'workspaceFiles') {
          return objectStream([
            { kind: 'ready' },
            { kind: 'change', change: { absolutePath: '/repo/out.txt', version: 'v2' } },
            { kind: 'change', change: { absolutePath: '/repo/gone.txt', absent: true } },
          ], request.signal ?? controller.signal)
        }
        return objectStream([], request.signal ?? controller.signal)
      },
    })
    adapter.watchFiles('s1')

    const iterator = adapter.events.host({ rpcId: 'host' }, controller.signal)[Symbol.asyncIterator]()
    const frames = await take(iterator, 3)
    // dsh 0.1.7 watches one target: the root the App armed is spelled `.`.
    expect(calls).toContainEqual({
      namespace: 'workspaceFiles', method: 'changes', args: { workspaceFileScopeId: 's1', path: '.' },
    })
    expect(frames.map(frame => frame.payload)).toEqual([
      { type: 'host/remote-event', event: 'workspace-files/ready', args: [{ sessionId: 's1' }] },
      {
        type: 'host/remote-event', event: 'workspace-files/change',
        args: [{ sessionId: 's1', absolutePath: '/repo/out.txt', version: 'v2', path: 'out.txt' }],
      },
      {
        type: 'host/remote-event', event: 'workspace-files/change',
        args: [{ sessionId: 's1', absolutePath: '/repo/gone.txt', absent: true, path: 'gone.txt' }],
      },
    ])
    controller.abort()
    await iterator.return?.()
  })

  it('retires a held approval or question the current generation no longer tracks', async () => {
    const controller = new AbortController()
    const adapter = new GatewayEventAdapter({
      wireStream: { open: async (_endpoint, _payload, signal) => objectStream([], signal) },
      invoke: async () => ({ items: [] }),
      stream: async ({ signal = controller.signal }) => objectStream([], signal),
    })
    const iterator = adapter.events.mux({ rpcId: 'mux' }, controller.signal)[Symbol.asyncIterator]()
    // Consuming first installs the mux sink the resolutions ride.
    const pending = take(iterator, 2)
    await new Promise(resolve => setTimeout(resolve, 10))

    adapter.resolveStale('event-1', { ok: true, value: { sessionId: 's1', approvalId: 'event-1', outcome: 'allowed-once' } })
    adapter.resolveStale('event-2', { ok: true, value: { sessionId: 's1', answer: { selected: [] } } })
    // A cancel carries no value, so nothing can be attributed to a Session.
    adapter.resolveStale('event-3', { ok: false, error: { code: 'cancelled', message: 'cancelled' } })

    const frames = await pending
    expect(frames.map(frame => frame.payload)).toEqual([
      { type: 'approval/resolved', sessionId: 's1', approvalId: 'event-1', outcome: 'cancelled' },
      { type: 'question/resolved', sessionId: 's1', questionRpcId: 'event-2', outcome: 'cancelled' },
    ])
    controller.abort()
    await iterator.return?.()
  })

  it('relays the plugin-manager events the host forwards from 0.1.6-alpha.2', async () => {
    const controller = new AbortController()
    const adapter = new GatewayEventAdapter({
      wireStream: {
        open: async (_endpoint, _payload, signal) => objectStream([
          { type: 'ready', clientId: 'client-1' },
          { type: 'emit', event: 'plugin-manager/changed', args: [{ entryId: 'dsh-mobile-plugin', enabled: false }] },
          { type: 'emit', event: 'plugin-manager/install-state', args: [{ entryId: 'dsh-mobile-plugin', state: 'installing' }] },
        ], signal),
      },
      invoke: async () => ({ items: [] }),
      stream: async ({ signal = controller.signal }) => objectStream([], signal),
    })

    const mux = adapter.events.mux({ rpcId: 'mux' }, controller.signal)[Symbol.asyncIterator]()
    const host = adapter.events.host({ rpcId: 'host' }, controller.signal)[Symbol.asyncIterator]()
    // The `$events` pump belongs to the mux body, so the host stream only sees
    // relayed events once the mux generation has started.
    const primed = mux.next()
    const frames = await take(host, 2)
    expect(frames.map(frame => frame.payload)).toEqual([
      {
        type: 'host/remote-event', event: 'plugin-manager/changed',
        args: [{ entryId: 'dsh-mobile-plugin', enabled: false }],
      },
      {
        type: 'host/remote-event', event: 'plugin-manager/install-state',
        args: [{ entryId: 'dsh-mobile-plugin', state: 'installing' }],
      },
    ])
    controller.abort()
    await primed
    await mux.return?.()
    await host.return?.()
  })

  it('caps concurrent file watches and releases the least recent', async () => {
    const controller = new AbortController()
    const signals = new Map<string, AbortSignal>()
    const adapter = new GatewayEventAdapter({
      wireStream: { open: async (_endpoint, _payload, signal) => objectStream([], signal) },
      invoke: async () => ({ items: [] }),
      stream: async (request) => {
        const scope = request.args['workspaceFileScopeId']
        const signal = request.signal ?? controller.signal
        if (request.namespace === 'workspaceFiles' && typeof scope === 'string') signals.set(scope, signal)
        return objectStream([], signal)
      },
    })
    const iterator = adapter.events.host({ rpcId: 'host' }, controller.signal)[Symbol.asyncIterator]()
    // Prime the generator: the host sinks (and therefore the watch seats) only
    // exist once the stream body starts running.
    const primed = iterator.next()
    await new Promise(resolve => setTimeout(resolve, 0))

    for (const sessionId of ['s1', 's2', 's3', 's4', 's5']) adapter.watchFiles(sessionId)
    await new Promise(resolve => setTimeout(resolve, 0))
    const active = ['s1', 's2', 's3', 's4', 's5']
      .filter(sessionId => signals.get(sessionId)?.aborted === false)
    // Five watches, a cap of four: the oldest is released, the rest stay live.
    expect(active).toEqual(['s2', 's3', 's4', 's5'])

    adapter.unwatchFiles('s5')
    expect(signals.get('s5')?.aborted).toBe(true)
    expect(['s2', 's3', 's4'].filter(sessionId => signals.get(sessionId)?.aborted === false))
      .toEqual(['s2', 's3', 's4'])

    controller.abort()
    await primed
    await iterator.return?.()
  })

  it('follows the complete subagent address after history opens it', async () => {
    const controller = new AbortController()
    const calls: unknown[] = []
    const adapter = new GatewayEventAdapter({
      wireStream: { open: async (_endpoint, _payload, signal) => objectStream([], signal) },
      stream: async (request) => {
        calls.push(request)
        if (request.namespace === 'session' && request.method === 'control') {
          return objectStream([], request.signal ?? controller.signal)
        }
        return objectStream([{ type: 'snapshot', cursor: 7 }], request.signal ?? controller.signal)
      },
    })
    adapter.watchSession({
      kind: 'subagent', parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'continuable',
    })

    const iterator = adapter.events.mux({ rpcId: 'mux' }, controller.signal)[Symbol.asyncIterator]()
    const [subscribed] = await take(iterator, 1)
    expect(subscribed.payload).toMatchObject({ type: 'session/subscribed', sessionId: 'child-1', lastSeq: 7 })
    expect(calls).toContainEqual(expect.objectContaining({
      namespace: 'session', method: 'follow',
      args: {
        request: {
          address: {
            kind: 'subagent', parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'continuable',
          },
          maxMessages: 1,
          assistantStream: true,
        },
      },
    }))
    controller.abort()
    await iterator.return?.()
  })

  it('replays compact assistant baseline and follows live assistant frames', async () => {
    const controller = new AbortController()
    const adapter = new GatewayEventAdapter({
      wireStream: { open: async (_endpoint, _payload, signal) => objectStream([], signal) },
      stream: async (request) => {
        if (request.namespace === 'session' && request.method === 'control') {
          return (async function* (): AsyncIterable<unknown> {
            await new Promise<void>(resolve => (request.signal ?? controller.signal).addEventListener('abort', () => resolve(), { once: true }))
          })()
        }
        return objectStream([
          {
            type: 'snapshot', cursor: 9,
            assistantStream: {
              revision: 3,
              activeAttempt: {
                attemptId: 'attempt-1', turn: 2, step: 1, nextIndex: 4,
                stream: [
                  { type: 'text-chunks', time0: 10, index: 0, dt: [2], texts: ['ab', 'cd'] },
                  { type: 'reasoning-chunks', time0: 20, index: 0, dt: [], texts: ['why'] },
                  { type: 'tool-call-chunks', time0: 30, index: 1, dt: [], id: 'call-1', name: 'search', args: ['{"q":'] },
                ],
              },
            },
          },
          { type: 'assistant-stream', frame: { type: 'start', attemptId: 'attempt-2', revision: 1, turn: 3, step: 1, startedAfterSeq: 9 } },
          { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'attempt-2', revision: 2, index: 0, time: 40, chunk: { type: 'text-delta', index: 0, text: 'live' } } },
          { type: 'assistant-stream', frame: { type: 'end', attemptId: 'attempt-2', revision: 3, index: 1, outcome: { kind: 'abandoned' } } },
        ], request.signal ?? controller.signal)
      },
    })
    adapter.watchSession({ kind: 'session', sessionId: 'session-1' })

    const iterator = adapter.events.mux({ rpcId: 'mux' }, controller.signal)[Symbol.asyncIterator]()
    const frames = await take(iterator, 7)
    expect(frames.map(item => item.payload.type)).toEqual([
      'session/subscribed', 'session/event', 'session/event', 'session/event',
      'session/event', 'session/event', 'session/event',
    ])
    const assistant = frames.slice(1).map(item => item.payload.event as Record<string, unknown>)
    expect(assistant.map(event => (event.data as Record<string, unknown>).index)).toEqual([0, 1, 2, 3, 0, 1])
    expect((assistant[0]?.data as Record<string, unknown>).chunk).toEqual({ type: 'text-delta', index: 0, text: 'ab' })
    expect((assistant[2]?.data as Record<string, unknown>).chunk).toEqual({ type: 'reasoning-delta', index: 0, text: 'why' })
    expect((assistant[3]?.data as Record<string, unknown>).chunk).toMatchObject({ type: 'tool-call-delta', index: 1, id: 'call-1', name: 'search' })
    expect(assistant[5]?.type).toBe('assistant/stream-end')
    controller.abort()
    await iterator.return?.()
  })

  it('reports an upstream stream failure and reopens without rebuilding NATS', async () => {
    const controller = new AbortController()
    const failures: { name: string; error: unknown }[] = []
    const recoveries: string[] = []
    let attempts = 0
    const adapter = new GatewayEventAdapter({
      wireStream: {
        open: async () => {
          attempts += 1
          return attempts === 1
            ? (async function* (): AsyncIterable<unknown> { throw new Error('gateway disconnected') })()
            : objectStream([{ type: 'ready', clientId: 'recovered' }], controller.signal)
        },
      },
      stream: async ({ signal = controller.signal }) => objectStream([], signal),
    }, undefined, (name, error) => failures.push({ name, error }), name => recoveries.push(name), 1)

    const iterator = adapter.events.mux({ rpcId: 'mux' }, controller.signal)[Symbol.asyncIterator]()
    const frame = await iterator.next()
    expect(frame.value?.payload).toEqual({
      type: 'stream/error',
      error: { code: 'internal', message: 'remote events: gateway disconnected', details: {} },
    })
    expect(failures).toHaveLength(1)
    expect(failures[0]?.name).toBe('remote events')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(attempts).toBe(2)
    expect(recoveries).toEqual(['remote events'])
    controller.abort()
    await iterator.return?.()
  })
})
