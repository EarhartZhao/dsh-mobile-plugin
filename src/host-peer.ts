/**
 * dsh 0.2.1 requires every in-process Remote call to name the Peer it speaks
 * for (`InvokeRemoteRequest.peer`); a call without one throws
 * `Cannot read properties of undefined (reading 'signal')` inside the Gateway.
 * The bridge is an owner-side caller, so it speaks for one owner Peer for the
 * whole session and attaches it to every call it makes — unary, stream, and the
 * carrier's direct `wireStream.open` (the `$events` pump).
 *
 * Older hosts have no peer factory and never read the field, so the same call
 * shape is safe on both.
 *
 * @module dsh-mobile-plugin/src/host-peer
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'

/** The structural part of a Host Peer this plugin needs. */
export interface HostPeer {
  readonly id: string
  readonly ctx: Context
  readonly principal: { readonly kind: 'owner' }
  readonly signal: AbortSignal
  readonly interactions: 'answer'
  dispose(): Promise<void>
}

/** `connection.createPeer`, present only from dsh 0.2.1 on. */
interface PeerFactory {
  createPeer?(options: { readonly principal: { readonly kind: 'owner' } }): unknown
}

/**
 * One owner Peer for this bridge, created through the Host when it offers the
 * factory and hand-built for hosts that predate it.
 * @param connection - the Host `connection` service.
 * @param ctx - this plugin's Context, used by the fallback Peer.
 * @returns a Peer valid for the lifetime of the bridge.
 */
export function createHostPeer(connection: unknown, ctx: Context): HostPeer {
  const factory = connection as PeerFactory | undefined
  if (factory !== undefined && typeof factory.createPeer === 'function') {
    return factory.createPeer({ principal: { kind: 'owner' } }) as HostPeer
  }
  const lifetime = new AbortController()
  return {
    id: `mobile-bridge-${randomUUID()}`,
    ctx,
    principal: { kind: 'owner' },
    signal: lifetime.signal,
    interactions: 'answer',
    dispose: async () => {
      lifetime.abort(new Error('mobile bridge Peer was disposed'))
    },
  }
}

/**
 * Bind a Peer to every call of one Gateway without touching any call site:
 * `invoke` and `stream` gain the field, and so does the carrier's direct
 * `wireStream.open` — dsh 0.2.1 asserts the Peer there too, so an unfilled slot
 * killed the `$events` pump (and with it approvals, questions and every
 * forwarded event) with `reading 'signal'`.
 * @param gateway - the Host `typertGateway` service.
 * @param peer - Peer every call speaks for.
 * @returns a Gateway view that names `peer` on each invocation.
 */
export function withHostPeer<T extends object>(gateway: T, peer: HostPeer): T {
  return new Proxy(gateway, {
    get(target, property) {
      const value = Reflect.get(target, property)
      if ((property === 'invoke' || property === 'stream') && typeof value === 'function') {
        return (request: Record<string, unknown>) => value.call(target, { ...request, peer })
      }
      if (property === 'wireStream' && typeof value === 'object' && value !== null) {
        return withPeerStream(value as Record<string, unknown>, peer)
      }
      return value
    },
  })
}

/**
 * The carrier face needs the same Peer. The wrapper keeps the five declared
 * parameters `openEventStream` reads to pick its call shape; a three-argument
 * caller (hosts before 0.1.7) puts its signal in the third slot and is passed
 * through untouched.
 * @param wireStream - the Host's wire carrier.
 * @param peer - Peer every opened stream speaks for.
 * @returns the carrier view with a Peer-bound `open`.
 */
function withPeerStream<T extends Record<string, unknown>>(wireStream: T, peer: HostPeer): T {
  return new Proxy(wireStream, {
    get(target, property) {
      const value = Reflect.get(target, property)
      if (property !== 'open' || typeof value !== 'function') return value
      const open = value as (...args: unknown[]) => unknown
      return function boundOpen(
        endpoint: unknown,
        payload: unknown,
        uplink: unknown,
        _peer: unknown,
        signal: unknown,
      ): unknown {
        if (signal === undefined) return open.call(target, endpoint, payload, uplink)
        return open.call(target, endpoint, payload, uplink, peer, signal)
      }
    },
  })
}
