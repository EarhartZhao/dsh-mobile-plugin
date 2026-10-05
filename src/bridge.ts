/**
 * RPC bridge: NATS request-reply on `svc.dsh.{instance}.>` to the in-process
 * ApiProxy via its fetch carrier. Token gate and method whitelist run before
 * any dispatch. Pairing (`pair`) and the reconnect hook (`hello`) are answered
 * by the plugin itself, everything else forwards verbatim.
 */
import type { Msg, NatsConnection } from 'nats'
import type { TokenStore } from './tokens.js'

/** Direct in-process view of the current Typert Gateway. */
export interface GatewayCarrier {
  invoke(request: {
    namespace: string
    method: string
    args: Record<string, unknown>
    signal?: AbortSignal
  }): Promise<unknown>
  stream(request: {
    namespace: string
    method: string
    args: Record<string, unknown>
    signal?: AbortSignal
  }): Promise<AsyncIterable<unknown>>
  wireStream: {
    failure(error: unknown): { code: string, message: string, details: object }
  }
}

/** Methods forwarded to the host ApiProxy (docs/00 whitelist). */
const ALLOWED_METHODS = new Set([
  'host.describe',
  'host.listDirectory',
  'host.createDirectory',
  'workspace.list',
  'workspace.create',
  'workspace.rename',
  'workspace.delete',
  'workspace.archiveSession',
  'workspace.unarchiveSession',
  'workspace.insertBefore',
  'workspace.insertSessionBefore',
  'session.list',
  'session.create',
  'session.history',
  'session.attachment',
  'file.upload',
  'session.prompt',
  'session.cancel',
  'session.updateQueue',
  'session.rename',
  'session.fork',
  'session.models',
  'session.selectModel',
  'session.search',
  'host.openPath',
  'command.list',
  'command.execute',
  'reference.files',
  'reference.sessions',
  'skill.list',
  'goal.get',
  'feedback.list',
  'feedback.put',
  'feedback.delete',
  'goal.create',
  'goal.edit',
  'goal.pause',
  'goal.resume',
  'goal.complete',
  'goal.clear',
  'file.list',
  'file.read',
  'file.bytes',
  'file.related',
  'file.stat',
  'file.watch',
  'file.unwatch',
  'file.reveal',
  'subagent.list',
  'subagent.history',
  'subagent.interrupt',
  'subagent.prompt',
  'agentPreset.list',
  'agentPreset.select',
  'agentPreset.read',
  'respond',
])

/** Plugin-owned methods (never reach the ApiProxy). */
export const PAIR_METHOD = 'pair'
export const HELLO_METHOD = 'hello'
export const MOBILE_INFO_METHOD = 'mobile.info'
export const MOBILE_HEALTH_METHOD = 'mobile.health'
export const MOBILE_INVENTORY_METHOD = 'mobile.inventory'

/** Compatibility manifest consumed by App 0.1.x. */
export const PLUGIN_VERSION = '0.2.21'
export const PLUGIN_MOBILE_API = 2
export const PLUGIN_FEATURES = [
  'plus-menu',
  'command-directory',
  'multi-image',
  'durable-attachment-order',
  'plugin-inventory',
  'health-check',
  'typert-remote-v2',
  'session-history-pages',
  'session-control',
  'workspace-follow',
  'remote-event-results',
  'reference-candidates',
  'file-uploads',
  'workspace-files',
  'workspace-watch',
  'workspace-stat',
  'message-feedback',
  'workspace-unarchive',
  'goal-state',
  'open-path',
] as const

export const TOKEN_HEADER = 'x-dsh-token'

/** Fetch carrier for the host connection shared handler. */
export interface FetchCarrier {
  fetch(request: Request): Promise<Response>
}

