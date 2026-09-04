import { describe, expect, it } from 'vitest'
import { EventBridge, GatewayEventAdapter, type EventStreams, type StreamFrame } from '../src/events.js'

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
        },
      },
    }))
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
