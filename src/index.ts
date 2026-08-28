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
import { join } from 'node:path'
import { connect, type NatsConnection } from 'nats'
import { Context, Service } from '@deepseek-ai/cordis'
import { toFetchHandler, type HostApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { Config } from './config.js'
import { TokenStore, type DeviceEntry } from './tokens.js'
import { RpcBridge } from './bridge.js'
import { EventBridge, type EventStreams } from './events.js'
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

export class MobileBridge extends Service {
  static Config = Config
  static inject = ['apiProxy']

  private nc: NatsConnection | null = null
  private rpcBridge: RpcBridge | null = null
  private eventBridge: EventBridge | null = null
  private connectionStatus: ConnectionStatus = 'disconnected'
  private reconnectWatchdog: ReturnType<typeof setTimeout> | null = null
  private readonly tokens: TokenStore
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
      scope.watch(() => {
        this.current = scope.get()
        void this.restart()
      })
      this.current = scope.get()
      this.settingsScope = scope
      void this.restart()
    })

    // Loopback console routes when a webserver is in the composition (web profile).
    ctx.inject(['webServer'], (sctx) => {
      const webServer = sctx.get('webServer') as unknown as WebRouter
      return registerConsoleRoutes(webServer, {
        bridge: () => this,
        currentConfig: () => this.current,
        updateConfig: patch => this.updateConfig(patch),
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
    this.current = { ...this.current, ...patch }
    await this.restart()
  }

  // ---- service surface for the settings card / CLI ----

  status(): { connection: ConnectionStatus, devices: number } {
    return { connection: this.connectionStatus, devices: this.tokens.list().length }
  }

  listDevices(): Omit<DeviceEntry, 'tokenHash'>[] {
    return this.tokens.list()
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    return this.tokens.revoke(deviceId)
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
    } catch {
      this.connectionStatus = 'disconnected'
    }
  }

  private restart(): Promise<void> {
    // Rebuild with the current config: stop then start, serialized.
    this.lifecycle = this.lifecycle.then(async () => {
      if (!this.wantRunning) return
      try {
        await this.stop()
        await this.start()
      } catch {
        this.connectionStatus = 'disconnected'
      }
    })
    return this.lifecycle
  }

  private async start(): Promise<void> {
    await this.tokens.load()
    this.connectionStatus = 'connecting'

    // waitOnFirstConnect: a missing Leaf must not reject the plugin's fiber;
    // nats.js retries in the background and the status surface reports it.
    const nc = await connect({ servers: this.current.natsUrl, waitOnFirstConnect: true })
    this.nc = nc
    this.connectionStatus = 'connected'
    void this.trackStatus(nc)

    // The apiProxy service is guaranteed by static inject.
    const apiProxy = this.ctx.get('apiProxy') as unknown as HostApiProxy
    const carrier = toFetchHandler(apiProxy)

    this.eventBridge = new EventBridge(nc, apiProxy as EventStreams, {
      instanceId: this.current.instanceId,
      coalesceMs: this.current.chunkCoalesceMs,
    })
    this.eventBridge.start()

    this.rpcBridge = new RpcBridge(nc, {
      instanceId: this.current.instanceId,
      carrier,
      tokens: this.tokens,
      tokenTtlDays: this.current.tokenTtlDays,
      maxDevices: this.current.maxDevices,
      onHello: () => this.eventBridge?.replayPending(),
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
          this.connectionStatus = 'connected'
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
}

export default MobileBridge
