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
import type { SessionAddress } from './bridge.js'

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

type GatewayStreamName = 'remote events' | 'session control' | 'workspace follow'

/**
 * Adapts the dsh 0.1.2-alpha.2 Typert Gateway `$events` stream to the legacy
 * `EventStreams` interface (mux + host). The wire format on NATS stays the
 * same, so the mobile app protocol layer needs no changes.
 */
export class GatewayEventAdapter {
  private muxSink: ((frame: StreamFrame) => void) | undefined
  private hostSink: ((frame: StreamFrame) => void) | undefined
  private muxLifetime: AbortSignal | undefined
  private readonly wantedSessions = new Map<string, SessionAddress>()
  private readonly sessionWatchers = new Map<string, AbortController>()
  private readonly pendingEvents = new Map<string, { event: string; agentId: string }>()
  private readonly hostBacklog: StreamFrame[] = []
  private eventClientId: string | undefined
  private workspaceBaseline: { items: unknown[]; archivedSessionIds: unknown[] } | undefined

  private readonly failedStreams = new Set<GatewayStreamName>()

  constructor(private readonly gateway: {
    wireStream: { open(endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>> }
    stream(request: { namespace: string, method: string, args: Record<string, unknown>, signal?: AbortSignal }): Promise<AsyncIterable<unknown>>
  }, private readonly carrier?: { fetch(request: Request): Promise<Response> }, private readonly onStreamError?: (name: GatewayStreamName, error: unknown) => void, private readonly onStreamRecovered?: (name: GatewayStreamName) => void, private readonly retryDelayMs = 1_000) {}

  /** Ensure live events for a Session continue after its history snapshot. */
  watchSession(address: SessionAddress): void {
    const key = sessionAddressKey(address)
    const sessionId = sessionAddressId(address)
    if (sessionId.length === 0) return
    this.wantedSessions.set(key, address)
    if (this.muxSink !== undefined && this.muxLifetime !== undefined) this.startSessionWatcher(address)
  }

  /** Read the current Workspace baseline without reaching into Host internals. */
  async workspaceSnapshot(): Promise<{ items: unknown[]; archivedSessionIds: unknown[] }> {
    if (this.workspaceBaseline !== undefined) return this.workspaceBaseline
    const controller = new AbortController()
    try {
      const stream = await this.gateway.stream({
        namespace: 'workspace', method: 'follow', args: {}, signal: controller.signal,
      })
      for await (const frame of stream) {
        if (!isRecord(frame) || frame.type !== 'baseline' || !isRecord(frame.value)) continue
        this.workspaceBaseline = workspaceValue(frame.value)
        return this.workspaceBaseline
      }
      throw new Error('workspace follow ended before its baseline')
    } finally {
      controller.abort()
    }
  }

  /** Settle one answerable Remote Event delivered by the current `$events` generation. */
  async respond(eventId: string, result: unknown): Promise<boolean> {
    const pending = this.pendingEvents.get(eventId)
    const clientId = this.eventClientId
    if (pending === undefined || clientId === undefined || this.carrier === undefined) return false
    const outcome = remoteEventOutcome(pending.event, result)
    const rpcId = randomUUID()
    const request = new Request('http://mobile.internal/api/$events/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId, method: '$events/result',
        payload: { args: { clientId, eventId, outcome } },
      }),
    })
    const response = await this.carrier.fetch(request)
    const message = await response.json() as unknown
    if (!isRecord(message) || message.type !== 'server-response' || !isRecord(message.result)) {
      throw new Error('remote event result returned an invalid response')
    }
    if (message.result.ok !== true) {
      const error = isRecord(message.result.error) ? message.result.error.message : undefined
      throw new Error(typeof error === 'string' ? error : 'remote event result was rejected')
    }
    return true
  }

  readonly events = {
    mux: async function* (this: GatewayEventAdapter, _request: { rpcId: string }, signal: AbortSignal): AsyncGenerator<StreamFrame> {
      yield* this.openMux(signal)
    }.bind(this),
    host: async function* (this: GatewayEventAdapter, _request: { rpcId: string }, signal: AbortSignal): AsyncGenerator<StreamFrame> {
      yield* this.openHost(signal)
    }.bind(this),
  }

  private async *openMux(signal: AbortSignal): AsyncGenerator<StreamFrame> {
    const queue = new FrameQueue()
    const lifetime = new AbortController()
    const combinedSignal = AbortSignal.any([signal, lifetime.signal])
    this.muxSink = frame => queue.push(frame)
    this.muxLifetime = combinedSignal
    for (const address of this.wantedSessions.values()) this.startSessionWatcher(address)
    const pumps = Promise.allSettled([
      this.runPump('remote events', combinedSignal, lifetime, queue, () => this.pumpRemoteEvents(combinedSignal)),
      this.runPump('session control', combinedSignal, lifetime, queue, () => this.pumpControl(combinedSignal)),
    ])
    try {
      yield* queue.read(signal)
    } finally {
      lifetime.abort()
      await pumps
      this.muxSink = undefined
      this.muxLifetime = undefined
      this.eventClientId = undefined
      for (const watcher of this.sessionWatchers.values()) watcher.abort()
      this.sessionWatchers.clear()
    }
  }

  private async *openHost(signal: AbortSignal): AsyncGenerator<StreamFrame> {
    const queue = new FrameQueue()
    const lifetime = new AbortController()
    const combinedSignal = AbortSignal.any([signal, lifetime.signal])
    this.hostSink = frame => queue.push(frame)
    for (const frame of this.hostBacklog.splice(0)) queue.push(frame)
    const pump = this.runPump(
      'workspace follow', combinedSignal, lifetime, queue,
      () => this.pumpWorkspace(combinedSignal),
    )
    try {
      yield* queue.read(signal)
    } finally {
      lifetime.abort()
      await pump
      this.hostSink = undefined
    }
  }

  private async runPump(
    name: GatewayStreamName,
    signal: AbortSignal,
    _lifetime: AbortController,
    queue: FrameQueue,
    pump: () => Promise<void>,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        await pump()
        if (!signal.aborted) throw new Error(`${name} stream ended unexpectedly`)
      } catch (error) {
        if (signal.aborted) return
        this.failedStreams.add(name)
        if (name === 'remote events') {
          this.eventClientId = undefined
          this.pendingEvents.clear()
        }
        queue.push({
          rpcId: randomUUID(),
          payload: {
            type: 'stream/error',
            error: { code: 'internal', message: errorMessage(error, name), details: {} },
          },
        })
        this.onStreamError?.(name, error)
        await waitForRetry(signal, this.retryDelayMs)
      }
    }
  }

  private async pumpRemoteEvents(signal: AbortSignal): Promise<void> {
    const stream = await this.gateway.wireStream.open('$events', { args: {} }, signal)
    for await (const item of stream) {
      this.adaptRemoteFrame(item)
    }
  }

  private adaptRemoteFrame(item: unknown): void {
    if (!isRecord(item)) return
    if (item.type === 'ready') {
      if (typeof item.clientId === 'string') this.eventClientId = item.clientId
      this.markStreamRecovered('remote events')
      return
    }
    if (item.type === 'emit') {
      const event = typeof item.event === 'string' ? item.event : ''
      const args = Array.isArray(item.args) ? item.args : []
      const hostFrame = hostFrameForEmit(event, args)
      if (hostFrame !== null) this.publishHost(hostFrame)
      return
    }
    if (item.type === 'waterfall') {
      const eventId = typeof item.eventId === 'string' ? item.eventId : ''
      const event = typeof item.event === 'string' ? item.event : ''
      const agentId = typeof item.agentId === 'string' ? item.agentId : ''
      const request = isRecord(item.request) ? item.request : {}
      if (eventId === '' || agentId === '') return
      this.pendingEvents.set(eventId, { event, agentId })
      if (event === 'approval/request') {
        this.muxSink?.({
          rpcId: eventId,
          payload: {
            type: 'approval/requested', sessionId: agentId, approvalId: eventId,
            toolName: typeof request.toolName === 'string' ? request.toolName : 'tool',
            ...(typeof request.callId === 'string' ? { callId: request.callId } : {}),
            ...(typeof request.reason === 'string' ? { reason: request.reason } : {}),
          },
        })
      } else if (event === 'user-questions/request' && Array.isArray(request.questions)) {
        this.muxSink?.({
          rpcId: eventId,
          payload: { type: 'question/requested', sessionId: agentId, questions: request.questions },
        })
      }
      return
    }
    if (item.type === 'cancel' && typeof item.eventId === 'string') {
      const pending = this.pendingEvents.get(item.eventId)
      if (pending === undefined) return
      this.pendingEvents.delete(item.eventId)
      this.muxSink?.(pending.event === 'approval/request'
        ? {
            rpcId: randomUUID(),
            payload: {
              type: 'approval/resolved', sessionId: pending.agentId,
              approvalId: item.eventId, outcome: 'cancelled',
            },
          }
        : {
            rpcId: randomUUID(),
            payload: {
              type: 'question/resolved', sessionId: pending.agentId,
              questionRpcId: item.eventId, outcome: 'cancelled',
            },
          })
    }
  }

  private async pumpControl(signal: AbortSignal): Promise<void> {
    const stream = await this.gateway.stream({ namespace: 'session', method: 'control', args: {}, signal })
    for await (const frame of stream) this.applyControlFrame(frame)
  }

  private publishHost(frame: StreamFrame): void {
    if (this.hostSink !== undefined) this.hostSink(frame)
    else {
      this.hostBacklog.push(frame)
      if (this.hostBacklog.length > 100) this.hostBacklog.shift()
    }
  }

  private applyControlFrame(frame: unknown): void {
    if (!isRecord(frame)) return
    if (frame.type === 'baseline' && isRecord(frame.value)) {
      this.markStreamRecovered('session control')
      const queues = isRecord(frame.value.queues) ? frame.value.queues : {}
      const jobs = isRecord(frame.value.jobs) ? frame.value.jobs : {}
      const projections = isRecord(frame.value.projections) ? frame.value.projections : {}
      for (const [sessionId, items] of Object.entries(queues)) this.publishQueue(sessionId, items)
      for (const [sessionId, value] of Object.entries(jobs)) this.publishJobs(sessionId, value)
      for (const [sessionId, value] of Object.entries(projections)) this.publishProjectionBaseline(sessionId, value)
      return
    }
    const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : ''
    if (sessionId === '') return
    if (frame.type === 'queue') this.publishQueue(sessionId, frame.items)
    else if (frame.type === 'jobs') this.publishJobs(sessionId, frame.jobs)
    else if (frame.type === 'projection' && typeof frame.key === 'string' && typeof frame.seq === 'number') {
      this.muxSink?.({
        rpcId: randomUUID(),
        payload: { type: 'session/projection', sessionId, key: frame.key, value: frame.value, seq: frame.seq },
      })
    }
  }

  private publishQueue(sessionId: string, value: unknown): void {
    const items = Array.isArray(value) ? value.map(queueItem).filter(item => item !== null) : []
    this.muxSink?.({ rpcId: randomUUID(), payload: { type: 'session/queue', sessionId, items } })
  }

  private publishJobs(sessionId: string, value: unknown): void {
    this.muxSink?.({
      rpcId: randomUUID(),
      payload: { type: 'session/jobs', sessionId, jobs: Array.isArray(value) ? value : [] },
    })
  }

  private publishProjectionBaseline(sessionId: string, value: unknown): void {
    if (!isRecord(value) || typeof value.asOfSeq !== 'number' || !isRecord(value.values)) return
    for (const [key, projection] of Object.entries(value.values)) {
      this.muxSink?.({
        rpcId: randomUUID(),
        payload: { type: 'session/projection', sessionId, key, value: projection, seq: value.asOfSeq },
      })
    }
  }

  private async pumpWorkspace(signal: AbortSignal): Promise<void> {
    const stream = await this.gateway.stream({ namespace: 'workspace', method: 'follow', args: {}, signal })
    for await (const frame of stream) this.applyWorkspaceFrame(frame)
  }

  private applyWorkspaceFrame(frame: unknown): void {
    if (!isRecord(frame)) return
    if (frame.type === 'baseline' && isRecord(frame.value)) {
      this.markStreamRecovered('workspace follow')
      this.workspaceBaseline = workspaceValue(frame.value)
      for (const workspace of this.workspaceBaseline.items) {
        this.hostSink?.({ rpcId: randomUUID(), payload: { type: 'host/workspace-changed', workspace } })
      }
      this.hostSink?.({
        rpcId: randomUUID(),
        payload: { type: 'host/archived-sessions-changed', archivedSessionIds: this.workspaceBaseline.archivedSessionIds },
      })
      return
    }
    if (frame.type === 'upsert' && isRecord(frame.workspace)) {
      this.upsertWorkspace(frame.workspace)
      this.hostSink?.({ rpcId: randomUUID(), payload: { type: 'host/workspace-changed', workspace: frame.workspace } })
    } else if (frame.type === 'remove' && typeof frame.workspaceId === 'string') {
      this.removeWorkspace(frame.workspaceId)
      this.hostSink?.({ rpcId: randomUUID(), payload: { type: 'host/workspace-removed', workspaceId: frame.workspaceId } })
    } else if (frame.type === 'order' && Array.isArray(frame.workspaceIds)) {
      this.reorderWorkspaces(frame.workspaceIds)
      this.hostSink?.({ rpcId: randomUUID(), payload: { type: 'host/workspace-order-changed', workspaceIds: frame.workspaceIds } })
    } else if (frame.type === 'archived' && Array.isArray(frame.archivedSessionIds)) {
      if (this.workspaceBaseline !== undefined) this.workspaceBaseline.archivedSessionIds = [...frame.archivedSessionIds]
      this.hostSink?.({
        rpcId: randomUUID(),
        payload: { type: 'host/archived-sessions-changed', archivedSessionIds: frame.archivedSessionIds },
      })
    }
  }

  private upsertWorkspace(workspace: Record<string, unknown>): void {
    this.workspaceBaseline ??= { items: [], archivedSessionIds: [] }
    const id = workspace.workspaceId
    const index = this.workspaceBaseline.items.findIndex(item => isRecord(item) && item.workspaceId === id)
    if (index < 0) this.workspaceBaseline.items.push(workspace)
    else this.workspaceBaseline.items[index] = workspace
  }

  private removeWorkspace(workspaceId: string): void {
    if (this.workspaceBaseline === undefined) return
    this.workspaceBaseline.items = this.workspaceBaseline.items.filter(item => !isRecord(item) || item.workspaceId !== workspaceId)
  }

  private reorderWorkspaces(workspaceIds: unknown[]): void {
    if (this.workspaceBaseline === undefined) return
    const order = new Map(workspaceIds.map((id, index) => [id, index]))
    this.workspaceBaseline.items.sort((left, right) =>
      (order.get(isRecord(left) ? left.workspaceId : undefined) ?? Number.MAX_SAFE_INTEGER)
      - (order.get(isRecord(right) ? right.workspaceId : undefined) ?? Number.MAX_SAFE_INTEGER))
  }

  private startSessionWatcher(address: SessionAddress): void {
    const key = sessionAddressKey(address)
    const sessionId = sessionAddressId(address)
    if (this.sessionWatchers.has(key) || this.muxLifetime === undefined) return
    const controller = new AbortController()
    this.sessionWatchers.set(key, controller)
    const signal = AbortSignal.any([this.muxLifetime, controller.signal])
    void (async () => {
      try {
        const stream = await this.gateway.stream({
          namespace: 'session', method: 'follow',
          args: { request: { address, maxMessages: 1 } },
          signal,
        })
        for await (const item of stream) {
          if (typeof item !== 'object' || item === null) continue
          const record = item as Record<string, unknown>
          if (record['type'] === 'snapshot') {
            this.muxSink?.({
              rpcId: randomUUID(),
              payload: { type: 'session/subscribed', sessionId, lastSeq: Number(record['cursor'] ?? -1) },
            })
          } else if (record['type'] === 'event' && typeof record['event'] === 'object' && record['event'] !== null) {
            this.muxSink?.({
              rpcId: randomUUID(),
              payload: { type: 'session/event', sessionId, event: record['event'] },
            })
          }
        }
      } catch {
        // A later history/list call can re-arm the watcher. The NATS bridge
        // remains usable for bounded RPCs if one Session disappears.
      } finally {
        this.sessionWatchers.delete(key)
      }
    })()
  }

  private markStreamRecovered(name: GatewayStreamName): void {
    if (!this.failedStreams.delete(name)) return
    this.onStreamRecovered?.(name)
  }
}