export interface BridgeOptions {
  instanceId: string
  /** Legacy carrier retained for old dsh builds; current dev uses gateway. */
  carrier?: FetchCarrier
  gateway?: GatewayCarrier
  tokens: TokenStore
  tokenTtlDays: number
  maxDevices: number
  /** Re-publish pending answerable frames to a reconnecting app. */
  onHello: () => void
  /** Optional read-only Loader snapshot; absent on hosts without the inventory plugin. */
  onInventory?: () => unknown | Promise<unknown>
  /** Authenticated operational snapshot for mobile connection diagnostics. */
  onHealth?: () => unknown
  /** Host facts removed from the current unary Remote surface. */
  onHostDescribe?: () => unknown | Promise<unknown>
  onWorkspaceList?: () => unknown | Promise<unknown>
  /** Called when a Session address becomes relevant to the mobile client. */
  onSessionSeen?: (address: SessionAddress) => void
  /**
   * Projects one durable event into the `session/event` frame's `view` slot, so
   * the App renders a tool's declared card instead of raw text. Absent when the
   * host exposes no tool registry.
   */
  toolViews?: { project: (sessionId: string, event: unknown) => unknown }
  /**
   * Called when the App opens one Session's transcript. Job rosters are host
   * streams, so they are armed here rather than for every listed Session.
   */
  onSessionOpened?: (sessionId: string) => void
  /**
   * Start (or re-arm) one workspace file-change stream. dsh 0.1.7 watches a
   * single target, so the browser names the directory it shows; an empty path
   * means the workspace root.
   */
  onFileWatch?: (sessionId: string, path?: string) => void
  /** Release one target watch; the same path the arming call named. */
  onFileUnwatch?: (sessionId: string, path?: string) => void
  /** Settle one Gateway Remote Event using its original event-stream generation. */
  onRespond?: (rpcId: string, result: unknown) => Promise<boolean>
  /**
   * Called when an answer arrives for a request this generation no longer
   * tracks, so the bridge can publish the resolution the App missed.
   */
  onStaleRespond?: (eventId: string, result: unknown) => void
}

interface ClientEnvelope {
  type?: unknown
  rpcId?: unknown
  method?: unknown
  payload?: unknown
  result?: unknown
}

interface RemoteCall {
  namespace: string
  method: string
  args: Record<string, unknown>
}

const DIRECT_REQUEST_METHODS = new Set([
  'session.create', 'session.search', 'session.selectModel', 'session.rename',
  'session.fork', 'session.attachment', 'session.updateQueue', 'session.cancel',
  'workspace.create', 'workspace.rename', 'workspace.delete',
  'workspace.insertBefore', 'workspace.insertSessionBefore', 'workspace.archiveSession',
  'workspace.unarchiveSession',
  'skill.list',
])

