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
  /**
   * Random subject segments for devices that paired with device-scoped event
   * subscriptions. The key is not an authentication credential; publishing to
   * it only keeps one phone from receiving another phone's stream.
   */
  eventKeys?: () => string[]
  /**
   * Whether at least one active device still predates device-scoped events and
   * therefore needs the legacy `evt.dsh.{instance}.mux|host` subjects. Once
   * every active device has re-paired, shared publishing stops automatically.
   */
  legacyShared?: () => boolean
}

type GatewayStreamName = 'remote events' | 'session control' | 'workspace follow' | 'workspace files'

/**
 * Structural view of the Host wire carrier's stream opener. Declared with
 * method syntax so any concrete arity — the legacy `(endpoint, payload,
 * signal)` and the 0.1.7 `(endpoint, payload, uplink, peer, signal)` both
 * assign to it.
 */
export interface EventWireStream {
  open(...args: never[]): Promise<AsyncIterable<unknown>>
}

/**
 * The uplink a Gateway-owned stream never reads. dsh 0.1.7 inserted the Client
 * uplink and the speaking Peer before the signal of
 * `TypertGatewayWireStream.open`, so a carrier opening `$events` must pass an
 * already-ended iterable in that slot.
 */
const NO_UPLINK: AsyncIterable<unknown> = {
  [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ value: undefined, done: true }) }),
}

/**
 * Open the Gateway-owned `$events` stream on either carrier generation.
 *
 * 0.1.7 changed the tail of `wireStream.open` from `signal` to
 * `uplink, peer, signal`, and a Host offers no version handshake before the
 * call; the declared arity is the only pre-call signal that distinguishes
 * them. Passing an AbortSignal where the new carrier reads its uplink fails
 * the stream with `signals[0] must be an instance of AbortSignal`, which takes
 * approvals, questions, and every forwarded event down with it.
 * @param wireStream - the Host's wire carrier.
 * @param signal - generation cancellation for the opened stream.
 * @returns the decoded event frames of one generation.
 */
export async function openEventStream(
  wireStream: EventWireStream,
  signal: AbortSignal,
): Promise<AsyncIterable<unknown>> {
  const open = wireStream.open as (...args: unknown[]) => Promise<AsyncIterable<unknown>>
  const payload = { args: {} }
  const modern = (): Promise<AsyncIterable<unknown>> => open('$events', payload, NO_UPLINK, undefined, signal)
  const legacy = (): Promise<AsyncIterable<unknown>> => open('$events', payload, signal)
  const preferred = open.length > 3 ? modern : legacy
  const other = open.length > 3 ? legacy : modern
  // Declared arity is a pre-call hint, not a contract: a carrier that declares
  // optional or rest parameters reports 0 while still expecting the 0.1.7 tail.
  // A refusal from the guessed shape therefore retries the other one, instead of
  // taking approvals, questions, and every forwarded event down with it.
  try {
    return await preferred()
  } catch (error) {
    if (signal.aborted) throw error
    return await other()
  }
}

/** Concurrent workspace-file watches one bridge keeps open; the least recently
 *  armed target is released first, because every watch is a live Host stream. */
const FILE_WATCH_LIMIT = 4

/** Concurrent job rosters one bridge follows; armed by the Sessions the App opens. */
const JOB_WATCH_LIMIT = 8

/**
 * Concurrent Session streams one bridge follows. Every history read arms one
 * long-lived `session/follow`, so browsing many Sessions and subagents would
 * otherwise accumulate host streams for the whole mux generation.
 */
const SESSION_WATCH_LIMIT = 16

/**
 * Of those streams, how many may belong to Sessions the App only *listed*.
 *
 * `session.list` returns every Session on the machine, in activity order, and
 * the App re-pulls it whenever its baseline goes stale — dozens of rows at a
 * time. Treating those rows as equal interest to a Session the reader actually
 * opened evicted that Session from the list on the very next refresh (it is row
 * one, and the rows after it are always the oldest Sessions), which aborted the
 * one live stream the phone was watching. List interest therefore stops at a
 * fraction of the budget, and is what gets evicted first.
 */
const SESSION_LIST_WATCH_LIMIT = 8

/** Ceiling for one stream's retry delay, so a wedged stream stays cheap. */
const RETRY_DELAY_CAP_MS = 30_000

/**
 * Retry delay for one stream: the base doubled per consecutive failure, capped.
 * @param baseMs - configured first delay.
 * @param streak - consecutive failures, 1 for the first.
 * @returns the delay in milliseconds.
 */
export function retryDelayFor(baseMs: number, streak: number): number {
  const steps = Math.max(1, Math.min(streak, 20))
  return Math.min(baseMs * 2 ** (steps - 1), RETRY_DELAY_CAP_MS)
}

