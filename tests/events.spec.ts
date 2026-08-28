import { describe, expect, it } from 'vitest'
import { EventBridge, type EventStreams, type StreamFrame } from '../src/events.js'

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
