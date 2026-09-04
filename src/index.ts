/**
 * dsh-mobile-plugin — Cordis plugin bridging the host ApiProxy to NATS.
 *
 * Runs inside the dsh `web` profile, connects to the machine-local NATS Leaf
 * node, and exposes the harness `/api` protocol on `svc.dsh.{instance}.>` /
 * `evt.dsh.{instance}.*` subjects behind a device-token gate and a method
 * whitelist. Configuration lives in the `mobile-bridge` settings namespace;
 * the loopback console (settings card iframe / standalone page) drives the
 * onboarding wizard. See docs/00-plugin-plan.md.
 */
import { homedir } from 'node:os'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { connect, type NatsConnection } from 'nats'
import { Context, Service } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { Config } from './config.js'
import { TokenStore, type DeviceEntry } from './tokens.js'
import { PLUGIN_FEATURES, PLUGIN_MOBILE_API, PLUGIN_VERSION, RpcBridge } from './bridge.js'
import { EventBridge, GatewayEventAdapter } from './events.js'
import { registerConsoleRoutes, type WebRouter } from './console.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    mobileBridge: MobileBridge
  }
}

export type { Config } from './config.js'
export { TokenStore } from './tokens.js'
export type { DeviceEntry } from './tokens.js'

/** Settings namespace the card/console edit; declared once for both halves. */
export const SETTINGS_NS = 'mobile-bridge'

type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

const PLUGIN_LOADED_FROM = fileURLToPath(import.meta.url)
const PLUGIN_BUILD_ID = process.env.DSH_MOBILE_PLUGIN_BUILD_ID
  ?? `${PLUGIN_VERSION}-${Math.trunc(statSync(PLUGIN_LOADED_FROM).mtimeMs).toString(36)}`

export interface PairingPayload {
  hub: string
  user: string
  pass: string
  instance: string
  caFp: string
  code: string
}

/** Structural view of the host settings service (scope surface we consume). */
interface SettingsScope {
  get(): Config
  watch(listener: () => void): void
  update(patch: object): Promise<void>
}

interface SettingsService {
  register(ns: string, schema: unknown, options: { base: Config }): SettingsScope
}

function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function sameConfig(left: Config, right: Config): boolean {
  return left.natsUrl === right.natsUrl
    && left.hubWssUrl === right.hubWssUrl
    && left.hubUser === right.hubUser
    && left.hubPass === right.hubPass
    && left.hubCaFingerprint === right.hubCaFingerprint
    && left.instanceId === right.instanceId
    && left.tokenTtlDays === right.tokenTtlDays
    && left.pairCodeTtlSec === right.pairCodeTtlSec
    && left.maxDevices === right.maxDevices
    && left.chunkCoalesceMs === right.chunkCoalesceMs
}

export class MobileBridge extends Service {
  static Config = Config
  static inject = ['connection', 'typertGateway']

  private nc: NatsConnection | null = null
  private rpcBridge: RpcBridge | null = null
  private eventBridge: EventBridge | null = null
  private connectionStatus: ConnectionStatus = 'disconnected'
  private reconnectWatchdog: ReturnType<typeof setTimeout> | null = null
  private bridgeStartedAt: string | null = null
  private lastConnectedAt: string | null = null
  private lastReconnectAt: string | null = null
  private lastError: string | null = null
  private readonly streamErrors = new Map<string, string>()
  private readonly tokens: TokenStore
  /** A process started from the local console. NATS is a host service, so it
   * intentionally survives bridge restarts and is never killed by stop(). */
  private localNatsProcess: ChildProcess | null = null
  private current: Config
  /** Serializes start/stop/restart: concurrent triggers (boot effect + settings
   *  watch) must never overlap, or a duplicate NATS connection + RPC
   *  subscription leaks and every request gets two answers. */
  private lifecycle: Promise<void> = Promise.resolve()
  private wantRunning = false

