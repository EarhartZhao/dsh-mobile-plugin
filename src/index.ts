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
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { connect, type NatsConnection } from 'nats'
import { Context, Service } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { Config, configValues, type ConfigInput } from './config.js'
import { readHubCa, sameFingerprint } from './hub-ca.js'
import { readInstalledVersion } from './installed-version.js'
import { normalizeHubWssUrl } from './hub-check.js'
import { TokenStore, type DeviceEntry } from './tokens.js'
import { PLUGIN_FEATURES, PLUGIN_MOBILE_API, PLUGIN_VERSION, RpcBridge } from './bridge.js'
import { EventBridge, GatewayEventAdapter } from './events.js'
import { ToolViews, type ToolRegistryLike } from './tool-views.js'
import { registerConsoleRoutes, type WebRouter } from './console.js'
import { natsEndpoint, probePort, resolveLeafConfig, resolveNatsServer, type LocalNatsResolution } from './nats-launch.js'
import {
  migrateProfile,
  needsRepair,
  readProfileDependency,
  readProfileShape,
  type ProfileIdentifiers,
  type ProfileLocation,
  type ProfileShape,
} from './profile-migration.js'
import { fetchLatestRegistryVersion, fetchLatestTag, isNewerVersion, parseUpdateSource, updateSpec } from './update.js'

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

/** Profile package and composition entry this plugin installs itself as. */
export const PLUGIN_PACKAGE_NAME = '@dsh-earhartzhao/dsh-mobile-plugin'
export const PLUGIN_ROW_ID = 'mobile-bridge'

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
  /**
   * The Hub's CA certificate as base64 DER, when one is configured. The App
   * installs it as the trust anchor for `hub` before dialling, which is what
   * makes the QR — not the App build — the source of TLS trust.
   */
  ca?: string
  code: string
}

/**
 * Assembles the QR payload, certificate included.
 *
 * The certificate is the phone's trust anchor and the fingerprint is what it
 * shows the user, so a contradiction between the two has to stop here rather
 * than become a scan that dies on the phone with nothing to read. Exported for
 * the tests: minting a code needs a live token store, this does not.
 */
export function buildPairingPayload(config: Config, code: string): PairingPayload {
  const ca = readHubCa(config.hubCaCert)
  const configuredFingerprint = typeof config.hubCaFingerprint === 'string' ? config.hubCaFingerprint.trim() : ''
  if (ca !== null && configuredFingerprint !== '' && !sameFingerprint(configuredFingerprint, ca.fingerprint)) {
    throw new Error(
      `CA 证书与配置的指纹不一致：证书指纹是 ${ca.fingerprint}，配置里写的是 ${configuredFingerprint}。`
      + '两者必须一致，否则手机扫码时会拒绝这个 Hub。',
    )
  }
  return {
    // Normalized here as well: a hand-edited profile patch may hold a bare host,
    // and the phone dials exactly what the QR carries.
    hub: normalizeHubWssUrl(config.hubWssUrl),
    user: config.hubUser,
    pass: config.hubPass,
    instance: config.instanceId,
    caFp: ca === null ? config.hubCaFingerprint : ca.fingerprint,
    ...(ca === null ? {} : { ca: ca.base64 }),
    code,
  }
}

/**
 * Structural view of the host settings service (the surface we consume).
 *
 * The service derives one namespace per profile entry from the entry's Config
 * schema; a field is writable exactly when the schema declares it `.volatile()`
 * (see src/config.ts). `configure({ auto: false })` keeps this instance off the
 * generated page — the loopback console is the form.
 */
interface SettingsService {
  configure(presentation: { auto?: boolean }, owner?: unknown): () => void
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
}

/** Structural view of the launcher-owned profile facts (`ctx.profileContext`). */
interface ProfileContextLike {
  dir: string
  patchPath: string
  /** Bundles this process was started with, before any persisted edits. */
  startedBundles: readonly string[]
}

