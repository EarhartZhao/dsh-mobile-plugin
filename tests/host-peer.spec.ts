import { describe, expect, it, vi } from 'vitest'
import { withHostPeer, type HostPeer } from '../src/host-peer.js'

/** The structural Peer the wrapper only reads. */
const peer: HostPeer = {
  id: 'peer-1',
  ctx: {} as HostPeer['ctx'],
  principal: { kind: 'owner' },
  signal: new AbortController().signal,
  interactions: 'answer',
  dispose: () => Promise.resolve(),
}

describe('withHostPeer', () => {
  it('names the peer on unary and stream calls', async () => {
    const invoke = vi.fn().mockResolvedValue('invoked')
    const stream = vi.fn().mockResolvedValue([])
    const gateway = withHostPeer({ invoke, stream }, peer)

    await gateway.invoke({ namespace: 'session', method: 'list', args: {} })
    await gateway.stream({ namespace: 'session', method: 'follow', args: {} })

    expect(invoke).toHaveBeenCalledWith({ namespace: 'session', method: 'list', args: {}, peer })
    expect(stream).toHaveBeenCalledWith({ namespace: 'session', method: 'follow', args: {}, peer })
  })

  it('fills the carrier open peer slot and keeps the three-argument shape', async () => {
    // dsh 0.2.1 asserts the Peer inside `wireStream.open`; an unfilled slot took
    // the `$events` pump down (and approvals, questions and forwarded events with it).
    const open = vi.fn().mockResolvedValue([])
    const wireStream = { open, failure: vi.fn() }
    const gateway = withHostPeer({ invoke: vi.fn(), stream: vi.fn(), wireStream }, peer)
    const signal = new AbortController().signal
    const uplink = (async function* () { /* no items */ })()

    await gateway.wireStream.open('$events', { args: {} }, uplink, undefined, signal)
    expect(open).toHaveBeenLastCalledWith('$events', { args: {} }, uplink, peer, signal)

    // Hosts before 0.1.7 pass their signal third and must not be shifted.
    await gateway.wireStream.open('$events', { args: {} }, signal)
    expect(open).toHaveBeenLastCalledWith('$events', { args: {} }, signal)

    // `openEventStream` reads this arity to pick a call shape.
    expect(gateway.wireStream.open).toHaveLength(5)
  })
})