  constructor(ctx: Context, entryConfig: Config) {
    super(ctx, 'mobileBridge')
    this.current = entryConfig
    this.tokens = new TokenStore(join(dshHome(), 'mobile-bridge', 'tokens.json'))

    // Settings layering: user document over the composition entry; changes
    // rebuild the bridge stack. Works headless too (no settings provider =
    // the entry config stays authoritative).
    ctx.inject(['settings'], (sctx) => {
      const settings = sctx.get('settings') as unknown as SettingsService
      const scope = settings.register(SETTINGS_NS, Config, { base: entryConfig })
      this.settingsScope = scope
      this.applyConfig(scope.get())
      scope.watch(() => {
        this.applyConfig(scope.get())
      })
    })

    // Loopback console routes when a webserver is in the composition (web profile).
    ctx.inject(['webServer'], (sctx) => {
      const webServer = sctx.get('webServer') as unknown as WebRouter
      return registerConsoleRoutes(webServer, {
        bridge: () => this,
        currentConfig: () => this.current,
        updateConfig: patch => this.updateConfig(patch),
        startNats: () => this.startLocalNats(),
      })
    })

    ctx.effect(() => {
      this.wantRunning = true
      void this.kick()
      return () => {
        this.wantRunning = false
        return this.kick()
      }
    })
  }

  private settingsScope: SettingsScope | null = null

  /** Effective config (settings user layer over the composition entry). */
  get activeConfig(): Config {
    return this.current
  }

  /** Persist a config patch through the settings user layer; falls back to
   * in-memory when no settings provider is mounted (headless dev). */
  async updateConfig(patch: Partial<Config>): Promise<void> {
    if (this.settingsScope !== null) {
      await this.settingsScope.update(patch)
      return // the scope watcher rebuilds
    }
    const next = { ...this.current, ...patch }
    if (sameConfig(this.current, next)) return
    this.current = next
    if (this.wantRunning) await this.restart()
  }

  private applyConfig(next: Config): void {
    if (sameConfig(this.current, next)) return
    this.current = next
    if (this.wantRunning) void this.restart()
  }

  // ---- service surface for the settings card / CLI ----

  status(): {
    connection: ConnectionStatus
    devices: number
    pluginVersion: string
    mobileApi: number
    features: readonly string[]
    buildId: string
    loadedFrom: string
    instanceId: string
    startedAt: string | null
    uptimeMs: number
    lastConnectedAt: string | null
    lastReconnectAt: string | null
    lastError: string | null
  } {
    return {
      connection: this.connectionStatus,
      devices: this.tokens.activeCount(),
      pluginVersion: PLUGIN_VERSION,
      mobileApi: PLUGIN_MOBILE_API,
      features: PLUGIN_FEATURES,
      buildId: PLUGIN_BUILD_ID,
      loadedFrom: PLUGIN_LOADED_FROM,
      instanceId: this.current.instanceId,
      startedAt: this.bridgeStartedAt,
      uptimeMs: this.bridgeStartedAt === null ? 0 : Math.max(0, Date.now() - Date.parse(this.bridgeStartedAt)),
      lastConnectedAt: this.lastConnectedAt,
      lastReconnectAt: this.lastReconnectAt,
      lastError: this.lastError,
    }
  }

  listDevices(): Omit<DeviceEntry, 'tokenHash'>[] {
    return this.tokens.list()
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    return this.tokens.revoke(deviceId)
  }