/**
 * Structural view of the host's plugin manager (`ctx.pluginManager`) — the
 * service behind the Plugins page. The update button hands it the spec the
 * profile already declares, so pnpm resolves and builds the package exactly as
 * it did on install; nothing here downloads or unpacks anything itself.
 */
interface PluginManagerLike {
  installBundle(spec: string, options?: {
    enabled?: boolean
    requestId?: string
  }): Promise<PluginChangeResult>
}

/** The part of the manager's result this plugin reports. */
interface PluginChangeResult {
  application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  error?: { code?: string, diagnostic?: string }
  packageResult?: { exitCode?: number, output?: string }
}

/** One version check's outcome, as the console renders it. */
export interface UpdateReport {
  /** Version this process is running. */
  current: string
  /** Spec the profile installs the package with, when it can be read. */
  spec: string | null
  /** Repository the spec names, when it names one. */
  repo: string | null
  /** Newest version tag GitHub reports; null before a check, or when none parsed. */
  latest: string | null
  /** Whether `latest` is newer than {@link current}. */
  newer: boolean
  /** Whether pressing update can do anything (newer, a repository, and a manager). */
  updatable: boolean
  /** Why {@link updatable} is false, or why the last check failed. */
  reason: string | null
  checkedAt: string | null
  /** What the last update did. */
  phase: 'idle' | 'checking' | 'installing' | 'restart-required' | 'failed'
  message: string
}

/** How the profile mounts this plugin's row, as the console reports it. */
export interface ProfileMigrationStatus {
  state: 'unknown' | 'ok' | 'migrated' | 'awaiting-restart' | 'disabled' | 'unavailable' | 'error'
  shape: ProfileShape | null
  notes: readonly string[]
}

function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * Version of the host that composed this plugin, for `host.describe`.
 *
 * The launcher runs `node --import tsx`, which sets no `npm_package_version`,
 * so the App used to read "dev" from every real deployment. The harness starts
 * the plugin with its own root as the working directory, so its manifest is the
 * answer; cached because a host upgrade needs a restart anyway.
 */
let hostVersionCache: string | undefined
function hostVersion(): string {
  if (hostVersionCache !== undefined) return hostVersionCache
  try {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version?: unknown }
    hostVersionCache = typeof manifest.version === 'string' ? manifest.version : 'dev'
  } catch {
    hostVersionCache = 'dev'
  }
  return hostVersionCache
}

/**
 * Whether two resolved configurations are the same everywhere the bridge
 * reads. Exported for the drift guard in `tests/config.spec.ts`: a field that
 * exists on {@link Config} but is missing here is a field whose saves silently
 * never reach the running bridge.
 */
export function sameConfig(left: Config, right: Config): boolean {
  return left.natsUrl === right.natsUrl
    && left.hubWssUrl === right.hubWssUrl
    && left.hubUser === right.hubUser
    && left.hubPass === right.hubPass
    && left.hubCaCert === right.hubCaCert
    && left.hubCaFingerprint === right.hubCaFingerprint
    && left.instanceId === right.instanceId
    && left.instanceName === right.instanceName
    && left.tokenTtlDays === right.tokenTtlDays
    && left.pairCodeTtlSec === right.pairCodeTtlSec
    && left.maxDevices === right.maxDevices
    && left.chunkCoalesceMs === right.chunkCoalesceMs
    && left.natsConfigPath === right.natsConfigPath
    && left.natsServerPath === right.natsServerPath
    && left.autoMigrateProfile === right.autoMigrateProfile
}

/**
 * Why the plugin manager refused an update, or null when it went through.
 *
 * The manager reports a failure as a bare `application` code plus whatever
 * pnpm printed, and the console cannot act on either on its own: the exit code
 * says nothing, and the output's last lines are the only part that names the
 * real cause (a missing repository, a prepare that threw). Fold both into one
 * line the owner can read.
 */