/** Translate the frozen mobile v1 method/payload vocabulary to current Remote args. */
export function remoteCall(method: string, payload: unknown, rpcId: string): RemoteCall | null {
  const request = isRecord(payload) ? payload : {}
  if (method === 'session.list') return { namespace: 'session', method: 'list', args: { _request: request } }
  if (method === 'session.prompt') {
    return { namespace: 'session', method: 'prompt', args: { request: { requestId: rpcId, ...request } } }
  }
  if (method === 'session.models') return { namespace: 'session', method: 'modelCatalog', args: {} }
  if (method === 'agentPreset.list') return { namespace: 'agentPresets', method: 'list', args: {} }
  if (method === 'agentPreset.read') return { namespace: 'agentPresets', method: 'read', args: request }
  if (method === 'agentPreset.select') {
    return {
      namespace: 'agentPresets', method: 'select',
      args: { agentId: request.sessionId, agentPreset: request.agentPreset },
    }
  }
  if (method === 'command.list') {
    return { namespace: 'commands', method: 'list', args: { agentId: request.sessionId } }
  }
  if (method === 'command.execute') {
    const submittedAttachments = Array.isArray(request.attachments)
      ? request.attachments
      : Array.isArray(request.images)
        ? request.images.map(image => isRecord(image) ? { type: 'image', ...image } : image)
        : []
    return {
      namespace: 'commands', method: 'execute',
      args: { agentId: request.sessionId, line: request.line, submittedAttachments },
    }
  }
  if (method === 'file.upload') {
    return {
      namespace: 'fileUploads', method: 'upload',
      args: {
        agentId: request.sessionId,
        request: {
          data: request.data,
          ...(typeof request.name === 'string' ? { name: request.name } : {}),
        },
      },
    }
  }
  if (method === 'reference.files') {
    return {
      namespace: 'fileReferences', method: 'list',
      args: { agentId: request.sessionId, query: request.query ?? '' },
    }
  }
  if (method === 'reference.sessions') {
    return {
      namespace: 'sessionReferenceResolver', method: 'candidates',
      args: { agentId: request.sessionId, query: request.query ?? '' },
    }
  }
  if (method === 'subagent.list') return { namespace: 'subagents', method: 'list', args: request }
  if (method === 'subagent.prompt') {
    return { namespace: 'subagents', method: 'prompt', args: { request: { requestId: rpcId, ...request } } }
  }
  if (method === 'subagent.interrupt') {
    return { namespace: 'subagents', method: 'interruptByParent', args: request }
  }
  if (method === 'goal.get') {
    return { namespace: 'goals', method: 'get', args: { agentId: request.sessionId } }
  }
  if (method === 'feedback.list') {
    return { namespace: 'messageFeedback', method: 'list', args: { request: { sessionId: request.sessionId } } }
  }
  if (method === 'feedback.put') {
    // The host answers with a business result ({ok:true|false}), not a Remote
    // error, so `ifVersion` is forwarded verbatim for compare-and-set.
    return {
      namespace: 'messageFeedback', method: 'put',
      args: {
        request: {
          sessionId: request.sessionId,
          messageId: request.messageId,
          rating: request.rating,
          ...(typeof request.note === 'string' ? { note: request.note } : {}),
          ...(typeof request.category === 'string' ? { category: request.category } : {}),
          ifVersion: request.ifVersion ?? null,
        },
      },
    }
  }
  if (method === 'feedback.delete') {
    return {
      namespace: 'messageFeedback', method: 'delete',
      args: { request: { sessionId: request.sessionId, messageId: request.messageId, ifVersion: request.ifVersion } },
    }
  }
  if (method === 'file.list') {
    // `workspaceFiles` speaks workspace paths and resolves its scope from the
    // Session header. The root is spelled `'.'`: the host rejects an empty
    // path as a missing argument (verified against a live host).
    return {
      namespace: 'workspaceFiles', method: 'list',
      args: {
        workspaceFileScopeId: request.sessionId,
        path: typeof request.path === 'string' && request.path !== '' ? request.path : '.',
      },
    }
  }
  if (method === 'file.read') {
    return {
      namespace: 'workspaceFiles', method: 'read',
      args: {
        workspaceFileScopeId: request.sessionId,
        path: request.path,
        range: {
          ...(typeof request.offset === 'number' ? { offset: request.offset } : {}),
          ...(typeof request.limit === 'number' ? { limit: request.limit } : {}),
        },
      },
    }
  }
  if (method === 'file.bytes') {
    return {
      namespace: 'workspaceFiles', method: 'readBytes',
      args: {
        workspaceFileScopeId: request.sessionId,
        path: request.path,
        // dsh 0.1.7 moved the window under `options`; the top-level `range`
        // this bridge used through 0.1.6-alpha.2 now fails argument validation.
        options: { range: byteRange(request) },
      },
    }
  }
  if (method === 'file.stat') {
    // Cheap freshness probe: one version string lets the App reuse a cached
    // preview instead of re-reading the whole page.
    return {
      namespace: 'workspaceFiles', method: 'stat',
      args: { workspaceFileScopeId: request.sessionId, path: request.path },
    }
  }
  if (method === 'file.related') {
    // dsh 0.1.7 folded `readRelated` into `readBytes`: the target stays
    // relative and the base file names the directory it resolves against.
    // Markdown previews pull the images they reference through this.
    return {
      namespace: 'workspaceFiles', method: 'readBytes',
      args: {
        workspaceFileScopeId: request.sessionId,
        path: request.relativePath,
        options: { baseFile: request.path },
      },
    }
  }
  if (method === 'file.reveal' || method === 'host.openPath') {
    // One Host hand-off covers both verbs: opening uses the default
    // application, revealing selects the path in the file manager.
    return {
      namespace: 'session', method: 'openWorkspacePath',
      args: {
        request: {
          path: request.path,
          ...(method === 'file.reveal' ? { action: 'reveal' } : {}),
        },
      },
    }
  }
  if (method.startsWith('goal.')) {
    const name = method.slice('goal.'.length)
    if (name === 'create') {
      return {
        namespace: 'goals', method: name,
        args: {
          agentId: request.sessionId,
          request: {
            objective: request.objective,
            ...(request.maxGoalRounds === undefined ? {} : { maxGoalRounds: request.maxGoalRounds }),
          },
        },
      }
    }
    if (name === 'edit') {
      return {
        namespace: 'goals', method: name,
        args: {
          agentId: request.sessionId,
          ref: request.ref,
          request: {
            ...(request.objective === undefined ? {} : { objective: request.objective }),
            ...(request.maxGoalRounds === undefined ? {} : { maxGoalRounds: request.maxGoalRounds }),
          },
        },
      }
    }
    return {
      namespace: 'goals', method: name,
      args: { agentId: request.sessionId, ref: request.ref },
    }
  }
  if (DIRECT_REQUEST_METHODS.has(method)) {
    const [namespace, name] = method.split('.') as [string, string]
    const actualNamespace = namespace === 'skill' ? 'skills' : namespace
    return { namespace: actualNamespace, method: name, args: { request } }
  }
  return null
}

/**
 * The App's frozen subagent catalog, built from the parent's `subagentCatalog`
 * projection and the current Session list.
 *
 * A projection row carries identity, creation time, mode, and label. The App
 * also renders liveness (`activity`) and nesting (`hasChildren`), which the
 * Session list answers: a child's own running turn, and its presence as some
 * other Session's `parentSessionId`. The parent's `agentAvailable` is the
 * delivery-time hint the App gates continuation on.
 * @param parentSessionId - Session whose direct children are requested.
 * @param projection - `session/projections` value for that Session, or null.
 * @param sessions - `session/list` value for the whole Host.
 * @returns the catalog shape `subagents/list` published through 0.1.6-alpha.2.
 */
