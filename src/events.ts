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