/** The App's approval vocabulary; anything else resolves as cancelled. */
const APPROVAL_OUTCOMES: readonly string[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

/** One approval outcome the App's schema accepts. */
function approvalOutcome(value: unknown): string {
  return typeof value === 'string' && APPROVAL_OUTCOMES.includes(value) ? value : 'cancelled'
}

/**
 * Adapts the dsh 0.1.5-rc.1 Typert Gateway `$events` stream to the legacy
 * `EventStreams` interface (mux + host). The wire format on NATS stays the
 * same, so the mobile app protocol layer needs no changes.
 */
export class GatewayEventAdapter {
  private muxSink: ((frame: StreamFrame) => void) | undefined
  private hostSink: ((frame: StreamFrame) => void) | undefined
  private muxLifetime: AbortSignal | undefined
  private hostLifetime: AbortSignal | undefined
  /**
   * Hook the bridge uses to drop its replay set when the `$events` generation
   * is replaced.
   *
   * Every answerable request belongs to one Host client registration, and the
   * Host re-delivers its still-pending ones to a fresh registration — so a
   * replay entry from a dead generation would resurrect a card the Host no
   * longer holds.
   */
  onRemoteEventsReset: (() => void) | undefined
  /**
   * Sessions the App opened, and Sessions its list merely mentioned.
   *
   * Both are followed, but only pinned interest survives a list refresh: the
   * Session on screen is the one whose live stream the reader is watching, and
   * it is always the first row of the next `session.list`.
   */
  private readonly pinnedSessions = new Map<string, SessionAddress>()
  private readonly listedSessions = new Map<string, SessionAddress>()
  private readonly sessionWatchers = new Map<string, AbortController>()
  private readonly wantedFileWatches: { sessionId: string, path: string }[] = []
  private readonly fileWatchers = new Map<string, AbortController>()
  private readonly wantedJobSessions: string[] = []
  private readonly jobWatchers = new Map<string, AbortController>()
  /** Last roster published per followed Session, replayed to a reconnecting App. */
  private readonly jobRosters = new Map<string, unknown[]>()
  private readonly workspaceRoots = new Map<string, string | undefined>()
  private readonly pendingEvents = new Map<string, { event: string; agentId: string }>()
  private readonly hostBacklog: StreamFrame[] = []
  private eventClientId: string | undefined
  private workspaceBaseline: { items: unknown[]; archivedSessionIds: unknown[] } | undefined

  private readonly failedStreams = new Set<GatewayStreamName>()

  constructor(private readonly gateway: {
    wireStream: EventWireStream
    invoke(request: { namespace: string, method: string, args: Record<string, unknown> }): Promise<unknown>
    stream(request: { namespace: string, method: string, args: Record<string, unknown>, signal?: AbortSignal }): Promise<AsyncIterable<unknown>>
  }, private readonly carrier?: { fetch(request: Request): Promise<Response> }, private readonly onStreamError?: (name: GatewayStreamName, error: unknown) => void, private readonly onStreamRecovered?: (name: GatewayStreamName) => void, private readonly retryDelayMs = 1_000, private readonly toolViews?: { project: (sessionId: string, event: unknown) => unknown }) {}

  /**
   * Ensure live events for a Session continue after its history snapshot.
   *
   * Called for the Sessions the reader actually opens, so this is the interest
   * that outranks whatever a list response mentions.
   * @param address - the Session (or subagent conversation) just opened.
   */
  watchSession(address: SessionAddress): void {
    const key = sessionAddressKey(address)
    const sessionId = sessionAddressId(address)
    if (sessionId.length === 0) return
    // Re-inserting moves the entry to the tail, so eviction follows attention:
    // the Session the App just opened survives, the least recently opened goes.
    this.listedSessions.delete(key)
    this.pinnedSessions.delete(key)
    this.pinnedSessions.set(key, address)
    this.pruneSessionWatchers()
    if (this.muxSink !== undefined && this.muxLifetime !== undefined) this.startSessionWatcher(address)
  }

  /**
   * Register the top-level Sessions named by one `session.list` response.
   *
   * This is weak interest: the list is large, and it is re-pulled whenever the
   * App's baseline goes stale, so it may only claim the budget's spare room and
   * is the first thing evicted. Registering it instead of nothing keeps a
   * Session that starts running on the desktop streaming to a phone that is
   * still looking at the list.
   * @param sessionIds - top-level Session ids, most recent first.
   */
  watchListed(sessionIds: readonly string[]): void {
    this.listedSessions.clear()
    for (const sessionId of sessionIds) {
      if (sessionId.length === 0) continue
      const key = sessionAddressKey({ kind: 'session', sessionId })
      if (this.pinnedSessions.has(key) || this.listedSessions.has(key)) continue
      this.listedSessions.set(key, { kind: 'session', sessionId })
    }
    this.pruneSessionWatchers()
    if (this.muxSink === undefined || this.muxLifetime === undefined) return
    for (const [key, address] of this.listedSessions) {
      if (this.sessionWatchers.has(key)) continue
      this.startSessionWatcher(address)
    }
  }

  /** Drop followed Sessions until both budgets fit, list interest first. */
  private pruneSessionWatchers(): void {
    while (this.listedSessions.size > SESSION_LIST_WATCH_LIMIT) {
      const oldest = this.listedSessions.keys().next().value
      if (oldest === undefined) break
      this.dropSessionWatcher(oldest, this.listedSessions)
    }
    while (this.pinnedSessions.size + this.listedSessions.size > SESSION_WATCH_LIMIT) {
      const fromList = this.listedSessions.size > 0 ? this.listedSessions : this.pinnedSessions
      const oldest = fromList.keys().next().value
      if (oldest === undefined) break
      this.dropSessionWatcher(oldest, fromList)
    }
  }

  /** Release one followed Session's interest and abort its live stream. */
  private dropSessionWatcher(key: string, from: Map<string, SessionAddress>): void {
    from.delete(key)
    const controller = this.sessionWatchers.get(key)
    if (controller === undefined) return
    this.sessionWatchers.delete(key)
    controller.abort()
  }

  /** Every followed Session, strongest interest first. */
  private followedSessions(): SessionAddress[] {
    return [...this.pinnedSessions.values(), ...this.listedSessions.values()]
  }

  /**
   * Follow one Session's background-job roster.
   *
   * dsh 0.1.6-alpha.2 published jobs inside the Session control baseline, and
   * 0.1.7 removed them for a dedicated `jobController/list` stream whose first
   * frame is already the complete set. The mobile wire keeps the old
   * `session/jobs` frame either way, so the App's job strip needs no change.
   * @param sessionId - Session whose visible roster is followed.
   */
  watchJobs(sessionId: string): void {
    if (sessionId.length === 0) return
    const known = this.wantedJobSessions.indexOf(sessionId)
    if (known !== -1) this.wantedJobSessions.splice(known, 1)
    this.wantedJobSessions.push(sessionId)
    while (this.wantedJobSessions.length > JOB_WATCH_LIMIT) {
      const evicted = this.wantedJobSessions.shift()
      if (evicted !== undefined) this.stopJobWatcher(evicted)
    }
    if (this.muxSink !== undefined && this.muxLifetime !== undefined) this.startJobWatcher(sessionId)
  }

  private stopJobWatcher(sessionId: string): void {
    const controller = this.jobWatchers.get(sessionId)
    this.jobRosters.delete(sessionId)
    if (controller === undefined) return
    this.jobWatchers.delete(sessionId)
    controller.abort()
  }

  /**
   * Re-publish the rosters a reconnecting App lost with its previous store.
   *
   * A roster stream only speaks on open and on lifecycle changes, and the
   * App's own store starts empty after a reconnect, so without this replay the
   * job strip would stay blank until some job happened to change.
   */
  replayJobs(): void {
    for (const [sessionId, jobs] of this.jobRosters) {
      this.muxSink?.({ rpcId: randomUUID(), payload: { type: 'session/jobs', sessionId, jobs } })
    }
  }

  private startJobWatcher(sessionId: string): void {
    if (this.jobWatchers.has(sessionId) || this.muxLifetime === undefined) return
    const controller = new AbortController()
    this.jobWatchers.set(sessionId, controller)
    const signal = AbortSignal.any([this.muxLifetime, controller.signal])
    void (async () => {
      try {
        const stream = await this.gateway.stream({
          // The owning Service is `jobController`; its wire namespace is `job`.
          namespace: 'job', method: 'list',
          args: { request: { sessionId } }, signal,
        })
        for await (const item of stream) {
          if (!isRecord(item) || item['type'] !== 'rows' || !Array.isArray(item['jobs'])) continue
          this.publishJobs(sessionId, item['jobs'].flatMap(jobRow))
        }
      } catch {
        // A Host before 0.1.7 has no `jobController`: its control stream still
        // carries the roster, and an absent optional feature is not an error
        // the phone should show.
      } finally {
        this.jobWatchers.delete(sessionId)
      }
    })()
  }

  /**
   * Watch one workspace target so the phone can refresh a listing without
   * polling. dsh 0.1.7 watches a single target per stream — a file or one
   * directory's own entries — so the caller names the directory it shows, and
   * the empty path means the workspace root.
   *
   * Frames ride the host stream as `workspace-files/*` forwarded events: that
   * vocabulary is already published in the frozen mobile wire, while a
   * brand-new mux frame type would be dropped by the App's carrier schema.
   */
  watchFiles(sessionId: string, path = ''): void {
    if (sessionId.length === 0) return
    const key = fileWatchKey(sessionId, path)
    const known = this.wantedFileWatches.findIndex(watch => fileWatchKey(watch.sessionId, watch.path) === key)
    if (known !== -1) this.wantedFileWatches.splice(known, 1)
    this.wantedFileWatches.push({ sessionId, path })
    while (this.wantedFileWatches.length > FILE_WATCH_LIMIT) {
      const evicted = this.wantedFileWatches.shift()
      if (evicted !== undefined) this.stopFileWatcher(fileWatchKey(evicted.sessionId, evicted.path))
    }
    if (this.hostSink !== undefined && this.hostLifetime !== undefined) this.startFileWatcher(sessionId, path)
  }

  /** Release one target watch; the App calls this when its browser closes or navigates. */
  unwatchFiles(sessionId: string, path = ''): void {
    const key = fileWatchKey(sessionId, path)
    const known = this.wantedFileWatches.findIndex(watch => fileWatchKey(watch.sessionId, watch.path) === key)
    if (known !== -1) this.wantedFileWatches.splice(known, 1)
    this.stopFileWatcher(key)
  }

  private stopFileWatcher(key: string): void {
    const controller = this.fileWatchers.get(key)
    if (controller === undefined) return
    this.fileWatchers.delete(key)
    controller.abort()
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

  /**
   * Settle one answerable Remote Event delivered by the current `$events` generation.
   *
   * The Host notifies every *other* delivery target when a request is settled,
   * but never the client whose answer did the settling — that client is dropped
   * from the delivery set first. The bridge therefore publishes the resolution
   * itself: without it the phone keeps a card whose live event is gone, and the
   * replay on the next `hello` resurrects it after every App restart.
   */
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
    this.publishResolved(pending.event, pending.agentId, eventId, result)
    return true
  }

  /**
   * Retire one answerable request the App answers after this generation
   * stopped tracking it.
   *
   * A bridge restart or a finished turn leaves the phone holding a card whose
   * live event is gone: the Host refuses such an answer either way, so the
   * bridge publishes the resolution the App missed instead of leaving an
   * unanswerable card on screen. An approval answer carries `approvalId`;
   * question answers and cancellations carry only the request's own id.
   * @param eventId - the request identity the App answered.
   * @param result - the App's client-response result, whose value names the Session.
   */
  resolveStale(eventId: string, result: unknown): void {
    const value = isRecord(result) && isRecord(result['value']) ? result['value'] : undefined
    const sessionId = typeof value?.['sessionId'] === 'string' ? value['sessionId'] : undefined
    if (sessionId === undefined) return
    // An approval answer names its own id; a question answer and a cancellation
    // carry only the request the App is answering.
    const event = typeof value?.['approvalId'] === 'string' ? 'approval/request' : 'question/request'
    this.publishResolved(event, sessionId, eventId, result)
  }

  /**
   * Publish the resolution frame the App retires a card on.
   *
   * Both the stale answer above and an answer the Host accepted end here: the
   * phone's store deletes by this frame, and the bridge's replay set prunes the
   * same id while forwarding it, so one publication keeps both in step.
   * @param event - the `$events` request kind the resolved id belongs to.
   * @param sessionId - Session the card was shown for.
   * @param eventId - the request identity the App answered.
   * @param result - the App's client-response result, which carries the answer.
   */
  private publishResolved(event: string, sessionId: string, eventId: string, result: unknown): void {
    const value = isRecord(result) && isRecord(result['value']) ? result['value'] : undefined
    if (event === 'approval/request') {
      // Publish what the owner actually tapped when the App's vocabulary can
      // spell it: the App validates this frame, and 「cancelled」 for an answer
      // that said 「允许一次」 would mislabel the decision on any surface that
      // reads the outcome.
      const named = value?.['approvalId']
      this.muxSink?.({
        rpcId: randomUUID(),
        payload: {
          type: 'approval/resolved', sessionId,
          approvalId: typeof named === 'string' ? named : eventId,
          outcome: approvalOutcome(value?.['outcome']),
        },
      })
      return
    }
    this.muxSink?.({
      rpcId: randomUUID(),
      payload: {
        type: 'question/resolved', sessionId, questionRpcId: eventId,
        // The frame carries no answer body, so 「answered」 versus 「cancelled」
        // is the only honest pair; the answers themselves stay on the phone.
        outcome: value?.['answer'] === undefined ? 'cancelled' : 'answered',
      },
    })
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
    for (const address of this.followedSessions()) this.startSessionWatcher(address)
    for (const sessionId of this.wantedJobSessions) this.startJobWatcher(sessionId)
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
      for (const watcher of this.jobWatchers.values()) watcher.abort()
      this.jobWatchers.clear()
    }
  }

  private async *openHost(signal: AbortSignal): AsyncGenerator<StreamFrame> {
    const queue = new FrameQueue()
    const lifetime = new AbortController()
    const combinedSignal = AbortSignal.any([signal, lifetime.signal])
    this.hostSink = frame => queue.push(frame)
    this.hostLifetime = combinedSignal
    for (const frame of this.hostBacklog.splice(0)) queue.push(frame)
    // The file watcher publishes onto this stream, so its lifetime is the
    // host generation, not the mux one.
    for (const watch of this.wantedFileWatches) this.startFileWatcher(watch.sessionId, watch.path)
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
      this.hostLifetime = undefined
      for (const watcher of this.fileWatchers.values()) watcher.abort()
      this.fileWatchers.clear()
    }
  }

  private async runPump(
    name: GatewayStreamName,
    signal: AbortSignal,
    _lifetime: AbortController,
    queue: FrameQueue,
    pump: () => Promise<void>,
  ): Promise<void> {
    let streak = 0
    while (!signal.aborted) {
      try {
        await pump()
        if (!signal.aborted) throw new Error(`${name} stream ended unexpectedly`)
      } catch (error) {
        if (signal.aborted) return
        // A stream that recovered since its last failure starts a fresh streak:
        // its baseline/ready frame cleared the entry in `failedStreams`.
        streak = this.failedStreams.has(name) ? streak + 1 : 1
        this.failedStreams.add(name)
        if (name === 'remote events') {
          this.eventClientId = undefined
          this.pendingEvents.clear()
        }
        // One frame per outage, not one per attempt: the App shows the failure
        // when it starts, and the retries stay invisible behind the backoff.
        if (streak === 1) {
          queue.push({
            rpcId: randomUUID(),
            payload: {
              type: 'stream/error',
              error: { code: 'internal', message: errorMessage(error, name), details: {} },
            },
          })
        }
        this.onStreamError?.(name, error)
        await waitForRetry(signal, retryDelayFor(this.retryDelayMs, streak))
      }
    }
  }

  private async pumpRemoteEvents(signal: AbortSignal): Promise<void> {
    const stream = await openEventStream(this.gateway.wireStream, signal)
    for await (const item of stream) {
      this.adaptRemoteFrame(item)
    }
  }

  private adaptRemoteFrame(item: unknown): void {
    if (!isRecord(item)) return
    if (item.type === 'ready') {
      if (typeof item.clientId === 'string') this.eventClientId = item.clientId
      this.markStreamRecovered('remote events')
      // The Host re-delivers every still-pending request to this fresh
      // registration right after `ready`, so the replay set is rebuilt from the
      // deliverable requests instead of outliving the generation that owned it.
      this.onRemoteEventsReset?.()
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
      if (frame.key === 'inbox') this.publishQueueFromInbox(sessionId, frame.value)
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
    const jobs = Array.isArray(value) ? value : []
    if (this.jobWatchers.has(sessionId)) this.jobRosters.set(sessionId, jobs)
    this.muxSink?.({
      rpcId: randomUUID(),
      payload: { type: 'session/jobs', sessionId, jobs },
    })
  }

  private publishProjectionBaseline(sessionId: string, value: unknown): void {
    if (!isRecord(value) || typeof value.asOfSeq !== 'number' || !isRecord(value.values)) return
    for (const [key, projection] of Object.entries(value.values)) {
      if (key === 'inbox') this.publishQueueFromInbox(sessionId, projection)
      this.muxSink?.({
        rpcId: randomUUID(),
        payload: { type: 'session/projection', sessionId, key, value: projection, seq: value.asOfSeq },
      })
    }
  }

  /**
   * Legacy mobile queue frames from the `inbox` projection.
   *
   * dsh 0.1.6-alpha.2 removed the dedicated `queue` control frames and the
   * baseline's `queues` table; clients now derive pending input from the
   * Session's `inbox` projection, which is what the Web client reads. The App
   * still consumes `session/queue`, so the bridge keeps the frozen wire stable
   * by translating the projection the same way the Host used to.
   */
  private publishQueueFromInbox(sessionId: string, value: unknown): void {
    if (!isRecord(value)) return
    const nextTurn = Array.isArray(value['next-turn']) ? value['next-turn'] : []
    const nextStep = Array.isArray(value['next-step']) ? value['next-step'] : []
    const items = [
      ...nextTurn.map(message => queuedItem(message, 'next-turn')),
      ...nextStep.map(message => queuedItem(message, 'next-step')),
    ].filter(item => item !== null)
    this.muxSink?.({ rpcId: randomUUID(), payload: { type: 'session/queue', sessionId, items } })
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
      // A Session's live stream is the only path for that Session's chunks, its
      // closing message and its `turn/end`. A follow that ended — an error, a
      // Host hiccup, a stream the Host itself retired — used to leave the App on
      // a transcript that never learns how the turn ended until something
      // re-opened the Session, so a finished turn kept reading as work in
      // flight. Re-opening costs one snapshot, and the App dedupes the transient
      // chunks that snapshot replays.
      let streak = 0
      try {
        while (!signal.aborted) {
          try {
            // Every attempt after a failure restarts from a snapshot, so the
            // known attempts of the previous generation are gone with it.
            const reached = await this.followSession(address, sessionId, signal)
            if (signal.aborted) return
            // A follow that ran and ended on its own still took the Session's
            // live stream with it, so the backoff starts over from there.
            if (reached) streak = 0
          } catch {
            if (signal.aborted) return
          }
          streak += 1
          await waitForRetry(signal, retryDelayFor(this.retryDelayMs, streak))
        }
      } finally {
        this.sessionWatchers.delete(key)
      }
    })()
  }

  /**
   * One `session/follow` generation for one Session: republish its live frames
   * until the Host's stream ends, for whatever reason.
   * @param address - the Session (or subagent conversation) being followed.
   * @param sessionId - its id, which every republished frame carries.
   * @param signal - generation cancellation.
   * @returns whether the Host confirmed the follow with a snapshot, which is
   *   what tells a retry loop its attempt got through.
   */
  private async followSession(address: SessionAddress, sessionId: string, signal: AbortSignal): Promise<boolean> {
    const stream = await this.gateway.stream({
      namespace: 'session', method: 'follow',
      args: { request: { address, maxMessages: 1, assistantStream: true } },
      signal,
    })
    const attempts = new Map<string, { turn: number; step: number }>()
    let reached = false
    for await (const item of stream) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      if (record['type'] === 'snapshot') {
        reached = true
        this.muxSink?.({
          rpcId: randomUUID(),
          payload: { type: 'session/subscribed', sessionId, lastSeq: Number(record['cursor'] ?? -1) },
        })
        const baseline = isRecord(record['assistantStream']) ? record['assistantStream'] : undefined
        const active = baseline !== undefined && isRecord(baseline['activeAttempt'])
          ? baseline['activeAttempt'] : undefined
        if (active !== undefined) {
          const attemptId = typeof active['attemptId'] === 'string' ? active['attemptId'] : ''
          const turn = typeof active['turn'] === 'number' ? active['turn'] : -1
          const step = typeof active['step'] === 'number' ? active['step'] : -1
          if (attemptId !== '') {
            attempts.set(attemptId, { turn, step })
            const records = Array.isArray(active['stream']) ? active['stream'] : []
            let streamIndex = 0
            for (const record of records) {
              streamIndex = this.publishAssistantRecord(sessionId, attemptId, turn, step, record, streamIndex)
            }
          }
        }
      } else if (record['type'] === 'event' && typeof record['event'] === 'object' && record['event'] !== null) {
        // The App's structured tool cards ride this slot; without it every
        // card degrades to the raw result text.
        const view = this.toolViews?.project(sessionId, record['event'])
        this.muxSink?.({
          rpcId: randomUUID(),
          payload: {
            type: 'session/event', sessionId, event: record['event'],
            ...(view === undefined ? {} : { view }),
          },
        })
      } else if (record['type'] === 'assistant-stream' && isRecord(record['frame'])) {
        const frame = record['frame']
        const attemptId = typeof frame['attemptId'] === 'string' ? frame['attemptId'] : ''
        if (attemptId === '') continue
        if (frame['type'] === 'start') {
          const turn = typeof frame['turn'] === 'number' ? frame['turn'] : -1
          const step = typeof frame['step'] === 'number' ? frame['step'] : -1
          attempts.set(attemptId, { turn, step })
        } else if (frame['type'] === 'chunk') {
          const position = attempts.get(attemptId)
          if (position !== undefined) this.publishAssistantChunk(sessionId, attemptId, Number(frame['index'] ?? 0), position.turn, position.step, frame['chunk'], frame['time'])
        } else if (frame['type'] === 'end') {
          const position = attempts.get(attemptId)
          if (position !== undefined) this.publishAssistantEnd(sessionId, attemptId, Number(frame['index'] ?? 0), position.turn, position.step, frame['outcome'])
          attempts.delete(attemptId)
        }
      }
    }
    return reached
  }

  private startFileWatcher(sessionId: string, watchTarget: string): void {
    const key = fileWatchKey(sessionId, watchTarget)
    if (this.fileWatchers.has(key) || this.hostLifetime === undefined) return
    const controller = new AbortController()
    this.fileWatchers.set(key, controller)
    const signal = AbortSignal.any([this.hostLifetime, controller.signal])
    void (async () => {
      try {
        const root = await this.workspaceRootOf(sessionId)
        const stream = await this.gateway.stream({
          namespace: 'workspaceFiles', method: 'changes',
          // The Host resolves this against the Session's workspace root and
          // keeps directory targets inside it. `'.'` is the root: an empty
          // path is rejected as a missing argument.
          args: { workspaceFileScopeId: sessionId, path: watchTarget === '' ? '.' : watchTarget }, signal,
        })
        for await (const item of stream) {
          if (!isRecord(item)) continue
          if (item['kind'] === 'ready') {
            this.markStreamRecovered('workspace files')
            this.publishHost({
              rpcId: randomUUID(),
              payload: { type: 'host/remote-event', event: 'workspace-files/ready', args: [{ sessionId }] },
            })
            continue
          }
          if (item['kind'] === 'change' && isRecord(item['change'])) {
            const absolutePath = typeof item['change']['absolutePath'] === 'string'
              ? item['change']['absolutePath'] : undefined
            // A workspace-relative path lets the App ignore changes outside the
            // directory it is showing; without a resolvable root it must refresh.
            const relativePath = absolutePath === undefined ? undefined : workspaceRelativePath(root, absolutePath)
            this.publishHost({
              rpcId: randomUUID(),
              payload: {
                type: 'host/remote-event',
                event: 'workspace-files/change',
                args: [{ sessionId, ...item['change'], ...(relativePath === undefined ? {} : { path: relativePath }) }],
              },
            })
          }
        }
        if (!signal.aborted) throw new Error('workspace file watch ended unexpectedly')
      } catch (error: unknown) {
        if (signal.aborted) return
        this.failedStreams.add('workspace files')
        this.onStreamError?.('workspace files', error)
        this.publishHost({
          rpcId: randomUUID(),
          payload: {
            type: 'host/remote-event',
            event: 'workspace-files/watch-error',
            args: [{ sessionId, message: errorMessage(error, 'workspace files') }],
          },
        })
      } finally {
        // A later file.watch call re-arms the stream for this target.
        this.fileWatchers.delete(key)
      }
    })()
  }

  /**
   * Absolute workspace root of one Session, from its summary `cwd` — the same
   * value `workspaceFileScope` resolves against. Cached per watch attempt;
   * `undefined` means paths stay absolute and clients refresh unconditionally.
   */
  private async workspaceRootOf(sessionId: string): Promise<string | undefined> {
    if (this.workspaceRoots.has(sessionId)) return this.workspaceRoots.get(sessionId)
    let root: string | undefined
    try {
      const value = await this.gateway.invoke({
        namespace: 'session', method: 'list', args: { _request: {} },
      })
      const items = isRecord(value) && Array.isArray(value['items']) ? value['items'] : []
      const match = items.find(item => isRecord(item) && item['sessionId'] === sessionId)
      root = isRecord(match) && typeof match['cwd'] === 'string' && match['cwd'].length > 0
        ? match['cwd'] : undefined
    } catch {
      root = undefined
    }
    this.workspaceRoots.set(sessionId, root)
    return root
  }

  private publishAssistantRecord(sessionId: string, attemptId: string, turn: number, step: number, record: unknown, startIndex: number): number {
    if (!isRecord(record)) return startIndex
    const type = record['type']
    if (type === 'text-chunks' || type === 'reasoning-chunks' || type === 'tool-call-chunks') {
      const texts = type === 'tool-call-chunks' ? record['args'] : record['texts']
      if (!Array.isArray(texts)) return startIndex
      const gaps = Array.isArray(record['dt']) ? record['dt'] : []
      let time = typeof record['time0'] === 'number' ? record['time0'] : 0
      for (let index = 0; index < texts.length; index += 1) {
        if (typeof texts[index] !== 'string') continue
        if (index > 0) time += Number(gaps[index - 1] ?? 0)
        const chunk = type === 'tool-call-chunks'
          ? { type: 'tool-call-delta', index: record['index'], id: record['id'], ...(typeof record['name'] === 'string' ? { name: record['name'] } : {}), argumentsDelta: texts[index] }
          : { type: type === 'text-chunks' ? 'text-delta' : 'reasoning-delta', index: record['index'], text: texts[index] }
        this.publishAssistantChunk(sessionId, attemptId, startIndex + index, turn, step, chunk, time)
      }
      return startIndex + texts.length
    }
    if (type === 'chunk') {
      this.publishAssistantChunk(sessionId, attemptId, startIndex, turn, step, record['chunk'], record['time'])
      return startIndex + 1
    }
    return startIndex
  }

  private publishAssistantChunk(sessionId: string, attemptId: string, index: number, turn: number, step: number, chunk: unknown, time: unknown): void {
    if (!isRecord(chunk)) return
    this.muxSink?.({
      rpcId: randomUUID(),
      payload: { type: 'session/event', sessionId, event: { type: 'assistant/chunk', seq: 0, time: Number(time ?? 0), data: { turn, step, chunk, transient: true, attemptId, index } } },
    })
  }

  private publishAssistantEnd(sessionId: string, attemptId: string, index: number, turn: number, step: number, outcome: unknown): void {
    this.muxSink?.({
      rpcId: randomUUID(),
      payload: { type: 'session/event', sessionId, event: { type: 'assistant/stream-end', seq: 0, time: 0, data: { turn, step, transient: true, attemptId, index, outcome } } },
    })
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

/**
 * One legacy queue row from one pending `inbox` message. `next-turn` entries
 * are queued turns; `next-step` entries are steering when the human authored
 * them and context when a plugin injected them, matching the Host's own
 * derivation before it dropped the queue frames.
 */
function queuedItem(value: unknown, target: 'next-turn' | 'next-step'): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null
  const source = isRecord(value.source) ? value.source : {}
  const sourceKind = typeof source.kind === 'string' ? source.kind : ''
  const placement = target === 'next-turn' ? 'queued' : sourceKind === 'user' ? 'steering' : 'context'
  return {
    id: value.id,
    placement,
    message: {
      id: value.id,
      role: 'user',
      content: Array.isArray(value.content) ? value.content : [],
      source: {
        kind: 'user',
        ...(typeof source.rpcId === 'string' ? { rpcId: source.rpcId } : {}),
      },
    },
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

/**
 * Workspace-relative form of one host path, or `undefined` when the file lies
 * outside the root (or the root is unknown). Comparison is case-insensitive so
 * Windows drive-letter casing never splits a path that is actually inside.
 */
/**
 * One mobile job row from the Host's job view. The frozen mobile schema keeps
 * only what a phone list renders, so registry internals — owner, progress,
 * output coordinates, spill paths — stay on the Host.
 * @param job - one `JobView` from the `jobController/list` stream.
 * @returns the row as a single-element array, or nothing when it is unusable.
 */
function jobRow(job: unknown): Record<string, unknown>[] {
  if (!isRecord(job) || typeof job['id'] !== 'string' || typeof job['kind'] !== 'string'
    || typeof job['label'] !== 'string' || typeof job['status'] !== 'string'
    || typeof job['startedAt'] !== 'number') {
    return []
  }
  return [{
    id: job['id'],
    kind: job['kind'],
    label: job['label'],
    status: job['status'],
    ...(typeof job['detail'] === 'string' ? { detail: job['detail'] } : {}),
    startedAt: job['startedAt'],
    ...(typeof job['finishedAt'] === 'number' ? { finishedAt: job['finishedAt'] } : {}),
  }]
}

/** Stable identity of one armed workspace-file watch: one Session and target. */
function fileWatchKey(sessionId: string, path: string): string {
  return `${sessionId}\u0000${path}`
}

function workspaceRelativePath(root: string | undefined, absolutePath: string): string | undefined {
  if (root === undefined) return undefined
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedPath = absolutePath.replace(/\\/g, '/')
  if (normalizedRoot.length === 0) return undefined
  if (!normalizedPath.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) return undefined
  return normalizedPath.slice(normalizedRoot.length + 1)
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
    this.pumps = [
      this.pump(this.api.events.mux({ rpcId: randomUUID(), payload: {} }, signal), 'mux'),
      this.pump(this.api.events.host({ rpcId: randomUUID(), payload: {} }, signal), 'host'),
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
    for (const json of this.pending.values()) this.publish('mux', json)
  }

  /**
   * Drop the replay set when its `$events` generation is replaced.
   *
   * A request lives in exactly one Host client registration, and that
   * registration re-delivers its still-pending requests as soon as the next
   * generation opens. Keeping entries across the boundary would replay cards
   * the Host already settled — the phone would answer them, the Host would
   * ignore the answer, and the card would come back on every reconnect.
   */
  resetPending(): void {
    this.pending.clear()
    this.approvalIds.clear()
  }

  private subject(stream: 'mux' | 'host', eventKey?: string): string {
    const base = `evt.dsh.${this.options.instanceId}`
    return eventKey === undefined ? `${base}.${stream}` : `${base}.${eventKey}.${stream}`
  }

  /** Fan one frame out to the legacy subject when needed and every keyed device. */
  private publish(stream: 'mux' | 'host', json: string): void {
    if (this.options.legacyShared?.() ?? true) this.nc.publish(this.subject(stream), json)
    for (const eventKey of this.options.eventKeys?.() ?? []) this.nc.publish(this.subject(stream, eventKey), json)
  }

  private async pump(frames: AsyncIterable<StreamFrame>, stream: 'mux' | 'host'): Promise<void> {
    for await (const frame of frames) {
      this.trackPending(frame)
      const json = serverRequest(frame)
      if (this.options.coalesceMs > 0 && frame.payload.type === 'session/projection') {
        const key = `${String(frame.payload['sessionId'])}:${String(frame.payload['key'])}`
        this.coalesceBuffer.set(`${stream}:${key}`, json)
      } else {
        this.publish(stream, json)
      }
    }
  }

  private flushCoalesced(): void {
    if (this.coalesceBuffer.size === 0) return
    for (const [key, json] of this.coalesceBuffer) {
      this.publish(key.startsWith('host:') ? 'host' : 'mux', json)
    }
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