function subagentCatalogValue(parentSessionId: string, projection: unknown, sessions: unknown): unknown {
  const values = isRecord(projection) && isRecord(projection.values) ? projection.values : {}
  const rows = Array.isArray(values['subagentCatalog']) ? values['subagentCatalog'] : []
  const summaries = (isRecord(sessions) && Array.isArray(sessions.items) ? sessions.items : []).flatMap((item) => {
    if (!isRecord(item) || typeof item['sessionId'] !== 'string') return []
    return [{ id: item['sessionId'], summary: item }]
  })
  // One pass, one lookup per row: the catalog is built on every history read and
  // a Host can hold hundreds of Sessions.
  const byId = new Map(summaries.map(entry => [entry.id, entry.summary]))
  const parents = new Set(summaries.flatMap(entry =>
    typeof entry.summary['parentSessionId'] === 'string' ? [entry.summary['parentSessionId']] : []))
  const entries = rows.flatMap((row) => {
    if (!isRecord(row) || typeof row.id !== 'string') return []
    const child = byId.get(row.id)
    return [{
      kind: 'child',
      id: row.id,
      // A mode the record could not determine is not continuable, and the App
      // only distinguishes those two; it stays readable as a one-shot child.
      mode: row.mode === 'continuable' ? 'continuable' : 'one-shot',
      ...(typeof row.label === 'string' ? { label: row.label } : {}),
      activity: child?.['running'] === true ? 'running' : 'inactive',
      hasChildren: parents.has(row.id),
    }]
  })
  return { entries, parentAvailable: byId.get(parentSessionId)?.['agentAvailable'] === true }
}

/** The byte window one mobile `file.bytes` request asks for, as the Host spells it. */
function byteRange(request: Record<string, unknown>): Record<string, number> {
  return {
    ...(typeof request.offset === 'number' ? { offset: request.offset } : {}),
    ...(typeof request.length === 'number' ? { length: request.length } : {}),
  }
}

/**
 * The workspace-relative target one `file.watch` request names. The empty
 * string is the workspace root, which the Host spells `'.'`; dsh 0.1.7 watches
 * exactly one target per stream, so the App sends the directory it shows.
 */
function watchPath(request: Record<string, unknown>): string {
  return typeof request.path === 'string' ? request.path : ''
}

/**
 * The pre-0.1.7 shape of the two file-read mappings, or null for every method
 * whose arguments dsh has not changed.
 */
function legacyRemoteCall(method: string, payload: unknown, _rpcId: string): RemoteCall | null {
  const request = isRecord(payload) ? payload : {}
  if (method === 'file.bytes') {
    return {
      namespace: 'workspaceFiles', method: 'readBytes',
      args: { workspaceFileScopeId: request.sessionId, path: request.path, range: byteRange(request) },
    }
  }
  if (method === 'file.related') {
    return {
      namespace: 'workspaceFiles', method: 'readRelated',
      args: { workspaceFileScopeId: request.sessionId, path: request.path, relativePath: request.relativePath },
    }
  }
  return null
}

/**
 * Mobile wire keeps one byte window base64-encoded, because its carrier is
 * JSON. dsh 0.1.7 returns native bytes from `workspaceFiles/readBytes`, which
 * JSON would encode as an index map and the App's frozen schema would reject.
 * @param value - the Host's `WorkspaceFileBytes`.
 * @returns the same window with a base64 `data` field.
 */
function fileBytesValue(value: unknown): unknown {
  if (!isRecord(value) || typeof value.data === 'string') return value
  const bytes = value.data instanceof Uint8Array
    ? value.data
    : Array.isArray(value.data) ? Uint8Array.from(value.data as number[]) : undefined
  return bytes === undefined ? value : { ...value, data: Buffer.from(bytes).toString('base64') }
}

export interface SessionAddress {
  kind: 'session' | 'subagent'
  sessionId?: string
  parentSessionId?: string
  childSessionId?: string
  mode?: string
}

function addressFromHistory(method: string, request: Record<string, unknown>): SessionAddress {
  if (method === 'subagent.history') {
    return {
      kind: 'subagent',
      parentSessionId: String(request.parentSessionId ?? ''),
      childSessionId: String(request.childSessionId ?? ''),
      mode: String(request.mode ?? ''),
    }
  }
  return { kind: 'session', sessionId: String(request.sessionId ?? '') }
}

function addressKey(address: SessionAddress): string {
  return address.kind === 'session'
    ? `session:${String(address.sessionId ?? '')}`
    : `subagent:${String(address.parentSessionId ?? '')}:${String(address.childSessionId ?? '')}:${String(address.mode ?? '')}`
}