function updateFailure(result: PluginChangeResult): string | null {
  if (result.application === 'applied' || result.application === 'restart-required') return null
  const lines: string[] = []
  const diagnostic = result.error?.diagnostic ?? result.error?.code
  if (typeof diagnostic === 'string' && diagnostic.trim() !== '') lines.push(diagnostic.trim())
  const output = result.packageResult?.output
  if (typeof output === 'string' && output.trim() !== '') {
    const tail = output.trim().split('\n').slice(-6).join('\n')
    if (!lines.some(line => line.includes(tail))) lines.push(tail)
  }
  const detail = lines.join('\n')
  const verdict = result.application === 'cancelled' ? '更新被取消' : '更新失败'
  return detail === '' ? verdict : `${verdict}：${detail}`
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
  /**
   * Host tool registry, when the composition provides one. Reached lazily (like
   * `settings`/`webServer`) so a host without `ctx.tools` still loads.
   */
  private toolRegistry: unknown
  /** Agent registry, to resolve the tool scope (the Agent) for a Session. */
  private agentRegistry: { get: (id: string) => object | undefined } | undefined
  /** Projects tool calls and results into the wire `view` slot. */
  private readonly toolViews = new ToolViews(
    () => this.toolRegistry as ToolRegistryLike | undefined,
    sessionId => this.agentRegistry?.get(sessionId),
  )
  private readonly tokens: TokenStore
  /** A process started from the local console. NATS is a host service, so it
   * intentionally survives bridge restarts and is never killed by stop(). */
  private localNatsProcess: ChildProcess | null = null
  /** Config exactly as the loader resolved it: `.volatile()` fields are references. */
  private readonly raw: ConfigInput
  private current: Config
  /** Serializes start/stop/restart: concurrent triggers (boot effect + settings
   *  watch) must never overlap, or a duplicate NATS connection + RPC
   *  subscription leaks and every request gets two answers. */
  private lifecycle: Promise<void> = Promise.resolve()
  private wantRunning = false

  constructor(ctx: Context, entryConfig: ConfigInput) {
    super(ctx, 'mobileBridge')
    this.raw = entryConfig
    this.current = configValues(entryConfig)
    this.tokens = new TokenStore(join(dshHome(), 'mobile-bridge', 'tokens.json'))

    // Settings layering: the profile patch's user document over the composition
    // entry. Every field is schema-volatile, so the settings page's write commits
    // into the references above and the loader re-emits `loader/volatile-update`
    // instead of remounting this plugin; the listener then rebuilds the bridge
    // stack with the new values. Works headless too (no settings provider = the
    // entry config stays authoritative and saves stay in memory).
    ctx.inject(['settings'], (sctx) => {
      const settings = sctx.get('settings') as unknown as SettingsService
      this.settings = settings
      sctx.effect(() => settings.configure({ auto: false }, ctx.fiber))
    })

    // A volatile-only config write reached the running instance; re-read the
    // references the loader just updated.
    ctx.on('loader/volatile-update', () => {
      this.applyConfig(configValues(this.raw))
    })

    // The long half of an update is pnpm fetching and building the package, so
    // the phase the manager reports is what the console shows while it waits.
    ctx.on('plugin-manager/install-state', ({ requestId, phase }) => {
      if (requestId !== this.updateRequestId) return
      this.update = {
        ...this.update,
        message: phase === 'applying' ? '正在应用新版本…' : '正在下载并构建新版本…',
      }
    })

    // Loopback console routes when a webserver is in the composition (web profile).
    ctx.inject(['webServer'], (sctx) => {
      const webServer = sctx.get('webServer') as unknown as WebRouter
      return registerConsoleRoutes(webServer, {
        bridge: () => this,
        currentConfig: () => this.current,
        updateConfig: patch => this.updateConfig(patch),
        startNats: () => this.startLocalNats(),
        localNats: () => this.localNatsInfo(),
        repairProfile: () => this.repairProfileShape(true),
        checkUpdate: () => this.checkUpdate(),
        applyUpdate: () => this.applyUpdate(),
      })
    })

    // Tool presentation: the registry holds each tool's declared
    // `presentCall`/`presentResult`, which is what lets the phone render a
    // tool's card instead of its raw text. Optional — a host without tools still
    // serves events, just without cards.
    ctx.inject(['tools'], (sctx) => {
      this.toolRegistry = sctx.get('tools')
    })

    // Tools are registered per Agent scope, so a session's Agent is what makes
    // its tools' presenters reachable.
    ctx.inject(['agents'], (sctx) => {
      this.agentRegistry = sctx.get('agents') as unknown as { get: (id: string) => object | undefined }
    })

    // Profile install shape. A profile that mounts this row with a bare
    // `- insert:` cannot be managed from the Plugins page at all (see
    // src/profile-migration.ts), so the plugin repairs it itself. The repair is
    // deferred past this loader pass: rewriting the patch file from inside the
    // pass that is creating this fiber would re-enter the include's update.
    ctx.inject(['profileContext'], (sctx) => {
      this.profile = sctx.get('profileContext') as unknown as ProfileContextLike
      sctx.effect(() => {
        const timer = setTimeout(() => { void this.repairProfileShape() }, 0)
        return () => clearTimeout(timer)
      })
    })

    // Version checks and updates go through the host's own plugin manager, the
    // same pnpm path the Plugins page uses. Optional: a host without it (or a
    // headless composition) still runs, the console just reports why it cannot
    // update itself.
    ctx.inject(['pluginManager'], (sctx) => {
      this.pluginManager = sctx.get('pluginManager') as unknown as PluginManagerLike
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

  private settings: SettingsService | null = null
  private profile: ProfileContextLike | null = null
  private pluginManager: PluginManagerLike | null = null
  private profileMigration: ProfileMigrationStatus = { state: 'unknown', shape: null, notes: [] }
  /** The request id of the update in flight, so install-state events match it. */
  private updateRequestId: string | null = null
  /** Last version check and update outcome; starts unchecked. */
  private update: UpdateReport = {
    current: PLUGIN_VERSION,
    spec: null,
    repo: null,
    latest: null,
    newer: false,
    updatable: false,
    reason: null,
    checkedAt: null,
    phase: 'idle',
    message: '',
  }

  /** Effective config (settings user layer over the composition entry). */
  get activeConfig(): Config {
    return this.current
  }

  /**
   * Persist a config patch through the settings user layer (the profile patch
   * file); falls back to in-memory when no settings provider is mounted
   * (headless dev).
   *
   * The saved values are applied here rather than waiting for
   * `loader/volatile-update`. Measured on dsh 0.1.7: a console save writes the
   * profile patch (the file is correct) but the plugin's own references are not
   * re-committed for that save, so nothing the owner edits — the machine name,
   * the Hub address, the credentials — reaches the running bridge until the
   * host restarts. Applying the patch we just persisted closes that gap, and
   * the ordinary event, when it does arrive, only re-confirms the same values
   * ({@link applyConfig} compares first).
   */
  async updateConfig(patch: Partial<Config>): Promise<void> {
    if (this.settings !== null) {
      await this.settings.update(SETTINGS_NS, patch)
      this.applyConfig({ ...this.current, ...patch })
      return
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

  /**
   * What this machine calls itself on the phone. An unset name falls back to
   * the instance id, which is the only identifier every existing install is
   * guaranteed to have.
   */
  private instanceName(): string {
    const configured = this.current.instanceName.trim()
    return configured === '' ? this.current.instanceId : configured
  }

  // ---- service surface for the settings card / CLI ----

  status(): {
    connection: ConnectionStatus
    devices: number
    pluginVersion: string
    installedVersion: string | null
    mobileApi: number
    features: readonly string[]
    buildId: string
    loadedFrom: string
    instanceId: string
    instanceName: string
    startedAt: string | null
    uptimeMs: number
    lastConnectedAt: string | null
    lastReconnectAt: string | null
    lastError: string | null
    profile: ProfileMigrationStatus
    update: UpdateReport
  } {
    return {
      connection: this.connectionStatus,
      devices: this.tokens.activeCount(),
      pluginVersion: PLUGIN_VERSION,
      // Read on every status call rather than cached at boot: the interesting
      // moment is precisely the one where an install lands under a running
      // process, and a cached answer could never see it.
      installedVersion: readInstalledVersion(PLUGIN_LOADED_FROM, PLUGIN_PACKAGE_NAME),
      mobileApi: PLUGIN_MOBILE_API,
      features: PLUGIN_FEATURES,
      buildId: PLUGIN_BUILD_ID,
      loadedFrom: PLUGIN_LOADED_FROM,
      instanceId: this.current.instanceId,
      instanceName: this.instanceName(),
      startedAt: this.bridgeStartedAt,
      uptimeMs: this.bridgeStartedAt === null ? 0 : Math.max(0, Date.now() - Date.parse(this.bridgeStartedAt)),
      lastConnectedAt: this.lastConnectedAt,
      lastReconnectAt: this.lastReconnectAt,
      lastError: this.lastError,
      profile: this.profileMigration,
      update: this.update,
    }
  }

  listDevices(): Omit<DeviceEntry, 'tokenHash'>[] {
    return this.tokens.list()
  }

  /**
   * How this profile mounts the plugin's row, and what the repair did about
   * it. Reported through `/api/status` so the console page can show the shape
   * the Plugins page is stuck on.
   */
  get profileInstall(): ProfileMigrationStatus {
    return this.profileMigration
  }

  /**
   * Check the profile's install shape and repair it when the host could not
   * manage it. Idempotent; the console's「修复安装形态」calls it with
   * `manual` set.
   * @param manual - the owner asked for it, so `autoMigrateProfile` is bypassed.
   * @returns the report now stored for `/api/status`.
   */
  async repairProfileShape(manual = false): Promise<ProfileMigrationStatus> {
    const profile = this.profile
    if (profile === null) {
      return this.recordMigration({
        state: 'unavailable',
        shape: null,
        notes: ['这个进程没有 profileContext（宿主不是由 dsh launcher 启动的 profile），安装形态无从检查。'],
      })
    }
    const location: ProfileLocation = { dir: profile.dir, patchPath: profile.patchPath }
    const ids: ProfileIdentifiers = {
      packageName: PLUGIN_PACKAGE_NAME,
      rowId: PLUGIN_ROW_ID,
      rowName: PLUGIN_PACKAGE_NAME,
    }
    try {
      const before = await readProfileShape(location, ids)
      if (!manual && !this.current.autoMigrateProfile) {
        return this.recordMigration({
          state: 'disabled',
          shape: before,
          notes: ['自动迁移已关闭（autoMigrateProfile=false），profile 文件不会被改写；'
            + '需要修复时点下面的「修复安装形态」。'],
        })
      }
      if (!manual && !needsRepair(before)) {
        return this.recordMigration({ state: 'ok', shape: before, notes: [] })
      }
      // The bundle layer is only composed at launch, so the insert row may be
      // lifted out of the patch only when this process was started with that
      // bundle. Otherwise the row would leave the running composition with the
      // write, and the bridge would go dark until the next start.
      const result = await migrateProfile(location, ids, {
        removeInsert: profile.startedBundles.includes(PLUGIN_PACKAGE_NAME),
      })
      const lifted = result.changed.includes(profile.patchPath)
      const state = lifted ? 'migrated' : result.changed.length > 0 ? 'awaiting-restart' : 'ok'
      if (result.changed.length > 0) {
        console.info('[mobile-bridge] profile install shape repaired', {
          state, files: result.changed, notes: result.notes,
        })
      }
      return this.recordMigration({ state, shape: result.shape, notes: result.notes })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[mobile-bridge] profile install shape check failed:', message)
      return this.recordMigration({
        state: 'error',
        shape: null,
        notes: [`安装形态检查失败：${message}`],
      })
    }
  }

  private recordMigration(status: ProfileMigrationStatus): ProfileMigrationStatus {
    this.profileMigration = status
    return status
  }

  /**
   * What the console's version panel shows. Read-only; the check itself is
   * {@link checkUpdate}, which the owner triggers from the page.
   */
  get updateState(): UpdateReport {
    return this.update
  }

  /**
   * Ask GitHub for the newest version tag of the repository this install came
   * from, and compare it with the running version.
   *
   * A failed check is reported, never smoothed over: "已是最新版本" is exactly
   * the wrong answer for a rate limit, a typo'd repository, or a machine with
   * no route to GitHub, and each of those has a different fix.
   * @returns The report now stored for `/api/status` (also returned to the caller).
   */
  async checkUpdate(): Promise<UpdateReport> {
    this.update = { ...this.update, phase: 'checking', message: '正在获取最新版本…', reason: null }
    const profile = this.profile
    try {
      const spec = profile === null
        ? null
        : await readProfileDependency(profile.dir, PLUGIN_PACKAGE_NAME).catch(() => null)
      const source = parseUpdateSource(spec)
      if (source === null) {
        throw new Error(profile === null
          ? '这个进程没有 profileContext，读不到安装来源。'
          : `profile 的 package.json 里没有 ${PLUGIN_PACKAGE_NAME} 依赖，无法确定更新来源。`)
      }
      if (source.local) {
        throw new Error(`这个 profile 用本地路径安装（${source.spec}），请在源码目录 git pull 后重启 dsh。`)
      }
      // Two sources can name a newest version: a GitHub repository (tags) or
      // the npm registry this profile installed from (dist-tags). Neither
      // answer may be invented, so a source that names neither reports why.
      if (source.repo === null && source.registry === null) {
        throw new Error(`从 ${source.spec} 看不出 GitHub 仓库或 npm 包名，无法查询最新版本。`)
      }
      const latest = source.registry === null
        ? await fetchLatestTag(source.repo!)
        : await fetchLatestRegistryVersion(source.registry)
      if (latest === null) {
        throw new Error(source.registry === null
          ? `${source.repo!} 上没有版本 tag。`
          : `npm 上 ${source.registry} 没有可用的 dist-tags.latest。`)
      }
      const newer = isNewerVersion(latest, PLUGIN_VERSION)
      const blocked = this.pluginManager === null
        ? '这个宿主没有插件管理器，请用 dsh 的插件页更新。'
        : null
      this.update = {
        current: PLUGIN_VERSION,
        spec: source.spec,
        repo: source.repo,
        latest,
        newer,
        updatable: newer && blocked === null,
        reason: newer ? blocked : null,
        checkedAt: new Date().toISOString(),
        phase: 'idle',
        message: newer ? `发现新版本 ${latest}。` : `已是最新版本（${PLUGIN_VERSION}）。`,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.update = {
        ...this.update,
        latest: null,
        newer: false,
        updatable: false,
        reason: message,
        checkedAt: new Date().toISOString(),
        phase: 'failed',
        message,
      }
    }
    return this.update
  }

  /**
   * Install the newest version through the host's plugin manager.
   *
   * The spec handed over is the profile's own dependency line, so pnpm does
   * exactly what an install does — resolve, fetch, build when the source needs
   * it — and the running process keeps the code it booted with until dsh
   * restarts. Two install shapes need a different spec than the one they were
   * read from: a release asset pins its version in the URL path, and a registry
   * range names no exact version at all — {@link updateSpec} answers both. That
   * restart is the answer the owner gets, not a hidden failure.
   * @returns The report now stored for `/api/status`.
   */
  async applyUpdate(): Promise<UpdateReport> {
    const current = this.update
    if (current.spec === null || !current.updatable) {
      this.update = { ...current, phase: 'failed', message: current.reason ?? '当前没有可用的更新，请先刷新版本。' }
      return this.update
    }
    const manager = this.pluginManager
    if (manager === null) {
      this.update = { ...current, phase: 'failed', message: '这个宿主没有插件管理器，请用 dsh 的插件页更新。' }
      return this.update
    }
    const source = parseUpdateSource(current.spec)
    const target = source === null || current.latest === null
      ? current.spec
      : updateSpec(source, current.latest)
    const requestId = `dsh-mobile-update-${Date.now()}`
    this.updateRequestId = requestId
    this.update = { ...current, phase: 'installing', message: `正在更新到 ${current.latest ?? '最新版本'}…` }
    try {
      const result = await manager.installBundle(target, { enabled: true, requestId })
      const failure = updateFailure(result)
      this.update = failure === null
        ? {
            ...this.update,
            newer: false,
            updatable: false,
            phase: 'restart-required',
            message: `新版本已经装好，重启 dsh 后生效（当前运行的是 ${PLUGIN_VERSION}）。`,
          }
        : { ...this.update, newer: true, updatable: true, phase: 'failed', message: failure }
      return this.update
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.update = { ...this.update, newer: true, updatable: true, phase: 'failed', message: `更新失败：${message}` }
      return this.update
    } finally {
      this.updateRequestId = null
    }
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    return this.tokens.revoke(deviceId)
  }

  /** Delete one revoked device's record; see {@link TokenStore.forget}. */
  async forgetDevice(deviceId: string): Promise<boolean> {
    return this.tokens.forget(deviceId)
  }

  /**
   * The config and executable this process would launch with, resolved the same
   * way {@link startLocalNats} resolves them. The console shows both so a
   * machine that keeps `leaf.conf` somewhere else can see the path it needs to
   * set instead of guessing from a failure.
   */
  localNatsInfo(): { config: LocalNatsResolution, server: LocalNatsResolution } {
    return {
      config: resolveLeafConfig(this.localNatsInput('config')),
      server: resolveNatsServer(this.localNatsInput('server')),
    }
  }

  /** The saved field and environment variable behind one of the two paths. */
  private localNatsInput(which: 'config' | 'server'): { configured: string, env: string | undefined, dshHome: string } {
    return {
      configured: which === 'config' ? this.current.natsConfigPath : this.current.natsServerPath,
      env: which === 'config' ? process.env.NATS_CONFIG_PATH : process.env.NATS_SERVER_PATH,
      dshHome: dshHome(),
    }
  }

  /** Start the machine-local NATS Leaf used by this bridge. */
  async startLocalNats(): Promise<{ ok: boolean, message: string }> {
    if (this.localNatsProcess !== null
      && this.localNatsProcess.exitCode === null
      && !this.localNatsProcess.killed) {
      return { ok: true, message: '本地 NATS 已在运行（由插件启动）' }
    }

    // A server already answering on the client port is the whole reason a fresh
    // nats-server exits a moment later, so the port decides before anything
    // else: this machine's Leaf may have been started by hand, a service
    // manager, or a previous dsh run, and none of those need our config file.
    const endpoint = natsEndpoint(this.current.natsUrl)
    if (await probePort(endpoint.host, endpoint.port)) {
      return { ok: true, message: `本地 NATS 已在 ${endpoint.host}:${endpoint.port} 监听（不是本插件启动的进程）` }
    }

    const server = resolveNatsServer(this.localNatsInput('server'))
    if (!server.exists) {
      return {
        ok: false,
        message: '找不到 nats-server 可执行文件，已按顺序查找：\n'
          + server.candidates.map(candidate => `  · ${candidate}`).join('\n')
          + '\n装好它、或把路径写进下方「nats-server 路径」（也可以设 NATS_SERVER_PATH 环境变量）。',
      }
    }
    const leaf = resolveLeafConfig(this.localNatsInput('config'))
    if (!leaf.exists) {
      return {
        ok: false,
        message: '找不到 NATS 配置文件，已按顺序查找：\n'
          + leaf.candidates.map(candidate => `  · ${candidate}`).join('\n')
          + '\n把 Leaf 配置放到其中之一，或把路径写进下方「本地 NATS 配置文件」'
          + '（也可以设 NATS_CONFIG_PATH 环境变量）。',
      }
    }
    const command = server.path
    const configPath = leaf.path

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
    const drop = (): void => {
      if (this.localNatsProcess === child) this.localNatsProcess = null
    }
    if (spawnError !== null) {
      drop()
      return { ok: false, message: `启动 NATS 失败：${spawnError.message}` }
    }
    // Readiness, not the spawn result: the port opening is the proof the server
    // is up, and the child exiting is the proof it is not.
    const deadline = Date.now() + 3000
    for (;;) {
      if (child.exitCode !== null) {
        drop()
        return {
          ok: false,
          message: `NATS 已退出（代码 ${child.exitCode}），${endpoint.host}:${endpoint.port} 没有开始监听：`
            + `端口可能已被别的进程占用，或 ${configPath} 被拒绝。`,
        }
      }
      if (await probePort(endpoint.host, endpoint.port, 300)) {
        return { ok: true, message: `NATS 已监听 ${endpoint.host}:${endpoint.port}（配置：${configPath}）` }
      }
      if (Date.now() >= deadline) {
        return {
          ok: false,
          message: `NATS 进程已启动，但 ${endpoint.host}:${endpoint.port} 在 3 秒内没有开始监听；`
            + `请检查 ${configPath} 与 nats-server 日志。`,
        }
      }
      await new Promise(resolve => setTimeout(resolve, 150))
    }
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
      payload: buildPairingPayload(this.current, code),
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
      1_000,
      this.toolViews,
    )
    this.eventBridge = new EventBridge(nc, eventAdapter, {
      instanceId: this.current.instanceId,
      coalesceMs: this.current.chunkCoalesceMs,
    })
    this.eventBridge.start()

    this.rpcBridge = new RpcBridge(nc, {
      instanceId: this.current.instanceId,
      instanceName: this.instanceName(),
      carrier,
      gateway,
      tokens: this.tokens,
      tokenTtlDays: this.current.tokenTtlDays,
      maxDevices: this.current.maxDevices,
      onHello: (deviceId, deviceName) => {
        if (deviceName !== undefined) {
          void this.tokens.rename(deviceId, deviceName).catch(() => undefined)
        }
        this.eventBridge?.replayPending()
        // The App's store starts empty after a reconnect: without the roster
        // replay its job strip would stay blank until some job changed.
        eventAdapter.replayJobs()
      },
      onInventory: async () => gateway.invoke({ namespace: 'pluginInventory', method: 'list', args: {} }).catch(() => null),
      onHealth: () => ({ status: 'ok', ...this.status() }),
      toolViews: this.toolViews,
      onHostDescribe: async () => {
        const sessions = await gateway.invoke({
          namespace: 'session', method: 'list', args: { _request: {} },
        }).catch(() => ({ items: [] }))
        return {
          version: hostVersion(),
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
      onFileWatch: (sessionId, path) => eventAdapter.watchFiles(sessionId, path),
      onFileUnwatch: (sessionId, path) => eventAdapter.unwatchFiles(sessionId, path),
      onSessionOpened: sessionId => eventAdapter.watchJobs(sessionId),
      onRespond: (rpcId, result) => eventAdapter.respond(rpcId, result),
      onStaleRespond: (eventId, result) => eventAdapter.resolveStale(eventId, result),
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