  /** Start the machine-local NATS Leaf used by this bridge. */
  async startLocalNats(): Promise<{ ok: boolean, message: string }> {
    if (this.localNatsProcess !== null
      && this.localNatsProcess.exitCode === null
      && !this.localNatsProcess.killed) {
      return { ok: true, message: '本地 NATS 已在运行（由插件启动）' }
    }

    const command = process.env.NATS_SERVER_PATH
      ?? (process.platform === 'win32'
        ? (existsSync('C:\\nats-server\\nats-server.exe') ? 'C:\\nats-server\\nats-server.exe' : 'nats-server.exe')
        : 'nats-server')
    const configPath = process.env.NATS_CONFIG_PATH
      ?? (process.platform === 'win32' ? 'C:\\nats\\leaf.conf' : '/etc/nats/leaf.conf')
    if (!existsSync(configPath)) {
      return { ok: false, message: `找不到 NATS 配置文件：${configPath}` }
    }

    let child: ChildProcess
    try {
      child = spawn(command, ['-c', configPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (error) {
      return { ok: false, message: `启动 NATS 失败：${String(error)}` }
    }
    this.localNatsProcess = child
    child.once('exit', () => {
      if (this.localNatsProcess === child) this.localNatsProcess = null
    })

    // A missing executable is reported by spawn() on the next turn. Give the
    // error a short window to arrive without blocking the web request.
    const spawnError = await new Promise<Error | null>(resolve => {
      let settled = false
      const finish = (error: Error | null) => {
        if (settled) return
        settled = true
        resolve(error)
      }
      child.once('error', finish)
      setTimeout(() => finish(null), 250)
    })
    child.unref()
    if (spawnError !== null) {
      if (this.localNatsProcess === child) this.localNatsProcess = null
      return { ok: false, message: `启动 NATS 失败：${spawnError.message}` }
    }
    if (child.exitCode !== null) {
      if (this.localNatsProcess === child) this.localNatsProcess = null
      return { ok: false, message: `NATS 已退出（代码 ${child.exitCode}），请检查配置文件：${configPath}` }
    }
    return { ok: true, message: `NATS 启动命令已执行（配置：${configPath}），正在连接…` }
  }

  /**
   * Mint a pairing code and assemble the QR payload. Local-only by design:
   * reachable through the loopback console and this service, never via NATS.
   */
  createPairingQr(): { code: string, expiresAt: number, payload: PairingPayload } {
    const { code, expiresAt } = this.tokens.createPairingCode(this.current.pairCodeTtlSec)
    return {
      code,
      expiresAt,
      payload: {
        hub: this.current.hubWssUrl,
        user: this.current.hubUser,
        pass: this.current.hubPass,
        instance: this.current.instanceId,
        caFp: this.current.hubCaFingerprint,
        code,
      },
    }
  }

  // ---- lifecycle ----

  /** Enqueue a lifecycle transition; transitions run one at a time. */
  private kick(): Promise<void> {
    this.lifecycle = this.lifecycle.then(() => this.cycle())
    return this.lifecycle
  }

  private async cycle(): Promise<void> {
    try {
      if (this.wantRunning && this.nc === null) {
        await this.start()
      } else if (!this.wantRunning) {
        await this.stop()
      }
    } catch (error) {
      this.connectionStatus = 'disconnected'
      this.lastError = error instanceof Error ? error.message : String(error)
      console.error('[mobile-bridge] failed to start:', this.lastError)
    }
  }

  private restart(): Promise<void> {
    // Rebuild with the current config: stop then start, serialized.
    this.lifecycle = this.lifecycle.then(async () => {
      if (!this.wantRunning) return
      try {
        await this.stop()
        await this.start()
      } catch (error) {
        this.connectionStatus = 'disconnected'
        this.lastError = error instanceof Error ? error.message : String(error)
        console.error('[mobile-bridge] failed to restart:', this.lastError)
      }
    })
    return this.lifecycle
  }

  private async start(): Promise<void> {
    await this.tokens.load()
    this.connectionStatus = 'connecting'
    this.bridgeStartedAt = new Date().toISOString()
    this.lastError = null
    this.streamErrors.clear()

    // waitOnFirstConnect: a missing Leaf must not reject the plugin's fiber;
    // nats.js retries in the background and the status surface reports it.
    const nc = await connect({ servers: this.current.natsUrl, waitOnFirstConnect: true })
    try {
      await nc.flush()
    } catch (error) {
      await nc.close().catch(() => undefined)
      throw error
    }
    this.nc = nc
    this.connectionStatus = 'connected'
    this.lastConnectedAt = new Date().toISOString()
    console.info('[mobile-bridge] started', {
      pluginVersion: PLUGIN_VERSION,
      mobileApi: PLUGIN_MOBILE_API,
      buildId: PLUGIN_BUILD_ID,
      loadedFrom: PLUGIN_LOADED_FROM,
      instanceId: this.current.instanceId,
      features: PLUGIN_FEATURES,
    })
    void this.trackStatus(nc)

    // Both services are guaranteed by static inject.
    const connection = this.ctx.get('connection') as unknown as HostConnectionHandle
    const gateway = this.ctx.get('typertGateway') as unknown as TypertGateway
    const sharedHandler = connection.createSharedFetchHandler('/api')
    const carrier = { fetch: (request: Request) => sharedHandler.fetch(request) }
    const eventAdapter = new GatewayEventAdapter(
      gateway,
      carrier,
      (name, error) => this.setStreamError(name, error),
      name => this.clearStreamError(name),
    )
    this.eventBridge = new EventBridge(nc, eventAdapter, {
      instanceId: this.current.instanceId,
      coalesceMs: this.current.chunkCoalesceMs,
    })
    this.eventBridge.start()

    this.rpcBridge = new RpcBridge(nc, {
      instanceId: this.current.instanceId,
      carrier,
      gateway,
      tokens: this.tokens,
      tokenTtlDays: this.current.tokenTtlDays,
      maxDevices: this.current.maxDevices,
      onHello: () => this.eventBridge?.replayPending(),
      onInventory: async () => gateway.invoke({ namespace: 'pluginInventory', method: 'list', args: {} }).catch(() => null),
      onHealth: () => ({ status: 'ok', ...this.status() }),
      onHostDescribe: async () => {
        const sessions = await gateway.invoke({
          namespace: 'session', method: 'list', args: { _request: {} },
        }).catch(() => ({ items: [] }))
        return {
          version: process.env.npm_package_version ?? 'dev',
          cwd: process.cwd(),
          attachedSessions: typeof sessions === 'object' && sessions !== null
            && Array.isArray((sessions as { items?: unknown }).items)
            ? (sessions as { items: unknown[] }).items.length
            : 0,
          home: homedir(),
          canOpenPath: false,
        }
      },
      onWorkspaceList: () => eventAdapter.workspaceSnapshot(),
      onSessionSeen: address => eventAdapter.watchSession(address),
      onRespond: (rpcId, result) => eventAdapter.respond(rpcId, result),
    })
    this.rpcBridge.start()
  }

  private async stop(): Promise<void> {
    this.clearReconnectWatchdog()
    await this.rpcBridge?.stop()
    await this.eventBridge?.stop()
    this.rpcBridge = null
    this.eventBridge = null
    if (this.nc !== null) {
      // drain() can hang on a wedged socket (the very case the watchdog
      // rebuilds from); bound it so the lifecycle never stalls.
      await Promise.race([
        this.nc.drain(),
        new Promise<void>(resolve => setTimeout(resolve, 2000)),
      ]).catch(() => {})
      this.nc = null
    }
    this.connectionStatus = 'disconnected'
  }

  private async trackStatus(nc: NatsConnection): Promise<void> {
    try {
      for await (const status of nc.status()) {
        if (status.type === 'disconnect') {
          this.connectionStatus = 'reconnecting'
          this.armReconnectWatchdog(nc)
        } else if (status.type === 'reconnect') {
          try {
            await nc.flush()
          } catch (error) {
            if (this.nc === nc) {
              this.connectionStatus = 'reconnecting'
              this.lastError = error instanceof Error ? error.message : String(error)
              this.armReconnectWatchdog(nc)
            }
            continue
          }
          if (this.nc !== nc) return
          this.connectionStatus = 'connected'
          this.lastConnectedAt = new Date().toISOString()
          this.lastReconnectAt = this.lastConnectedAt
          this.lastError = Array.from(this.streamErrors.values()).at(-1) ?? null
          this.clearReconnectWatchdog()
        }
      }
    } catch {
      // status iterator ends when the connection closes; lifecycle owns that path
    }
  }

  /**
   * nats.js 2.29.x can wedge in a silent 'reconnecting' state after a hard
   * server kill (verified 2026-08-27: socket RST → perpetual reconnecting
   * status, never re-dials, subscriptions never resubscribe). A fresh
   * connect() recovers immediately, so if no 'reconnect' lands within the
   * window, rebuild the whole stack through the serialized lifecycle.
   */
  private armReconnectWatchdog(nc: NatsConnection): void {
    this.clearReconnectWatchdog()
    this.reconnectWatchdog = setTimeout(() => {
      this.reconnectWatchdog = null
      if (this.nc !== nc || !this.wantRunning) return
      console.warn('[mobile-bridge] reconnect watchdog fired; rebuilding NATS stack')
      void this.restart()
    }, 10_000)
  }

  private clearReconnectWatchdog(): void {
    if (this.reconnectWatchdog !== null) {
      clearTimeout(this.reconnectWatchdog)
      this.reconnectWatchdog = null
    }
  }

  private setStreamError(name: string, error: unknown): void {
    const message = `${name}: ${error instanceof Error ? error.message : String(error)}`
    this.streamErrors.delete(name)
    this.streamErrors.set(name, message)
    this.lastError = message
  }

  private clearStreamError(name: string): void {
    const message = this.streamErrors.get(name)
    if (message === undefined) return
    this.streamErrors.delete(name)
    if (this.lastError === message) {
      this.lastError = Array.from(this.streamErrors.values()).at(-1) ?? null
    }
  }
}

export default MobileBridge