/** The Session a history read targets: the child for a subagent address. */
function sessionAddressTarget(address: SessionAddress): string {
  return address.kind === 'subagent'
    ? String(address.childSessionId ?? '')
    : String(address.sessionId ?? '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function serverResult(rpcId: string, value: unknown): string {
  return JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } })
}

function serverFailure(
  rpcId: string,
  error: { code: string, message: string, details: object },
): string {
  return JSON.stringify({ type: 'server-response', rpcId, result: { ok: false, error } })
}

function expandChunkEvent(event: Record<string, unknown>): Record<string, unknown>[] {
  const type = event.type
  if (type !== 'chunkrow/text-chunks'
    && type !== 'chunkrow/reasoning-chunks'
    && type !== 'chunkrow/tool-call-chunks') return [event]
  const data = isRecord(event.data) ? event.data : {}
  const fragments = type === 'chunkrow/tool-call-chunks' ? data.args : data.texts
  if (!Array.isArray(fragments) || !fragments.every(fragment => typeof fragment === 'string')) return []
  const gaps = Array.isArray(data.dt) ? data.dt : []
  let time = Number(event.time ?? 0)
  return fragments.map((fragment, index) => {
    if (index > 0) time += Number(gaps[index - 1] ?? 0)
    const chunk = type === 'chunkrow/tool-call-chunks'
      ? {
          type: 'tool-call-delta', index: data.index, id: data.id,
          ...(typeof data.name === 'string' ? { name: data.name } : {}),
          argumentsDelta: fragment,
        }
      : {
          type: type === 'chunkrow/text-chunks' ? 'text-delta' : 'reasoning-delta',
          index: data.index,
          text: fragment,
        }
    return {
      type: 'assistant/chunk',
      seq: Number(event.seq ?? 0) + index,
      time,
      data: { turn: data.turn, step: data.step, chunk },
    }
  })
}

/**
 * One page's or snapshot's records as wire entries.
 *
 * @param value - the Remote snapshot or page being translated.
 * @param view - the tool-view projector for this Session, when the host has one.
 * @returns history entries; each carries the `view` slot when a tool can present it.
 */
function historyEntries(
  value: unknown,
  view?: (event: Record<string, unknown>) => unknown,
): { event: Record<string, unknown>, view?: unknown }[] {
  if (!isRecord(value) || !Array.isArray(value.records)) return []
  return value.records.flatMap((record) => {
    if (!isRecord(record) || !isRecord(record.event)) return []
    return expandChunkEvent(record.event).map(event => {
      const projected = view?.(event)
      return projected === undefined ? { event } : { event, view: projected }
    })
  })
}

function historyValue(snapshot: unknown, project?: (event: Record<string, unknown>) => unknown): unknown {
  if (!isRecord(snapshot) || snapshot.type !== 'snapshot') {
    throw new Error('session follow did not begin with a snapshot')
  }
  return {
    events: historyEntries(snapshot, project),
    hasMore: snapshot.hasMore === true,
    ...(isRecord(snapshot.projections) ? { projections: snapshot.projections } : {}),
  }
}

function pageValue(page: unknown, project?: (event: Record<string, unknown>) => unknown): unknown {
  if (!isRecord(page)) throw new Error('session page returned an invalid value')
  return { events: historyEntries(page, project), hasMore: page.hasMore === true }
}

async function firstValue(stream: AsyncIterable<unknown>): Promise<unknown> {
  const iterator = stream[Symbol.asyncIterator]()
  try {
    const item = await iterator.next()
    if (item.done) throw new Error('Remote stream ended before its baseline')
    return item.value
  } finally {
    await iterator.return?.()
  }
}

function gateFailure(rpcId: unknown, reason: 'mobile-unauthenticated' | 'mobile-forbidden'): string {
  // The wire error vocabulary is a closed set, so gate rejections ride the
  // 'internal' code; the `mobile-` message prefix is the machine-readable signal.
  return JSON.stringify({
    type: 'server-response',
    rpcId: typeof rpcId === 'string' ? rpcId : 'unknown',
    result: { ok: false, error: { code: 'internal', message: reason, details: {} } },
  })
}

function pairResult(rpcId: unknown, value: unknown): string {
  return JSON.stringify({
    type: 'server-response',
    rpcId: typeof rpcId === 'string' ? rpcId : 'unknown',
    result: value === null
      ? { ok: false, error: { code: 'internal', message: 'mobile-pair-failed', details: {} } }
      : { ok: true, value },
  })
}

