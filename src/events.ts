/**
 * Event bridge: pumps the host's two downlink streams (mux + host) onto
 * `evt.dsh.{instance}.mux|host` subjects. Frames keep the exact ServerRequest
 * envelope the browser carrier uses, so the app parses them with the vendored
 * contract unchanged.
 *
 * Pending answerable frames (approval/question) are tracked and re-published
 * when a (re)connected app calls `hello`, mirroring the host's mux-reopen
 * replay semantics over a shared pub/sub channel.
 */
import { randomUUID } from 'node:crypto'
import type { NatsConnection } from 'nats'

/** Narrow structural view of the host stream frames (payload stays opaque). */
export interface StreamFrame {
  rpcId: string
  payload: { type: string } & Record<string, unknown>
}

/** Structural view of the ApiProxy event face this bridge consumes. */
export interface EventStreams {
  events: {
    mux(request: { rpcId: string, payload: Record<string, never> }, signal: AbortSignal): AsyncIterable<StreamFrame>
    host(request: { rpcId: string, payload: Record<string, never> }, signal: AbortSignal): AsyncIterable<StreamFrame>
  }
}

export interface EventBridgeOptions {
  instanceId: string
  /**
   * Coalescing window in ms for `session/projection` frames only. The contract
   * defines them as higher-seq-wins, so publishing the latest frame per
   * (sessionId, key) within a window is lossless. All other frame types are
   * always published immediately. 0 disables coalescing.
   */
  coalesceMs: number
}

/**
 * Adapts the dsh 0.1.2-alpha.2 Typert Gateway `$events` stream to the legacy
 * `EventStreams` interface (mux + host). The wire format on NATS stays the
 * same, so the mobile app protocol layer needs no changes.
 */
export class GatewayEventAdapter {
  private sink: ((frame: StreamFrame) => void) | undefined
  private lifetime: AbortSignal | undefined
  private readonly wantedSessions = new Set<string>()
  private readonly sessionWatchers = new Map<string, AbortController>()

  constructor(private readonly gateway: {
    wireStream: { open(endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>> }
    stream(request: { namespace: string, method: string, args: Record<string, unknown>, signal?: AbortSignal }): Promise<AsyncIterable<unknown>>
  }) {}

  /** Ensure live events for a Session continue after its history snapshot. */
  watchSession(sessionId: string): void {
    if (sessionId.length === 0) return
    this.wantedSessions.add(sessionId)
    if (this.sink !== undefined && this.lifetime !== undefined) this.startSessionWatcher(sessionId)
  }

  readonly events = {
    mux: async function* (this: GatewayEventAdapter, _request: { rpcId: string }, signal: AbortSignal): AsyncGenerator<StreamFrame> {
      yield* this.openAndAdapt(signal)
    }.bind(this),
    host: async function* (this: GatewayEventAdapter, _request: { rpcId: string }, signal: AbortSignal): AsyncGenerator<StreamFrame> {
      // Host-level events are currently merged into the mux stream; the
      // mobile app listens on the mux subject for all actionable frames.
      yield* []
    },
  }

  private async *openAndAdapt(signal: AbortSignal): AsyncGenerator<StreamFrame> {
    const queue = new FrameQueue()
    this.sink = frame => queue.push(frame)
    this.lifetime = signal
    for (const sessionId of this.wantedSessions) this.startSessionWatcher(sessionId)
    const remoteEvents = void this.pumpRemoteEvents(signal).finally(() => queue.close())
    try {
      yield* queue.read(signal)
    } finally {
      void remoteEvents
      this.sink = undefined
      this.lifetime = undefined
      for (const watcher of this.sessionWatchers.values()) watcher.abort()
      this.sessionWatchers.clear()
    }
  }

  private async pumpRemoteEvents(signal: AbortSignal): Promise<void> {
    const stream = await this.gateway.wireStream.open('$events', { args: {} }, signal)
    for await (const item of stream) {
      const frame = adaptFrame(item)
      if (frame !== null) this.sink?.(frame)
    }
  }

  private startSessionWatcher(sessionId: string): void {
    if (this.sessionWatchers.has(sessionId) || this.lifetime === undefined) return
    const controller = new AbortController()
    this.sessionWatchers.set(sessionId, controller)
    const signal = AbortSignal.any([this.lifetime, controller.signal])
    void (async () => {
      try {
        const stream = await this.gateway.stream({
          namespace: 'session', method: 'follow',
          args: { request: { address: { kind: 'session', sessionId }, maxMessages: 1 } },
          signal,
        })
        for await (const item of stream) {
          if (typeof item !== 'object' || item === null) continue
          const record = item as Record<string, unknown>
          if (record['type'] === 'snapshot') {
            this.sink?.({
              rpcId: randomUUID(),
              payload: { type: 'session/subscribed', sessionId, lastSeq: Number(record['cursor'] ?? -1) },
            })
          } else if (record['type'] === 'event' && typeof record['event'] === 'object' && record['event'] !== null) {
            this.sink?.({
              rpcId: randomUUID(),
              payload: { type: 'session/event', sessionId, event: record['event'] },
            })
          }
        }
      } catch {
        // A later history/list call can re-arm the watcher. The NATS bridge
        // remains usable for bounded RPCs if one Session disappears.
      } finally {
        this.sessionWatchers.delete(sessionId)
      }
    })()
  }
}

class FrameQueue {
  private readonly frames: StreamFrame[] = []
  private wake: (() => void) | undefined
  private closed = false

