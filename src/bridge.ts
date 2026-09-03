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
  'workspace.insertBefore',
  'workspace.insertSessionBefore',
  'session.list',
  'session.create',
  'session.history',
  'session.attachment',
  'session.prompt',
  'session.cancel',
  'session.updateQueue',
  'session.rename',
  'session.fork',
  'session.models',
  'session.selectModel',
  'session.search',
  'command.list',
  'command.execute',
  'skill.list',
  'goal.create',
  'goal.edit',
  'goal.pause',
  'goal.resume',
  'goal.complete',
  'goal.clear',
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
export const PLUGIN_VERSION = '0.2.0'
export const PLUGIN_MOBILE_API = 1
export const PLUGIN_FEATURES = [
  'plus-menu',
  'command-directory',
  'multi-image',
  'durable-attachment-order',
  'plugin-inventory',
  'health-check',
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
  onInventory?: () => unknown
  /** Authenticated operational snapshot for mobile connection diagnostics. */
  onHealth?: () => unknown
  /** Host facts removed from the current unary Remote surface. */
  onHostDescribe?: () => unknown | Promise<unknown>
  onWorkspaceList?: () => unknown | Promise<unknown>
  /** Called when an ordinary Session becomes relevant to the mobile client. */
  onSessionSeen?: (sessionId: string) => void
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
  'skill.list',
])

/** Translate the frozen mobile v1 method/payload vocabulary to current Remote args. */
function remoteCall(method: string, payload: unknown, rpcId: string): RemoteCall | null {
  const request = isRecord(payload) ? payload : {}
  if (method === 'session.list') return { namespace: 'session', method: 'list', args: { _request: request } }
  if (method === 'session.prompt') {
    return { namespace: 'session', method: 'prompt', args: { request: { requestId: rpcId, ...request } } }
  }
  if (method === 'session.models') return { namespace: 'session', method: 'modelCatalog', args: {} }
  if (method === 'agentPreset.list') return { namespace: 'agentPresets', method: 'list', args: {} }
  if (method === 'agentPreset.read') return { namespace: 'agentPresets', method: 'read', args: request }
  if (method === 'agentPreset.select') {
    return { namespace: 'agentPresets', method: 'select', args: request }
  }
  if (method === 'subagent.list') return { namespace: 'subagents', method: 'list', args: request }
  if (method === 'subagent.prompt') {
    return { namespace: 'subagents', method: 'prompt', args: { request: { requestId: rpcId, ...request } } }
  }
  if (method === 'subagent.interrupt') {
    return { namespace: 'subagents', method: 'interruptByParent', args: request }
  }
  if (method.startsWith('goal.')) {
    return { namespace: 'goals', method: method.slice('goal.'.length), args: request }
  }
  if (DIRECT_REQUEST_METHODS.has(method)) {
    const [namespace, name] = method.split('.') as [string, string]
    const actualNamespace = namespace === 'skill' ? 'skills' : namespace
    return { namespace: actualNamespace, method: name, args: { request } }
  }
  return null
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

function historyValue(snapshot: unknown): unknown {
  if (!isRecord(snapshot) || snapshot.type !== 'snapshot') {
    throw new Error('session follow did not begin with a snapshot')
  }
  const records = Array.isArray(snapshot.records) ? snapshot.records : []
  return {
    events: records.flatMap((record) => {
      if (!isRecord(record) || !isRecord(record.event)) return []
      return [{ event: record.event }]
    }),
    hasMore: snapshot.hasMore === true,
    ...(isRecord(snapshot.projections) ? { projections: snapshot.projections } : {}),
  }
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

export class RpcBridge {
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
      const redeemed = await this.options.tokens.redeemPairingCode(
        String(payload?.code ?? ''),
        String(payload?.deviceName ?? ''),
        this.options.tokenTtlDays,
        this.options.maxDevices,
      )
      msg.respond(new TextEncoder().encode(pairResult(rpcId, redeemed)))
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
      const inventory = this.options.onInventory?.()
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
        if (method === 'session.history') {
          const request = isRecord(payload) ? payload : {}
          const sessionId = String(request.sessionId ?? '')
          this.options.onSessionSeen?.(sessionId)
          const stream = await this.options.gateway.stream({
            namespace: 'session', method: 'follow',
            args: { request: { address: { kind: 'session', sessionId }, maxMessages: request.maxMessages } },
          })
          const first = await firstValue(stream)
          msg.respond(new TextEncoder().encode(serverResult(id, historyValue(first))))
          return
        }
        if (method === 'respond') {
          // Client responses to approval/question waterfalls are still owned by
          // the Gateway's special $events/result endpoint; the legacy carrier
          // knows how to preserve its exact envelope.
          if (this.options.carrier === undefined) throw new Error('response carrier unavailable')
        } else {
          const call = remoteCall(method, payload, id)
          if (call !== null) {
            const value = await this.options.gateway.invoke(call)
            if (method === 'session.list' && isRecord(value) && Array.isArray(value.items)) {
              for (const item of value.items) {
                if (isRecord(item) && typeof item.sessionId === 'string') this.options.onSessionSeen?.(item.sessionId)
              }
            } else if (method === 'session.create' && isRecord(value) && typeof value.sessionId === 'string') {
              this.options.onSessionSeen?.(value.sessionId)
            } else if (method === 'session.prompt' && isRecord(payload) && typeof payload.sessionId === 'string') {
              this.options.onSessionSeen?.(payload.sessionId)
            }
            const normalized = method === 'session.models' && isRecord(value)
              ? {
                current: value.default,
                routable: Array.isArray(value.routableProviders) ? value.routableProviders.length > 0 : false,
                groups: value.groups ?? [],
                failures: value.failures ?? [],
              }
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
}