function sessionAddressId(address: SessionAddress): string {
  return address.kind === 'session'
    ? String(address.sessionId ?? '')
    : String(address.childSessionId ?? '')
}

function errorMessage(error: unknown, source: string): string {
  return `${source}: ${error instanceof Error ? error.message : String(error)}`
}

async function waitForRetry(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, delayMs)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

function sessionAddressKey(address: SessionAddress): string {
  return address.kind === 'session'
    ? `session:${String(address.sessionId ?? '')}`
    : `subagent:${String(address.parentSessionId ?? '')}:${String(address.childSessionId ?? '')}:${String(address.mode ?? '')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function workspaceValue(value: Record<string, unknown>): { items: unknown[]; archivedSessionIds: unknown[] } {
  return {
    items: Array.isArray(value.items) ? [...value.items] : [],
    archivedSessionIds: Array.isArray(value.archivedSessionIds) ? [...value.archivedSessionIds] : [],
  }
}

function queueItem(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !isRecord(value.message)) return null
  const content = Array.isArray(value.message.content) ? value.message.content : []
  return {
    id: value.id,
    placement: value.placement,
    message: {
      id: value.id,
      role: 'user',
      content,
      source: {
        kind: 'user',
        ...(typeof value.rpcId === 'string' ? { rpcId: value.rpcId } : {}),
      },
    },
  }
}

function hostFrameForEmit(event: string, args: unknown[]): StreamFrame | null {
  const rpcId = randomUUID()
  if (event === 'api-session/added' && isRecord(args[0]) && typeof args[0].sessionId === 'string') {
    const summary = args[0]
    const projectionHints = isRecord(summary.projections) && isRecord(summary.projections.values)
      ? summary.projections.values
      : undefined
    const agentPreset = typeof projectionHints?.agentPreset === 'string' ? projectionHints.agentPreset : undefined
    return {
      rpcId,
      payload: {
        type: 'host/session-added', sessionId: summary.sessionId, blank: summary.blank === true,
        ...(typeof summary.parentSessionId === 'string' ? { parentSessionId: summary.parentSessionId } : {}),
        ...(summary.origin === 'subagent' ? { origin: 'subagent' } : {}),
        ...(typeof summary.cwd === 'string' ? { cwd: summary.cwd } : {}),
        ...(agentPreset === undefined ? {} : { agentPreset }),
      },
    }
  }
  if (event === 'api-session/removed' && typeof args[0] === 'string') {
    return { rpcId, payload: { type: 'host/session-removed', sessionId: args[0] } }
  }
  if (event === 'api-session/status' && typeof args[0] === 'string' && typeof args[1] === 'boolean') {
    return { rpcId, payload: { type: 'host/session-status', sessionId: args[0], running: args[1] } }
  }
  if (event === 'api-session/error' && typeof args[0] === 'string' && typeof args[1] === 'string') {
    return { rpcId, payload: { type: 'host/agent-error', sessionId: args[0], message: args[1] } }
  }
  if (event !== '') return { rpcId, payload: { type: 'host/remote-event', event, args } }
  return null
}

function remoteEventOutcome(event: string, result: unknown): Record<string, unknown> {
  if (!isRecord(result)) {
    return { kind: 'rejected', error: { name: 'Error', message: 'mobile response is invalid' } }
  }
  if (result.ok === true && isRecord(result.value)) {
    const value = event === 'approval/request' ? result.value.outcome : result.value.answer
    if (value !== undefined) return { kind: 'result', value }
  }
  const error = isRecord(result.error) ? result.error : {}
  return {
    kind: 'rejected',
    error: {
      name: 'Error',
      message: typeof error.message === 'string' ? error.message : 'mobile response was rejected',
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
      ...(isRecord(error.details) ? { details: error.details } : {}),
    },
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
