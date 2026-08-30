/**
 * RPC bridge: NATS request-reply on `svc.dsh.{instance}.>` to the in-process
 * ApiProxy via its fetch carrier. Token gate and method whitelist run before
 * any dispatch. Pairing (`pair`) and the reconnect hook (`hello`) are answered
 * by the plugin itself, everything else forwards verbatim.
 */
import type { Msg, NatsConnection } from 'nats'
import type { TokenStore } from './tokens.js'

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

export const TOKEN_HEADER = 'x-dsh-token'

/** Fetch carrier for the host ApiProxy (toFetchHandler shape). */
export interface FetchCarrier {
  fetch: typeof fetch
}

export interface BridgeOptions {
  instanceId: string
  carrier: FetchCarrier
  tokens: TokenStore
  tokenTtlDays: number
  maxDevices: number
  /** Re-publish pending answerable frames to a reconnecting app. */
  onHello: () => void
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

    if (!ALLOWED_METHODS.has(method)) {
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