function pairFailure(rpcId: unknown, message: 'mobile-pair-failed' | 'mobile-device-limit'): string {
  return JSON.stringify({
    type: 'server-response',
    rpcId: typeof rpcId === 'string' ? rpcId : 'unknown',
    result: { ok: false, error: { code: 'internal', message, details: {} } },
  })
}

export class RpcBridge {
  private readonly historyCursors = new Map<string, number>()
  /** Cursors kept per address; a long-lived bridge must not grow without bound. */
  private static readonly HISTORY_CURSOR_LIMIT = 64

  /** Remember one address's cursor, evicting the least recently used entry. */
  private rememberCursor(key: string, cursor: number): void {
    this.historyCursors.delete(key)
    this.historyCursors.set(key, cursor)
    while (this.historyCursors.size > RpcBridge.HISTORY_CURSOR_LIMIT) {
      const oldest = this.historyCursors.keys().next().value
      if (oldest === undefined) break
      this.historyCursors.delete(oldest)
    }
  }

  /** This Session's tool-view projection, when the host exposed a tool registry. */
  private projector(sessionId: string): ((event: Record<string, unknown>) => unknown) | undefined {
    const toolViews = this.options.toolViews
    return toolViews === undefined ? undefined : event => toolViews.project(sessionId, event)
  }
  private readonly prefix: string
  private subscription: ReturnType<NatsConnection['subscribe']> | null = null

  constructor(
    private readonly nc: NatsConnection,
    private readonly options: BridgeOptions,
  ) {
    this.prefix = `svc.dsh.${options.instanceId}.`
  }

  start(): void {
    this.subscription = this.nc.subscribe(`${this.prefix}>`)
    void this.serve(this.subscription)
  }

  async stop(): Promise<void> {
    this.subscription?.unsubscribe()
    this.subscription = null
  }

  private async serve(subscription: NonNullable<typeof this.subscription>): Promise<void> {
    for await (const msg of subscription) {
      void this.handle(msg).catch(() => {
        // A failed handle must never kill the serve loop; the caller's
        // request times out on its own and reconnects through its generation.
      })
    }
  }