  push(frame: StreamFrame): void {
    if (this.closed) return
    this.frames.push(frame)
    this.wake?.()
    this.wake = undefined
  }

  close(): void {
    this.closed = true
    this.wake?.()
    this.wake = undefined
  }

  async *read(signal: AbortSignal): AsyncGenerator<StreamFrame> {
    const abort = (): void => this.close()
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!this.closed || this.frames.length > 0) {
        const frame = this.frames.shift()
        if (frame !== undefined) yield frame
        else await new Promise<void>(resolve => { this.wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
}

/** Convert one gateway downlink item to the legacy StreamFrame, or null to skip. */
function adaptFrame(item: unknown): StreamFrame | null {
  if (typeof item !== 'object' || item === null) return null
  const record = item as Record<string, unknown>
  const type = record['type']
  if (type === 'emit') {
    // Current forwarded Cordis notifications use a different vocabulary from
    // the legacy mux frames. Baselines cover them; never publish malformed
    // frames that the mobile schema must drop.
    return null
  }
  if (type === 'waterfall') {
    const event = String(record['event'] ?? '')
    if (event === 'approval/request') return { rpcId: String(record['eventId'] ?? randomUUID()), payload: { type: 'approval/requested', sessionId: record['agentId'], approvalId: record['eventId'], ...(typeof record['request'] === 'object' && record['request'] !== null ? record['request'] as Record<string, unknown> : {}) } }
    if (event === 'user-questions/request') return { rpcId: String(record['eventId'] ?? randomUUID()), payload: { type: 'question/requested', sessionId: record['agentId'], ...(typeof record['request'] === 'object' && record['request'] !== null ? record['request'] as Record<string, unknown> : {}) } }
    return null
  }
  if (type === 'cancel') {
    return { rpcId: String(record['eventId'] ?? ''), payload: { type: 'approval/resolved', approvalId: record['eventId'] } }
  }
  return null
}

function serverRequest(frame: StreamFrame): string {
  return JSON.stringify({
    type: 'server-request',
    rpcId: frame.rpcId,
    method: frame.payload.type,
    payload: frame.payload,
  })
}

export class EventBridge {
  private readonly abort = new AbortController()
  private readonly pending = new Map<string, string>() // rpcId -> ServerRequest JSON
  private readonly approvalIds = new Map<unknown, string>() // approvalId -> rpcId
  private readonly coalesceBuffer = new Map<string, string>() // sessionId:key -> JSON
  private coalesceTimer: ReturnType<typeof setInterval> | null = null
  private pumps: Promise<void>[] = []

  constructor(
    private readonly nc: NatsConnection,
    private readonly api: EventStreams,
    private readonly options: EventBridgeOptions,
  ) {}

  start(): void {
    const { signal } = this.abort
    const instance = this.options.instanceId
    this.pumps = [
      this.pump(this.api.events.mux({ rpcId: randomUUID(), payload: {} }, signal), `evt.dsh.${instance}.mux`),
      this.pump(this.api.events.host({ rpcId: randomUUID(), payload: {} }, signal), `evt.dsh.${instance}.host`),
    ]
    if (this.options.coalesceMs > 0) {
      this.coalesceTimer = setInterval(() => this.flushCoalesced(), this.options.coalesceMs)
    }
  }

  async stop(): Promise<void> {
    this.abort.abort()
    if (this.coalesceTimer !== null) clearInterval(this.coalesceTimer)
    this.coalesceTimer = null
    this.flushCoalesced()
    await Promise.allSettled(this.pumps)
    this.pumps = []
  }

  /** Re-publish still-pending answerable frames (app reconnect hook). */
  replayPending(): void {
    const subject = `evt.dsh.${this.options.instanceId}.mux`
    for (const json of this.pending.values()) this.nc.publish(subject, json)
  }

  private async pump(frames: AsyncIterable<StreamFrame>, subject: string): Promise<void> {
    for await (const frame of frames) {
      this.trackPending(frame)
      const json = serverRequest(frame)
      if (this.options.coalesceMs > 0 && frame.payload.type === 'session/projection') {
        const key = `${String(frame.payload['sessionId'])}:${String(frame.payload['key'])}`
        this.coalesceBuffer.set(key, json)
      } else {
        this.nc.publish(subject, json)
      }
    }
  }

  private flushCoalesced(): void {
    if (this.coalesceBuffer.size === 0) return
    const subject = `evt.dsh.${this.options.instanceId}.mux`
    for (const json of this.coalesceBuffer.values()) this.nc.publish(subject, json)
    this.coalesceBuffer.clear()
  }

  private trackPending(frame: StreamFrame): void {
    const payload = frame.payload
    if (payload.type === 'approval/requested') {
      this.pending.set(frame.rpcId, serverRequest(frame))
      this.approvalIds.set(payload['approvalId'], frame.rpcId)
    } else if (payload.type === 'question/requested') {
      this.pending.set(frame.rpcId, serverRequest(frame))
    } else if (payload.type === 'approval/resolved') {
      const rpcId = this.approvalIds.get(payload['approvalId'])
      if (rpcId !== undefined) {
        this.pending.delete(rpcId)
        this.approvalIds.delete(payload['approvalId'])
      }
    } else if (payload.type === 'question/resolved') {
      const questionRpcId = payload['questionRpcId']
      if (typeof questionRpcId === 'string') this.pending.delete(questionRpcId)
    }
  }
}