  private async handle(msg: Msg): Promise<void> {
    const method = msg.subject.slice(this.prefix.length)
    const body = msg.data // ClientRequest envelope bytes, opaque to the gate

    let rpcId: unknown = 'unknown'
    try {
      rpcId = (JSON.parse(new TextDecoder().decode(body)) as { rpcId?: unknown }).rpcId
    } catch {
      // Malformed payload: still answer with a gate-shaped error so callers
      // never hang waiting on a reply.
      msg.respond(new TextEncoder().encode(gateFailure('unknown', 'mobile-forbidden')))
      return
    }

    if (method === PAIR_METHOD) {
      const payload = (JSON.parse(new TextDecoder().decode(body)) as { payload?: { code?: string, deviceName?: string } }).payload
      const redeemed = await this.options.tokens.redeemPairingCodeResult(
        String(payload?.code ?? ''),
        String(payload?.deviceName ?? ''),
        this.options.tokenTtlDays,
        this.options.maxDevices,
      )
      msg.respond(new TextEncoder().encode(redeemed.ok
        ? pairResult(rpcId, redeemed.value)
        : pairFailure(rpcId, redeemed.reason === 'device-limit' ? 'mobile-device-limit' : 'mobile-pair-failed')))
      return
    }

    const token = msg.headers?.get(TOKEN_HEADER)
    const device = token === undefined ? null : this.options.tokens.validate(token)
    if (device === null) {
      msg.respond(new TextEncoder().encode(gateFailure(rpcId, 'mobile-unauthenticated')))
      return
    }

    if (method === HELLO_METHOD) {
      this.options.onHello()
      msg.respond(new TextEncoder().encode(pairResult(rpcId, { ok: true })))
      return
    }

    if (method === MOBILE_INFO_METHOD) {
      msg.respond(new TextEncoder().encode(pairResult(rpcId, {
        pluginVersion: PLUGIN_VERSION,
        mobileApi: PLUGIN_MOBILE_API,
        features: PLUGIN_FEATURES,
      })))
      return
    }

    if (method === MOBILE_HEALTH_METHOD) {
      const health = this.options.onHealth?.()
      msg.respond(new TextEncoder().encode(health === undefined || health === null
        ? gateFailure(rpcId, 'mobile-forbidden')
        : pairResult(rpcId, health)))
      return
    }

    if (method === MOBILE_INVENTORY_METHOD) {
      const inventory = await this.options.onInventory?.()
      msg.respond(new TextEncoder().encode(inventory === undefined || inventory === null
        ? gateFailure(rpcId, 'mobile-forbidden')
        : pairResult(rpcId, inventory)))
      return
    }

    if (!ALLOWED_METHODS.has(method)) {
      msg.respond(new TextEncoder().encode(gateFailure(rpcId, 'mobile-forbidden')))
      return
    }

    const envelope = JSON.parse(new TextDecoder().decode(body)) as ClientEnvelope
    const id = typeof rpcId === 'string' ? rpcId : 'unknown'
    // Current dev Hosts expose Typert Remote endpoints rather than the legacy
    // dot-separated Fetch routes. Adapt after authentication so the mobile
    // wire remains stable while the call still traverses NATS and Gateway.
    if (this.options.gateway !== undefined) {
      if (method === 'host.describe' && this.options.onHostDescribe !== undefined) {
        const value = await this.options.onHostDescribe()
        msg.respond(new TextEncoder().encode(serverResult(id, value)))
        return
      }
      if (method === 'workspace.list' && this.options.onWorkspaceList !== undefined) {
        const value = await this.options.onWorkspaceList()
        msg.respond(new TextEncoder().encode(serverResult(id, value)))
        return
      }
      const payload = envelope.payload
      try {
        if (method === 'file.watch') {
          const request = isRecord(payload) ? payload : {}
          if (typeof request.sessionId !== 'string' || this.options.onFileWatch === undefined) {
            msg.respond(new TextEncoder().encode(gateFailure(rpcId, 'mobile-forbidden')))
            return
          }
          this.options.onFileWatch(request.sessionId, watchPath(request))
          msg.respond(new TextEncoder().encode(serverResult(id, { watching: true })))
          return
        }
        if (method === 'file.unwatch') {
          const request = isRecord(payload) ? payload : {}
          // Releasing is best-effort: an unknown Session or an absent hook must
          // not fail the caller that is merely closing its browser.
          if (typeof request.sessionId === 'string') this.options.onFileUnwatch?.(request.sessionId, watchPath(request))
          msg.respond(new TextEncoder().encode(serverResult(id, { watching: false })))
          return
        }
        if (method === 'session.history' || method === 'subagent.history') {
          const request = isRecord(payload) ? payload : {}
          const address = addressFromHistory(method, request)
          const key = addressKey(address)
          this.options.onSessionSeen?.(address)
          this.options.onSessionOpened?.(sessionAddressTarget(address))
          const beforeSeq = typeof request.beforeSeq === 'number' ? request.beforeSeq : undefined
          if (beforeSeq !== undefined) {
            let throughSeq = this.historyCursors.get(key)
            if (throughSeq === undefined) {
              const opening = await this.options.gateway.stream({
                namespace: 'session', method: 'follow',
                args: { request: { address, maxMessages: 1 } },
              })
              const first = await firstValue(opening)
              if (!isRecord(first) || first.type !== 'snapshot' || typeof first.cursor !== 'number') {
                throw new Error('session follow did not provide a cursor')
              }
              throughSeq = first.cursor
              this.rememberCursor(key, throughSeq)
            }
            const page = await this.options.gateway.invoke({
              namespace: 'session', method: 'page',
              args: { request: { address, throughSeq, beforeSeq, maxMessages: request.maxMessages } },
            })
            const target = sessionAddressTarget(address)
            msg.respond(new TextEncoder().encode(serverResult(id, pageValue(page, this.projector(target)))))
            return
          }
          const stream = await this.options.gateway.stream({
            namespace: 'session', method: 'follow',
            args: { request: { address, maxMessages: request.maxMessages } },
          })
          const first = await firstValue(stream)
          if (isRecord(first) && typeof first.cursor === 'number') this.rememberCursor(key, first.cursor)
          msg.respond(new TextEncoder().encode(serverResult(id, historyValue(first, this.projector(sessionAddressTarget(address))))))
          return
        }
        if (method === 'subagent.list') {
          const request = isRecord(payload) ? payload : {}
          const parentSessionId = typeof request.parentSessionId === 'string' ? request.parentSessionId : ''
          msg.respond(new TextEncoder().encode(serverResult(id, await this.subagentCatalog(parentSessionId))))
          return
        }
        if (method === 'respond') {
          const accepted = await this.options.onRespond?.(id, envelope.result) ?? false
          // The card the App is holding may belong to an earlier generation:
          // publish the resolution it missed so it cannot stay unanswerable.
          if (!accepted) this.options.onStaleRespond?.(id, envelope.result)
          msg.respond(new TextEncoder().encode(JSON.stringify(accepted
            ? { accepted: true }
            : { accepted: false, reason: 'not-pending' })))
          return
        } else {
          const call = remoteCall(method, payload, id)
          if (call !== null) {
            const value = await this.invokeRemote(call, method, payload, id)
            if (method === 'session.list' && isRecord(value) && Array.isArray(value.items)) {
              for (const item of value.items) {
                if (isRecord(item) && typeof item.sessionId === 'string') {
                  this.options.onSessionSeen?.({ kind: 'session', sessionId: item.sessionId })
                }
              }
            } else if (method === 'session.create' && isRecord(value) && typeof value.sessionId === 'string') {
              this.options.onSessionSeen?.({ kind: 'session', sessionId: value.sessionId })
            } else if (method === 'session.prompt' && isRecord(payload) && typeof payload.sessionId === 'string') {
              this.options.onSessionSeen?.({ kind: 'session', sessionId: payload.sessionId })
            }
            const normalized = method === 'session.models' && isRecord(value)
              ? {
                current: value.default,
                routable: Array.isArray(value.routableProviders) ? value.routableProviders.length > 0 : false,
                groups: value.groups ?? [],
                failures: value.failures ?? [],
              }
              : method === 'command.list' && Array.isArray(value)
                ? { commands: value }
                : method === 'agentPreset.select' && typeof value === 'string'
                  ? { agentPreset: value }
                  : method === 'file.bytes' || method === 'file.related'
                    ? fileBytesValue(value)
              : value
            msg.respond(new TextEncoder().encode(serverResult(id, normalized)))
            return
          }
        }
      } catch (error: unknown) {
        msg.respond(new TextEncoder().encode(serverFailure(id, this.options.gateway.wireStream.failure(error))))
        return
      }
    }

    if (this.options.carrier === undefined) {
      msg.respond(new TextEncoder().encode(gateFailure(rpcId, 'mobile-forbidden')))
      return
    }

    const request = new Request(`http://mobile.internal/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      duplex: 'half',
      body,
    })
    const response = await this.options.carrier.fetch(request)
    const bytes = new Uint8Array(await response.arrayBuffer())
    msg.respond(bytes)
  }

  /**
   * Invoke one mapped Remote call, retrying the pre-0.1.7 argument shape when
   * a Host rejects the current one.
   *
   * dsh 0.1.7 moved the `readBytes` window under `options` and folded
   * `readRelated` into it, so the two file-read mappings are the only ones
   * carrying a legacy shape. A Host that predates the change answers
   * `gateway/arguments-invalid` or `gateway/invocation-unavailable`; anything
   * else (a missing file, an oversized page) is a real failure and surfaces
   * unchanged.
   * @param call - the current Remote call for this mobile method.
   * @param method - mobile method name, used to pick the legacy shape.
   * @param payload - original mobile payload.
   * @param rpcId - correlation id the prompt-RPC-identity args reuse.
   * @returns the Remote value from whichever shape this Host accepts.
   */
  private async invokeRemote(call: RemoteCall, method: string, payload: unknown, rpcId: string): Promise<unknown> {
    const gateway = this.options.gateway
    if (gateway === undefined) throw new Error('host gateway unavailable')
    try {
      return await gateway.invoke(call)
    } catch (error: unknown) {
      const legacy = legacyRemoteCall(method, payload, rpcId)
      if (legacy === null) throw error
      const code = gateway.wireStream.failure(error).code
      if (code !== 'gateway/arguments-invalid' && code !== 'gateway/invocation-unavailable') throw error
      return await gateway.invoke(legacy)
    }
  }

  /**
   * The direct-child catalog the mobile wire expects, derived from the sources
   * dsh 0.1.7 still publishes.
   *
   * 0.1.7 removed the `subagents/list` Remote: a parent now owns its children
   * as the durable `subagentCatalog` projection, readable without activating
   * either side through `session/projections`. The App's frozen catalog also
   * shows each child's liveness and whether it has children of its own, which
   * no projection carries, so those come from the Session list the same
   * generation answers with. A Host older than 0.1.7 still serves
   * `subagents/list`, and only that call failing as an unknown endpoint falls
   * back to it.
   * @param parentSessionId - Session whose direct children are requested.
   * @returns the catalog the App's frozen wire describes.
   */
  private async subagentCatalog(parentSessionId: string): Promise<unknown> {
    const gateway = this.options.gateway
    if (gateway === undefined) throw new Error('host gateway unavailable')
    if (parentSessionId === '') return { entries: [], parentAvailable: false }
    try {
      const [projection, sessions] = await Promise.all([
        gateway.invoke({
          namespace: 'session', method: 'projections',
          args: { request: { sessionId: parentSessionId } },
        }),
        gateway.invoke({ namespace: 'session', method: 'list', args: { _request: {} } }),
      ])
      return subagentCatalogValue(parentSessionId, projection, sessions)
    } catch (error: unknown) {
      const code = gateway.wireStream.failure(error).code
      if (code !== 'gateway/arguments-invalid' && code !== 'gateway/invocation-unavailable') throw error
      return await gateway.invoke({
        namespace: 'subagents', method: 'list', args: { parentSessionId },
      })
    }
  }
}
