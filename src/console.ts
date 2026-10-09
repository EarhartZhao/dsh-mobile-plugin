/**
 * Loopback console: a self-contained page plus JSON routes on the dsh
 * webserver (bound to 127.0.0.1 by default, so only this machine's browser
 * can reach it). This is the onboarding wizard: server-info form, connection
 * status, pairing QR, and device management.
 *
 * The Plugins page's client half uses the same JSON routes for its compact
 * tabs; this page remains the standalone full-screen workflow.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import QRCode from 'qrcode'
import type { LocalNatsRuntimeStatus, MobileBridge, UpdateReport } from './index.js'
import type { Config } from './config.js'
import {
  checkHubCertificate,
  checkHubPath,
  fetchHubCertificate,
  normalizeHubWssUrl,
  type HubCaFetchResult,
  type HubCheckResult,
  type HubCertificateResult,
} from './hub-check.js'
import { readHubCa } from './hub-ca.js'
import type { LocalNatsResolution } from './nats-launch.js'

export interface WebRouter {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export interface ConsoleBackend {
  bridge: () => MobileBridge
  currentConfig: () => Config
  updateConfig: (patch: Partial<Config>) => Promise<void>
  startNats: () => Promise<{ ok: boolean, message: string }>
  /** Leaf config and executable the launch button will use, for the status panel. */
  localNats?: () => { config: LocalNatsResolution, server: LocalNatsResolution }
  /** Live runtime state of the local NATS port, for the status panel. */
  localNatsStatus?: () => Promise<LocalNatsRuntimeStatus>
  /** Check (and repair) how the profile mounts this plugin's row. */
  repairProfile: () => Promise<ProfileRepairReport>
  /** Overridable so route tests stay off the network. */
  checkHub?: (config: Config) => Promise<HubCheckResult>
  /** The certificate step of that check; overridable for the same reason. */
  checkHubCertificate?: (config: Config) => Promise<HubCertificateResult>
  /**
   * Namespace in effect. An empty `instanceId` means "auto", and the generated
   * value lives in the plugin's own store, so the page cannot derive it: every
   * check that dials `svc.dsh.<instance>.…` has to ask.
   */
  instanceId?: () => string
  /** Fetch the Hub's CA certificate from its TLS chain; overridable for tests. */
  fetchHubCa?: (config: Config) => Promise<HubCaFetchResult>
  /** Ask GitHub for the newest version tag and compare it with the running one. */
  checkUpdate?: () => Promise<UpdateReport>
  /** Install the newest version through the host's plugin manager. */
  applyUpdate?: () => Promise<UpdateReport>
}

/** Install-shape report produced by the plugin's own repair (`ProfileMigrationStatus`). */
export interface ProfileRepairReport {
  state: string
  shape: { bundleListed: boolean, legacyInsert: boolean, overrideRow: boolean } | null
  notes: readonly string[]
}

/**
 * What to tell the owner when the version on disk is not the one running.
 *
 * Upgrading the package cannot take effect in the running process: the host
 * keeps the JavaScript generation it booted with, and its plugin manager
 * answers `restart-required` for any package the profile already depends on.
 * The install itself reports that only on the Plugins page, and a `pnpm add`
 * from a terminal reports nothing at all — so the console names the gap and
 * the way out of it, instead of letting someone hunt for a button that the
 * old generation does not have.
 * @param running The version the loaded code declares.
 * @param installed The version of the manifest on disk, or null when unknown.
 * @returns One runnable sentence, or null when both versions agree.
 */
export function versionDrift(running: string, installed: string | null | undefined): string | null {
  const onDisk = installed?.trim() ?? ''
  const live = running.trim()
  if (onDisk === '' || live === '' || onDisk === live) return null
  return `磁盘上已装 ${onDisk}，当前运行的是 ${live}——重启 dsh 后新版本才生效：`
    + '终端里起的按 Ctrl+C 再运行 dsh web；桌面版用菜单「重启应用与 Host」。'
}

/**
 * The QR carries the Hub account straight to the phone, so a missing
 * credential mints a terminal that can never connect — and the App reports it
 * as an opaque field error. Name every unset field up front instead; null when
 * the QR is actually usable.
 */
export function missingHubCredentials(config: Config): string | null {
  const missing = [
    config.hubWssUrl.trim() === '' ? 'Hub 地址' : null,
    config.hubUser.trim() === '' ? '账号' : null,
    config.hubPass === '' ? '密码' : null,
  ].filter((name): name is string => name !== null)
  if (missing.length === 0) return null
  return `未配置 ${missing.join('、')}：二维码要带上 Hub 的账号凭证，手机没有它连不上 Hub。请先在上方填写并保存。`
}

/**
 * Whether the request arrived over the loopback interface. Fail-closed: an
 * unknown peer is treated as remote. The wizard is the owner's own screen on
 * their own machine, and showing the saved password is what makes a wrong one
 * visible — but the same response served to another origin would hand it out,
 * so every console route runs {@link consoleRequestRejection} first.
 */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const remoteAddress = req.socket.remoteAddress
  return remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1'
}

/** Header a same-origin console page must carry on every state-changing call. */
export const CONSOLE_HEADER = 'x-dsh-mobile-console'

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers?.[name]
  return Array.isArray(value) ? value[0] : value
}

/** Host names that only ever address this machine. */
function isLoopbackHost(host: string): boolean {
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return name === '127.0.0.1' || name === '[::1]' || name === 'localhost'
}

/**
 * Why a console request must be refused, or null when it may run.
 *
 * The console drives pairing and the Hub credential, so three boundaries have
 * to hold before any handler sees a request:
 *
 *   - peer — the socket must be loopback; an exposed host must not serve this.
 *   - host — a browser keeps its own `Host` while the socket is loopback, so a
 *     name that is not this machine is a rebinding attempt, not a local page.
 *   - origin — a cross-origin caller must not drive the wizard, even from this
 *     machine's browser.
 *
 * State-changing calls additionally require the console header and a JSON
 * body: both are non-simple for a browser, so a page that can reach the port
 * cannot fire them blind with `no-cors`.
 * @param req - incoming console request.
 * @param options - whether this request changes state.
 * @returns the refusal (status and message) or null.
 */
export function consoleRequestRejection(
  req: IncomingMessage,
  options: { mutating: boolean },
): { status: number, error: string } | null {
  if (!isLoopbackRequest(req)) return { status: 403, error: 'loopback only' }
  const host = header(req, 'host')
  if (host !== undefined && host !== '' && !isLoopbackHost(host)) {
    return { status: 403, error: 'loopback host required' }
  }
  const origin = header(req, 'origin')
  if (origin !== undefined && origin !== '' && origin !== 'null') {
    let originHost: string
    try {
      originHost = new URL(origin).host
    } catch {
      return { status: 403, error: 'same-origin required' }
    }
    if (host !== undefined && host !== '' && originHost !== host) {
      return { status: 403, error: 'same-origin required' }
    }
  }
  if (!options.mutating) return null
  if ((header(req, 'content-type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    return { status: 415, error: 'application/json required' }
  }
  if (header(req, CONSOLE_HEADER) !== '1') {
    return { status: 403, error: 'console header required' }
  }
  return null
}

/** Register all console routes on the webserver; returns the disposer. */
export function registerConsoleRoutes(webServer: WebRouter, backend: ConsoleBackend): () => void {
  // The default check covers the whole phone path, including whether the Hub
  // can reach this instance — the link a credential-only test cannot see.
  const checkHub = backend.checkHub ?? ((config: Config) => checkHubPath(config, {
    localConnected: backend.bridge().status().connection === 'connected',
  }))
  const fetchHubCa = backend.fetchHubCa ?? ((config: Config) => fetchHubCertificate(config))
  const checkCertificate = backend.checkHubCertificate ?? ((config: Config) => checkHubCertificate(config))

  /**
   * Config as the wire sees it. The saved `instanceId` may be empty — that is
   * "auto", and only the plugin knows which id it generated — so the checks
   * that build subjects ask for the resolved one rather than dial `svc.dsh..`.
   */
  const effective = (config: Config): Config => {
    const resolved = backend.instanceId?.() ?? ''
    return resolved === '' || resolved === config.instanceId ? config : { ...config, instanceId: resolved }
  }

  /**
   * Config for a read-only check: what the page shows, not only what it saved.
   *
   * The two read-only buttons are the steps that come before the first save.
   * On a new machine nothing is stored yet, and the address is the one value
   * that has to be typed before anything else can work: 保存并测试 cannot pass
   * without the certificate 「从 Hub 获取 CA」 brings back, so a fetch that
   * dialled the stored address left a fresh install reading
   * 「无法把「」当作 Hub 地址」with no way forward. Posted values win; an empty
   * field keeps the stored one, which is also what an unrevealed password
   * field posts. Nothing is written here — the fields the owner saves stay the
   * fields the owner saves.
   */
  const checkedConfig = async (req: IncomingMessage): Promise<Config> => {
    const saved = effective(backend.currentConfig())
    let body: Record<string, unknown>
    try {
      body = await readJson(req)
    } catch {
      return saved
    }
    const patch: Partial<Config> = {}
    if (typeof body.hubWssUrl === 'string' && body.hubWssUrl.trim() !== '') patch.hubWssUrl = normalizeHubWssUrl(body.hubWssUrl)
    if (typeof body.hubUser === 'string' && body.hubUser.trim() !== '') patch.hubUser = body.hubUser.trim()
    if (typeof body.hubPass === 'string' && body.hubPass !== '') patch.hubPass = body.hubPass
    return { ...saved, ...patch }
  }
  const disposers = [
    webServer.register({
      kind: 'exact',
      path: '/mobile-bridge',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(CONSOLE_HTML)
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/mobile-bridge/api/status',
      handler: async (req, res) => {
        const rejected = consoleRequestRejection(req, { mutating: false })
        if (rejected !== null) return json(res, rejected.status, { error: rejected.error })
        const bridge = backend.bridge()
        const status = bridge.status()
        const config = backend.currentConfig()
        const ca = readHubCa(config.hubCaCert)
        // Port probe, so this is the one async read: it answers "is NATS up"
        // rather than "does the config file exist".
        const localNatsRuntime = backend.localNatsStatus === undefined
          ? null
          : await backend.localNatsStatus()
        // The password is deliberately absent here: this response is polled
        // every few seconds, and a secret that rides a poll is available to any
        // local process at any moment. It comes from `/api/reveal` instead, only
        // when the owner asks to see it.
        json(res, 200, {
          ...status,
          // Derived here, not in the page: the wording is the whole feature, and
          // a server-side function is testable without a browser.
          versionDrift: versionDrift(status.pluginVersion, status.installedVersion),
          localNats: backend.localNats?.() ?? null,
          localNatsRuntime,
          config: {
            enabled: config.enabled,
            hubWssUrl: config.hubWssUrl,
            hubUser: config.hubUser,
            hubPassConfigured: config.hubPass.length > 0,
            // The certificate is public material, and the console has to show
            // it to be able to edit it — but a poll every few seconds must not
            // paste over an edit in progress, so the page only writes this
            // field when it is untouched (see refreshStatus).
            hubCaCert: config.hubCaCert,
            hubCaFingerprint: config.hubCaFingerprint,
            // Derived readout so the page can show what the QR will carry
            // without shipping a SHA-256 implementation into the browser.
            hubCaSummary: ca === null
              ? null
              : { fingerprint: ca.fingerprint, subject: ca.subject, validTo: ca.validTo, isCa: ca.isCa },
            instanceId: config.instanceId,
            instanceName: config.instanceName,
            natsConfigPath: config.natsConfigPath,
            natsServerPath: config.natsServerPath,
          },
        })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/mobile-bridge/api/reveal',
      handler: (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        const rejected = consoleRequestRejection(req, { mutating: true })
        if (rejected !== null) return json(res, rejected.status, { error: rejected.error })
        json(res, 200, { hubPass: backend.currentConfig().hubPass })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/mobile-bridge/api/config',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        const rejected = consoleRequestRejection(req, { mutating: true })
        if (rejected !== null) return json(res, rejected.status, { error: rejected.error })
        try {
          const body = await readJson(req)
          const patch: Partial<Config> = {}
          if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
          // A bare host or IP is what people paste; store the WSS URL the QR needs.
          if (typeof body.hubWssUrl === 'string') patch.hubWssUrl = normalizeHubWssUrl(body.hubWssUrl)
          if (typeof body.hubUser === 'string') patch.hubUser = body.hubUser.trim()
          if (typeof body.hubPass === 'string' && body.hubPass.length > 0) patch.hubPass = body.hubPass
          // Unlike the password, clearing this one is meaningful: it is how an
          // owner takes a certificate back out of the QR.
          if (typeof body.hubCaCert === 'string') patch.hubCaCert = body.hubCaCert.trim()
          if (typeof body.hubCaFingerprint === 'string') patch.hubCaFingerprint = body.hubCaFingerprint.trim()
          if (typeof body.instanceId === 'string') patch.instanceId = body.instanceId.trim()
          // Empty is meaningful here: it is how an owner goes back to showing
          // the instance id on the phone.
          if (typeof body.instanceName === 'string') patch.instanceName = body.instanceName.trim()
          if (typeof body.natsConfigPath === 'string') patch.natsConfigPath = body.natsConfigPath.trim()
          if (typeof body.natsServerPath === 'string') patch.natsServerPath = body.natsServerPath.trim()
          await backend.updateConfig(patch)
          json(res, 200, { ok: true })
        } catch (error) {
          json(res, 400, { error: String(error) })
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/mobile-bridge/api/nats/start',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        const rejected = consoleRequestRejection(req, { mutating: true })
        if (rejected !== null) return json(res, rejected.status, { error: rejected.error })
        try {
          const result = await backend.startNats()
          json(res, result.ok ? 200 : 400, result)
        } catch (error) {
          json(res, 400, { ok: false, message: String(error) })
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/mobile-bridge/api/migrate',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        const rejected = consoleRequestRejection(req, { mutating: true })
        if (rejected !== null) return json(res, rejected.status, { error: rejected.error })
        try {
          const report = await backend.repairProfile()
          json(res, report.state === 'error' ? 400 : 200, report)
        } catch (error) {
          json(res, 400, { state: 'error', shape: null, notes: [String(error)] })
        }
      },
    }),
    // Checking reaches GitHub, which is a read: no console header needed, the
    // same shape as hub-check. It never installs anything.
    webServer.register({
      kind: 'exact',
      path: '/mobile-bridge/api/update/check',
      handler: async (req, res) => {
        const rejected = consoleRequestRejection(req, { mutating: false })
        if (rejected !== null) return json(res, rejected.status, { error: rejected.error })
        if (backend.checkUpdate === undefined) {
          return json(res, 400, { error: '这个宿主没有实现版本检查。' })
        }
        try {
          json(res, 200, await backend.checkUpdate())
        } catch (error) {
          json(res, 400, { error: String(error) })
        }
      },
    }),
    // Installing rewrites the profile's dependency and runs pnpm, so it is a
    // state change: POST, console header, JSON body, like the other writes.
    webServer.register({
      kind: 'exact',
      path: '/mobile-bridge/api/update/apply',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        const rejected = consoleRequestRejection(req, { mutating: true })
        if (rejected !== null) return json(res, rejected.status, { error: rejected.error })
        if (backend.applyUpdate === undefined) {
          return json(res, 400, { error: '这个宿主没有实现插件更新。' })
        }
        try {
          const report = await backend.applyUpdate()
          json(res, report.phase === 'failed' ? 400 : 200, report)
        } catch (error) {
          json(res, 400, { error: String(error) })
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/mobile-bridge/api/pair',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        const rejected = consoleRequestRejection(req, { mutating: true })
        if (rejected !== null) return json(res, rejected.status, { error: rejected.error })
        // Refuse before minting: a code handed out for an unusable payload
        // still burns one of the three pending slots.
        const missing = missingHubCredentials(backend.currentConfig())
        if (missing !== null) return json(res, 400, { error: missing })
        // A rejected credential is definitive and would only surface on the
        // phone as an opaque NATS error, so stop it here. An unreachable Hub
        // is not proof of anything (the port may be blocked from this host),
        // so it mints with a warning instead.
        const hub = await checkHub(effective(backend.currentConfig()))
        if (hub.reason === 'rejected') return json(res, 400, { error: hub.message })
        // A certificate that is missing, unreadable or simply not the one the
        // Hub signs with does not stop the QR from being minted — the owner may
        // be fixing the Hub side right now — but a scan that will fail at the
        // handshake deserves a warning here instead of that same failure on the
        // phone, where nothing can explain it.
        const certificate = await checkHubCertificate(effective(backend.currentConfig()))
        const hubWarning = [hub.ok ? null : hub.message, certificate.ok ? null : certificate.message]
          .filter((line): line is string => line !== null)
          .join('\n\n')
        // A Hub that cannot reach this instance means the phone will get a bare
        // no-responders 503. Unlike a credential typo this can heal on its own
        // (the Leaf reconnects), so warn instead of refusing to mint.
        try {
          const pairing = await backend.bridge().createPairingQr()
          const text = JSON.stringify(pairing.payload)
          // A phone camera resolves this off a screen, so density is the whole
          // game: the 4-module quiet zone is the spec minimum (2 slows
          // detection), and M keeps some tolerance for screen glare.
          const qrSvg = await QRCode.toString(text, {
            type: 'svg',
            margin: 4,
            errorCorrectionLevel: 'M',
          })
          json(res, 200, {
            expiresAt: pairing.expiresAt,
            payload: pairing.payload,
            qrSvg,
            hubWarning: hubWarning === '' ? undefined : hubWarning,
          })
        } catch (error) {
          json(res, 400, { error: String(error) })
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/mobile-bridge/api/hub-check',
      handler: async (req, res) => {
        const rejected = consoleRequestRejection(req, { mutating: false })
        if (rejected !== null) return json(res, rejected.status, { error: rejected.error })
        const config = await checkedConfig(req)
        const result = await checkHub(config)
        // The certificate is the one link the phone cannot report on: a wrong
        // one is an opaque handshake failure there, so it rides along here as
        // a step the owner can read.
        const certificate = await checkCertificate(config)
        json(res, 200, {
          ...result,
          certificate,
          steps: [...result.steps, { key: 'certificate', ok: certificate.ok, message: certificate.message }],
        })
      },
    }),
    // Fetches the Hub's CA out of the handshake the phone will do, so a second
    // machine does not have to be handed ca.crt. A read: it neither writes the
    // profile nor installs anything — the page fills the field, the owner saves.
    webServer.register({
      kind: 'exact',
      path: '/mobile-bridge/api/hub-ca/fetch',
      handler: async (req, res) => {
        const rejected = consoleRequestRejection(req, { mutating: false })
        if (rejected !== null) return json(res, rejected.status, { error: rejected.error })
        try {
          json(res, 200, await fetchHubCa(await checkedConfig(req)))
        } catch (error) {
          json(res, 400, { error: String(error) })
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/mobile-bridge/api/devices',
      handler: (req, res) => {
        const rejected = consoleRequestRejection(req, { mutating: false })
        if (rejected !== null) return json(res, rejected.status, { error: rejected.error })
        json(res, 200, { devices: backend.bridge().listDevices() })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/mobile-bridge/api/revoke',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        const rejected = consoleRequestRejection(req, { mutating: true })
        if (rejected !== null) return json(res, rejected.status, { error: rejected.error })
        const body = await readJson(req)
        const ok = await backend.bridge().revokeDevice(String(body.deviceId ?? ''))
        json(res, ok ? 200 : 404, { ok })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/mobile-bridge/api/forget',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        const rejected = consoleRequestRejection(req, { mutating: true })
        if (rejected !== null) return json(res, rejected.status, { error: rejected.error })
        const body = await readJson(req)
        const ok = await backend.bridge().forgetDevice(String(body.deviceId ?? ''))
        json(res, ok ? 200 : 404, { ok })
      },
    }),
  ]
  return () => { for (const dispose of disposers) dispose() }
}

/** The wizard page: zero dependencies, talks to the routes above. */
const CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>dsh-mobile 桥接配置</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f6f4;
    --surface: #fff;
    --surface-soft: #f1f1ee;
    --text: #18181b;
    --muted: #6b6b73;
    --line: #deded9;
    --line-strong: #c8c8c1;
    --accent: #1f6feb;
    --accent-soft: #eaf2ff;
    --success: #18794e;
    --success-soft: #e9f6ef;
    --warning: #8a5a00;
    --warning-soft: #fff7df;
    --danger: #b42318;
    --danger-soft: #fff0ee;
    --radius: 8px;
    --shadow: 0 1px 2px #18181b0a;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #101113;
      --surface: #17181b;
      --surface-soft: #202126;
      --text: #f4f4f5;
      --muted: #a0a0a8;
      --line: #2c2e33;
      --line-strong: #3b3e46;
      --accent: #7aabff;
      --accent-soft: #162846;
      --success: #58c58d;
      --success-soft: #14291f;
      --warning: #e5b95c;
      --warning-soft: #2d2514;
      --danger: #f58b84;
      --danger-soft: #341b1a;
      --shadow: 0 1px 2px #0005;
    }
  }
  * { box-sizing: border-box; }
  html { min-height: 100%; background: var(--bg); }
  body {
    min-height: 100%;
    margin: 0;
    padding: 20px;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  button, input, textarea { font: inherit; }
  a { color: var(--accent); text-underline-offset: 2px; }
  button {
    min-height: 34px;
    padding: 7px 12px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
    white-space: nowrap;
  }
  button:hover:not(:disabled) { filter: brightness(.96); }
  button.secondary {
    border-color: var(--line-strong);
    background: transparent;
    color: var(--text);
  }
  button.secondary:hover:not(:disabled) { background: var(--surface-soft); filter: none; }
  button:disabled { opacity: .45; cursor: default; }
  button:focus-visible, input:focus-visible, textarea:focus-visible, summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  [hidden] { display: none !important; }
  .page { width: min(1160px, 100%); margin: 0 auto; }
  .topbar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 18px;
    padding: 2px 0 16px;
  }
  .brand h1 { margin: 0; font-size: 20px; line-height: 1.2; letter-spacing: 0; }
  .brand p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
  .statusBar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  }
  .statusPill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 34px;
    padding: 6px 10px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface);
    box-shadow: var(--shadow);
    font-size: 12px;
  }
  .statusDot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--muted); }
  .statusPill.connected { border-color: var(--success); color: var(--success); background: var(--success-soft); }
  .statusPill.connected .statusDot { background: var(--success); }
  .statusPill.connecting .statusDot, .statusPill.reconnecting .statusDot { background: var(--warning); }
  .statusPill.disabled { border-color: var(--line-strong); color: var(--muted); background: var(--surface-soft); }
  .statusPill.disabled .statusDot { background: var(--muted); }
  .statusMeta { max-width: 360px; overflow: hidden; color: var(--muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
  #versionDrift {
    display: none;
    margin: 0 0 14px;
    padding: 9px 11px;
    border: 1px solid var(--warning);
    border-radius: 6px;
    background: var(--warning-soft);
    color: var(--warning);
    font-size: 12px;
    white-space: pre-line;
  }
  #versionDrift:not(:empty) { display: block; }
  .workspace {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(320px, .85fr);
    grid-template-areas:
      "setup setup"
      "connection pair"
      "nats pair"
      "devices pair";
    gap: 14px;
    align-items: start;
  }
  .setupPanel { grid-area: setup; }
  .connectionPanel { grid-area: connection; }
  .natsPanel { grid-area: nats; }
  .devicesPanel { grid-area: devices; }
  .pairPanel { grid-area: pair; }
  .connectionPanel { grid-area: connection; }
  .pairPanel { grid-area: pair; }
  .panel {
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--shadow);
  }
  .panelHeader {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px 0;
  }
  .panelHeader h2 { margin: 0; font-size: 15px; line-height: 1.3; }
  .panelHeader p { margin: 3px 0 0; color: var(--muted); font-size: 12px; }
  .panelBody { padding: 14px 16px 16px; }
  /* First run: the order the steps have to happen in, and what is still
     missing. Each row is one thing to do; the jump link goes to the control
     that does it. */
  .setupList {
    display: grid;
    /* Four steps read as one row on a wide screen and stack on a narrow one. */
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    gap: 8px;
    margin: 14px 0 0;
    padding: 0;
    list-style: none;
  }
  .setupItem {
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr) auto;
    gap: 10px;
    align-items: start;
    padding: 10px 11px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--bg);
  }
  .setupItem[data-state="done"] { border-color: var(--success); background: var(--success-soft); }
  .setupItem[data-state="todo"] { border-color: var(--warning); background: var(--warning-soft); }
  .setupMark {
    width: 10px;
    height: 10px;
    margin: 5px 0 0 3px;
    border: 1px solid var(--line-strong);
    border-radius: 50%;
  }
  .setupItem[data-state="done"] .setupMark { border-color: var(--success); background: var(--success); }
  .setupItem[data-state="todo"] .setupMark { border-color: var(--warning); background: var(--warning); }
  .setupText b { font-size: 13px; }
  .setupText p { margin: 3px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
  .setupJump { align-self: center; color: var(--accent); font-size: 12px; white-space: nowrap; }
  .message.warn { color: var(--warning); }
  .formGrid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
  .span2 { grid-column: 1 / -1; }
  .field label { display: block; margin-bottom: 5px; color: var(--muted); font-size: 12px; }
  .field input, .field textarea {
    width: 100%;
    min-width: 0;
    padding: 8px 10px;
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
  }
  .field input::placeholder, .field textarea::placeholder { color: var(--muted); opacity: .75; }
  /* A value the owner cannot edit here: the generated instance id. */
  .field .readOnly {
    margin: 0;
    padding: 8px 10px;
    border: 1px dashed var(--line-strong);
    border-radius: 6px;
    background: var(--surface-soft);
    color: var(--text);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    overflow-wrap: anywhere;
  }
  .field textarea {
    resize: vertical;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
  }
  .inputAction { display: flex; align-items: center; gap: 8px; }
  .inputAction input { flex: 1; }
  .inputAction button { flex: none; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 14px; }
  .actions.tight { margin-top: 0; }
  .message { margin: 8px 0 0; color: var(--muted); font-size: 12px; white-space: pre-line; }
  .message:empty { display: none; }
  .message.error { color: var(--danger); }
  .message.ok { color: var(--success); }
  .checkResult:not(:empty) {
    padding: 9px 10px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--surface-soft);
  }
  .checkResult.error { border-color: var(--danger); background: var(--danger-soft); }
  .checkResult.ok { border-color: var(--success); background: var(--success-soft); }
  .disclosure {
    margin-top: 14px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--bg);
  }
  .disclosure > summary {
    position: relative;
    padding: 9px 34px 9px 11px;
    color: var(--muted);
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    list-style: none;
  }
  .disclosure > summary::-webkit-details-marker { display: none; }
  .disclosure > summary::after {
    position: absolute;
    top: 50%;
    right: 12px;
    width: 6px;
    height: 6px;
    margin-top: -4px;
    border-right: 1.5px solid var(--muted);
    border-bottom: 1.5px solid var(--muted);
    content: "";
    transform: rotate(45deg);
  }
  .disclosure[open] > summary::after { margin-top: -1px; transform: rotate(225deg); }
  .disclosureBody { padding: 0 11px 12px; }
  .disclosureBody > .formGrid { margin-top: 8px; }
  .pairPanel .panelBody { display: flex; flex-direction: column; }
  .pairPanel .actions { margin-top: 0; }
  #pairHint { margin-top: 10px; }
  #qr {
    display: grid;
    min-height: 232px;
    margin-top: 12px;
    padding: 12px;
    place-items: center;
    border: 1px dashed var(--line-strong);
    border-radius: 6px;
    background: var(--surface);
  }
  #qr:not(:empty) { background: #fff; }
  #qr:empty::before { content: "生成后在这里扫码"; color: var(--muted); font-size: 12px; }
  /* The SVG carries its own white background and quiet zone; sizing it up is
     what makes the camera lock on in well under a second. */
  #qr svg { width: min(300px, 100%); height: auto; background: #fff; }
  #qrExpiry { margin-top: 8px; text-align: center; }
  #qrFull {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 24px;
    background: var(--surface);
    color: var(--text);
  }
  #qrFull[hidden] { display: none; }
  #qrFull svg { width: min(84vmin, 92vw); height: auto; }
  #qrFull .fullMeta { color: var(--muted); font-size: 14px; text-align: center; }
  #qrFull .fullMeta b { font-size: 20px; letter-spacing: 2px; }
  #qrFull .fullActions { display: flex; gap: 10px; }
  .devicesPanel { grid-area: devices; }
  .devicesPanel .panelHeader { padding-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td, th { padding: 8px 10px; border-bottom: 1px solid var(--line); text-align: left; }
  th { color: var(--muted); font-size: 11px; font-weight: 600; }
  .tabs { display: flex; gap: 18px; padding: 0 16px; border-bottom: 1px solid var(--line); }
  .tab {
    min-height: 36px;
    margin: 0;
    padding: 8px 1px 7px;
    border: 0;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    background: transparent;
    color: var(--muted);
    font-size: 13px;
  }
  .tab:hover:not(:disabled) { background: transparent; color: var(--text); filter: none; }
  .tab[aria-selected="true"] { border-bottom-color: var(--accent); color: var(--accent); }
  .tab .count { margin-left: 5px; font-variant-numeric: tabular-nums; opacity: .72; }
  /* The device list is the only unbounded section here: cap it and scroll,
     with the header pinned so the columns stay labelled. */
  .devicePane { max-height: 420px; overflow: auto; }
  .devicePane table { border-collapse: separate; border-spacing: 0; }
  .devicePane th { position: sticky; top: 0; z-index: 1; background: var(--surface); }
  .devicePane td:last-child, .devicePane th:last-child { text-align: right; }
  .deviceState { color: var(--muted); }
  .advanced {
    margin-top: 14px;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--shadow);
  }
  .advanced > summary {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    padding: 13px 16px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 600;
    list-style: none;
  }
  .advanced > summary::-webkit-details-marker { display: none; }
  .advanced > summary::after {
    width: 7px;
    height: 7px;
    margin-top: -3px;
    border-right: 1.5px solid var(--muted);
    border-bottom: 1.5px solid var(--muted);
    content: "";
    transform: rotate(45deg);
  }
  .advanced[open] > summary::after { margin-top: 3px; transform: rotate(225deg); }
  .advanced > summary span { margin-left: auto; color: var(--muted); font-size: 12px; font-weight: 400; text-align: right; }
  .advancedBody { display: grid; gap: 18px; padding: 0 16px 18px; border-top: 1px solid var(--line); }
  .advancedSection { padding-top: 16px; }
  .advancedSection + .advancedSection { border-top: 1px solid var(--line); }
  .advancedSection h3 { margin: 0 0 10px; font-size: 13px; }
  .advancedGrid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; }
  .metaLine { margin: 0; font-size: 12px; }
  .metaLine > span { color: var(--muted); }
  .health {
    display: grid;
    grid-template-columns: minmax(112px, auto) minmax(0, 1fr);
    gap: 7px 14px;
    margin: 0;
    font-size: 12px;
  }
  .health dt { color: var(--muted); }
  .health dd { margin: 0; overflow-wrap: anywhere; }
  .health .error { color: var(--danger); }
  @media (max-width: 820px) {
    body { padding: 14px; }
    .topbar { flex-direction: column; }
    .statusBar { justify-content: flex-start; }
    .statusMeta { max-width: 100%; white-space: normal; }
    .workspace {
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas:
        "setup"
        "connection"
        "nats"
        "pair"
        "devices";
    }
    .advancedGrid { grid-template-columns: minmax(0, 1fr); }
  }
  @media (max-width: 560px) {
    body { padding: 10px; }
    .formGrid { grid-template-columns: minmax(0, 1fr); }
    .span2 { grid-column: auto; }
    .panelHeader, .panelBody { padding-right: 12px; padding-left: 12px; }
    .tabs { padding: 0 12px; }
    .advanced > summary span { display: none; }
    .statusMeta { display: none; }
    .actions button { flex: 1 1 auto; }
  }
</style>
</head>
<body>
<div class="page">
  <header class="topbar">
    <div class="brand">
      <h1>dsh-mobile 桥接</h1>
      <p>连接本机 NATS 与手机端</p>
    </div>
    <div class="statusBar">
      <span class="statusPill" id="statusPill" aria-live="polite">
        <span class="statusDot"></span><span id="status">加载中…</span>
      </span>
      <span class="statusMeta" id="statusMeta">正在读取实例信息</span>
      <button id="runtimeToggle" class="secondary" type="button" aria-live="polite">停用移动桥</button>
      <button id="hubCheckBtn" class="secondary" type="button">测试连接</button>
    </div>
  </header>
  <p id="versionDrift" role="status"></p>

  <main class="workspace">
    <section class="panel setupPanel" aria-labelledby="setupTitle">
      <div class="panelHeader">
        <div>
          <h2 id="setupTitle">开箱清单</h2>
          <p>第一次接入按顺序走一遍：1 填 Hub 凭证 → 2 拿 CA 证书 → 3 启动本机 NATS → 4 手机扫码。</p>
        </div>
        <span id="setupSummary" class="message" role="status"></span>
      </div>
      <ol class="setupList" id="setupChecklist">
        <li class="setupItem" id="setupHub" data-state="todo">
          <span class="setupMark" aria-hidden="true"></span>
          <div class="setupText">
            <b>1. 填 Hub 地址与账号</b>
            <p>Hub 是手机要连的那台服务器：地址形如 <code>wss://&lt;hub-host&gt;:8443</code>，账号是管理员给的 C 端受限账号（不是 Hub 的管理员账号）。</p>
          </div>
          <a class="setupJump" href="#hubUser">去填写</a>
        </li>
        <li class="setupItem" id="setupCa" data-state="todo">
          <span class="setupMark" aria-hidden="true"></span>
          <div class="setupText">
            <b>2. 拿到 Hub 的 CA 证书</b>
            <p>App 里不内置任何 CA：Hub 用自签证书时必须把 ca.crt 配进来，点「从 Hub 获取 CA」一般能自动取到；
              Hub 的证书由公共 CA 签发时这一步可以跳过。Hub 是你自己搭的、还没有 ca.crt？看
              <a href="https://github.com/EarhartZhao/dsh-mobile-plugin/blob/master/docs/03-nats-self-host.md" target="_blank" rel="noreferrer">docs/03</a>
              的「上 TLS：自签私有 CA」。</p>
          </div>
          <a class="setupJump" href="#hubCaCert">去获取</a>
        </li>
        <li class="setupItem" id="setupNats" data-state="todo">
          <span class="setupMark" aria-hidden="true"></span>
          <div class="setupText">
            <b>3. 启动本机 NATS（Leaf）</b>
            <p>插件出站连的是这台电脑上的 NATS，再由它连 Hub。这台电脑还没装过？把
              <a href="https://github.com/EarhartZhao/dsh-mobile-plugin/blob/master/docs/04-ai-onboarding.md" target="_blank" rel="noreferrer">docs/04 新电脑接入清单</a>
              整页交给它上面的 AI 照着做，再回来点「启动本地 NATS」。</p>
          </div>
          <a class="setupJump" href="#startNatsBtn">去启动</a>
        </li>
        <li class="setupItem" id="setupPair" data-state="todo">
          <span class="setupMark" aria-hidden="true"></span>
          <div class="setupText">
            <b>4. 让手机扫码接入</b>
            <p>前三步就绪后二维码里才会带上正确的 Hub 地址、账号与证书；提前扫会卡在 TLS 握手上。</p>
          </div>
          <a class="setupJump" href="#pairBtn">去配对</a>
        </li>
      </ol>
    </section>

    <section class="panel connectionPanel" aria-labelledby="connectionTitle">
      <div class="panelHeader">
        <div>
          <h2 id="connectionTitle">1. 连接 Hub</h2>
          <p>Hub 的地址、账号密码，以及 App 要信任的 CA 证书，都在这里配。</p>
        </div>
      </div>
      <div class="panelBody">
        <div class="formGrid">
          <div class="field span2">
            <label for="hubWssUrl">Hub 地址</label>
            <input id="hubWssUrl" placeholder="wss://203.0.113.10:8443" autocomplete="off" spellcheck="false">
          </div>
          <div class="field">
            <label for="hubUser">账号</label>
            <input id="hubUser" placeholder="Hub 的 C 端受限账号" autocomplete="off" spellcheck="false">
          </div>
          <div class="field">
            <label for="hubPass">密码</label>
            <div class="inputAction">
              <input id="hubPass" type="password" placeholder="未配置" autocomplete="off" spellcheck="false">
              <button id="hubPassToggle" class="secondary" type="button">显示</button>
            </div>
          </div>
        </div>
        <div class="formGrid" style="margin-top: 12px;">
          <div class="field span2">
            <label for="hubCaCert">Hub CA 证书</label>
            <div class="actions tight">
              <button id="fetchCaBtn" class="secondary" type="button">从 Hub 获取 CA</button>
              <span id="fetchCaMsg" class="message" role="status"></span>
            </div>
            <p id="hubCaHint" class="message"></p>
            <textarea id="hubCaCert" rows="4" spellcheck="false" autocomplete="off" placeholder="-----BEGIN CERTIFICATE-----&#10;…&#10;-----END CERTIFICATE-----"></textarea>
            <details class="disclosure">
              <summary>ca.crt 从哪里来？</summary>
              <div class="disclosureBody">
                <p id="caOriginHint" class="message">
                  还不知道 ca.crt 该从哪来？两种情况：<b>Hub 是别人搭的</b>，向对方要一份（ca.crt 是公开材料，不含私钥）；
                  <b>Hub 是你自己搭的（或还没搭）</b>，就得先在服务器上生成自己的 CA——私钥 ca.key 留在管理机、绝不进服务器，
                  只有 ca.crt 填在这里。从零建 Hub 的完整步骤（生成 CA → 签发服务器证书 → 把 ca.crt 拼进 cert_file）见
                  <a href="https://github.com/EarhartZhao/dsh-mobile-plugin/blob/master/docs/03-nats-self-host.md" target="_blank" rel="noreferrer">docs/03-nats-self-host.md</a>
                  的「2.3 上 TLS：自签私有 CA」与「2.6 让新机器一键取到 CA」——这本仓库里也有同一份文件。
                </p>
              </div>
            </details>
          </div>
        </div>
        <div class="actions">
          <button id="saveBtn" type="button">保存并测试</button>
          <span id="saveMsg" class="message" role="status"></span>
        </div>
        <p id="hubCheckMsg" class="message checkResult" role="status"></p>

        <details class="disclosure">
          <summary>实例与身份（一般不用改）</summary>
          <div class="disclosureBody">
            <div class="formGrid">
              <div class="field">
                <label for="instanceIdValue">实例 ID（自动生成）</label>
                <p class="readOnly" id="instanceIdValue">—</p>
                <p class="message">它是这台机器在 Hub 上的命名空间：RPC 走 <code>svc.dsh.&lt;id&gt;.*</code>，配对二维码里带的也是它。
                  这次安装第一次启动时自动生成一个 8 位 ID（时间戳 + 随机，存在
                  <code>$DSH_HOME/mobile-bridge/instances.json</code>），升级、重装、重启都不变，这里不需要填、也改不了；
                  同一台机器上的多个 dsh 实例各有各的 ID。控制台从不改写它——写进 profile 的值仍然生效（升级前手写过 ID 的机器不会换号），
                  但一般只有「同一台机器上多个 dsh 实例共用同一份检出」才需要那样做。</p>
              </div>
              <div class="field">
                <label for="instanceName">本机名称</label>
                <input id="instanceName" placeholder="例如：家里的 Mac mini" autocomplete="off" spellcheck="false">
              </div>
            </div>
          </div>
        </details>
      </div>
    </section>

    <section class="panel natsPanel" aria-labelledby="natsTitle">
      <div class="panelHeader">
        <div>
          <h2 id="natsTitle">2. 本机 NATS（Leaf）</h2>
          <p>插件不监听端口，只出站连这台电脑上的 NATS；本机 NATS 再把流量带到 Hub。</p>
        </div>
      </div>
      <div class="panelBody">
        <div class="actions tight">
          <button id="startNatsBtn" class="secondary" type="button">启动本地 NATS</button>
          <span id="natsMsg" class="message" role="status"></span>
        </div>
        <p id="natsPathLine" class="message"></p>
        <p id="natsHelpLine" class="message">
          这个按钮只启动<b>已经装好</b>的本机 NATS；这台电脑还没有 nats-server 或还没有 leaf.conf 时，把
          <a href="https://github.com/EarhartZhao/dsh-mobile-plugin/blob/master/docs/04-ai-onboarding.md" target="_blank" rel="noreferrer">docs/04-ai-onboarding.md</a>
          整页交给这台电脑上的 AI，让它照着装（装 nats-server → 写 leaf.conf → 取 CA → 自检 Hub 账号）；
          自己动手就看
          <a href="https://github.com/EarhartZhao/dsh-mobile-plugin/blob/master/docs/03-nats-self-host.md" target="_blank" rel="noreferrer">docs/03-nats-self-host.md</a>
          的「3. Leaf：dsh 电脑上的本机节点」。
        </p>
        <p class="message">状态每 5 秒自动刷新一次；装好或修好之后点一次上面的按钮即可。</p>
        <details class="disclosure">
          <summary>手动指定路径</summary>
          <div class="disclosureBody">
            <div class="formGrid">
              <div class="field">
                <label for="natsConfigPath">leaf.conf 路径</label>
                <input id="natsConfigPath" placeholder="留空 = 自动查找" autocomplete="off" spellcheck="false">
              </div>
              <div class="field">
                <label for="natsServerPath">nats-server 路径</label>
                <input id="natsServerPath" placeholder="留空 = 自动查找，含 PATH" autocomplete="off" spellcheck="false">
              </div>
            </div>
            <div class="actions">
              <button id="saveNatsPathBtn" class="secondary" type="button">保存路径</button>
              <span id="natsPathMsg" class="message" role="status"></span>
            </div>
          </div>
        </details>
      </div>
    </section>

    <section class="panel pairPanel" aria-labelledby="pairTitle">
      <div class="panelHeader">
        <div>
          <h2 id="pairTitle">3. 配对新设备</h2>
          <p>生成一次性二维码，让 App 扫码接入（有效期 120 秒）。</p>
        </div>
      </div>
      <div class="panelBody">
        <div class="actions">
          <button id="pairBtn" type="button" disabled>生成配对二维码</button>
          <button id="qrFullBtn" class="secondary" type="button" disabled>放大显示</button>
        </div>
        <p id="pairHint" class="message">正在检查连接状态…</p>
        <div id="qr" aria-live="polite"></div>
        <p id="qrExpiry" class="message"></p>
        <p id="pairErr" class="message error" role="alert"></p>
        <details class="disclosure">
          <summary>配对说明</summary>
          <div class="disclosureBody">
            <p class="message">同一时间最多 3 个配对码有效（120 秒）；重新生成会让最早的码作废，卡住时直接再点一次即可。</p>
          </div>
        </details>
      </div>
    </section>
    <section class="panel devicesPanel" aria-labelledby="devicesTitle">
      <div class="panelHeader">
        <div>
          <h2 id="devicesTitle">4. 已配对设备</h2>
          <p>查看设备状态，吊销不再使用的访问令牌。</p>
        </div>
      </div>
      <div class="tabs" role="tablist">
        <button class="tab" id="tabActive" role="tab" aria-selected="true" onclick="showDevices('active')">正在使用<span class="count" id="countActive">0</span></button>
        <button class="tab" id="tabRevoked" role="tab" aria-selected="false" onclick="showDevices('revoked')">已吊销<span class="count" id="countRevoked">0</span></button>
      </div>
      <div class="devicePane">
        <table><thead><tr><th>设备</th><th>配对时间</th><th>最近活动</th><th>到期</th><th></th></tr></thead><tbody id="devices"></tbody></table>
      </div>
    </section>
  </main>

  <details class="advanced">
    <summary>高级设置与诊断 <span>安装形态、更新和运行信息</span></summary>
    <div class="advancedBody">
      <section class="advancedSection">
        <h3>安装与更新</h3>
        <div class="advancedGrid">
          <div>
            <p class="metaLine">安装形态：<span id="profileShape">检查中…</span></p>
            <p id="profileNotes" class="message"></p>
            <div class="actions">
              <button id="repairBtn" class="secondary" type="button" hidden>修复安装形态</button>
              <span id="repairMsg" class="message" role="status"></span>
            </div>
          </div>
          <div>
            <div class="actions tight">
              <button id="updateCheckBtn" class="secondary" type="button">刷新</button>
              <button id="updateApplyBtn" hidden>更新</button>
              <span id="updateMsg" class="message" role="status"></span>
            </div>
            <p id="updateHint" class="message"></p>
          </div>
        </div>
      </section>

      <section class="advancedSection">
        <h3>运行诊断</h3>
        <dl class="health">
          <dt>插件版本</dt><dd><span id="pluginVersion">—</span></dd>
          <dt>mobileApi</dt><dd id="mobileApi">—</dd>
          <dt>构建 ID</dt><dd id="buildId">—</dd>
          <dt>实例 ID</dt><dd id="activeInstance">—</dd>
          <dt>本机名称</dt><dd id="activeInstanceName">—</dd>
          <dt>网关 ID</dt><dd id="gatewayId">—</dd>
          <dt>实际加载路径</dt><dd id="loadedFrom">—</dd>
          <dt>桥启动时间</dt><dd id="startedAt">—</dd>
          <dt>最近连接</dt><dd id="lastConnectedAt">—</dd>
          <dt>最近重连</dt><dd id="lastReconnectAt">—</dd>
          <dt>功能</dt><dd id="features">—</dd>
          <dt>最近错误</dt><dd id="lastError">无</dd>
        </dl>
      </section>
    </div>
  </details>
</div>

<div id="qrFull" hidden>
  <div id="qrFullQr"></div>
  <p class="fullMeta">配对码 <b id="qrFullCode">—</b><br><span id="qrFullExpiry"></span></p>
  <div class="fullActions">
    <button id="qrFullClose" class="secondary" type="button">关闭放大</button>
  </div>
</div>

<script>
const $ = id => document.getElementById(id)

/** The code currently on screen, or null once it has expired. */
let pairing = null

/**
 * Inputs the status poll owns, by id. The poll runs every 5 seconds, so a
 * field is written only while the owner has not touched it: pasting the saved
 * value over a half-typed Hub address looks exactly like the save failing, and
 * on a profile with nothing saved yet it wipes the field outright. A save
 * clears the flags for the fields it just wrote, so the stored values take
 * over again.
 */
const editedFields = new Set()

/** Prefill a status-backed input unless the owner typed in it or is in it. */
function prefill(id, value) {
  const field = $(id)
  if (editedFields.has(id) || document.activeElement === field) return
  field.value = value
}

for (const id of ['hubWssUrl', 'hubUser', 'hubCaCert', 'instanceName', 'natsConfigPath', 'natsServerPath']) {
  $(id).addEventListener('input', () => { editedFields.add(id) })
}

/** Shows the configured certificate, or why there is nothing to show. */
function renderHubCa(config) {
  prefill('hubCaCert', config.hubCaCert || '')
  const hint = $('hubCaHint')
  hint.className = 'message'
  if (!config.hubCaCert) {
    hint.textContent = '未配置：二维码不带证书，App 里也没有内置任何 CA。'
      + '只有由公共 CA 签发证书的 Hub 能连上。自签证书的 Hub 请点上面的「从 Hub 获取 CA」自动取，'
      + '或手工粘贴 ca.crt 全文（连 ca.crt 都还没有？看下面那一行）。'
    return
  }
  const summary = config.hubCaSummary
  if (!summary) {
    hint.className = 'message error'
    hint.textContent = '无法解析：请粘贴 ca.crt 的完整 PEM（含 BEGIN/END CERTIFICATE 行）或它的 base64 内容。'
    return
  }
  hint.textContent = summary.subject + '｜有效期至 ' + summary.validTo + '｜SHA-256 ' + summary.fingerprint
  const configured = (config.hubCaFingerprint || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  const actual = summary.fingerprint.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  if (configured && configured !== actual) {
    hint.className = 'message error'
    // Double-escaped: this code lives inside the page's own template literal.
    hint.textContent += '\\n配置的指纹与证书不一致，手机扫码会拒绝这个 Hub。'
  } else if (!summary.isCa) {
    hint.className = 'message error'
    hint.textContent += '\\n这不是一张 CA 证书（basicConstraints 不是 CA:TRUE），请确认粘的确实是 ca.crt。'
  }
}

$('hubPassToggle').onclick = async () => {
  const field = $('hubPass')
  const reveal = field.type === 'password'
  // The stored password is fetched only when the owner asks to see it: the
  // status poll never carries it, so it does not sit in a background response.
  if (reveal && field.value === '' && field.placeholder.indexOf('已配置') === 0) {
    const looked = await api('reveal', {})
    if (looked.error) {
      $('saveMsg').className = 'message error'
      $('saveMsg').textContent = looked.error
      return
    }
    field.value = typeof looked.hubPass === 'string' ? looked.hubPass : ''
  }
  field.type = reveal ? 'text' : 'password'
  $('hubPassToggle').textContent = reveal ? '隐藏' : '显示'
}

async function api(path, body) {
  const res = await fetch('/mobile-bridge/api/' + path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-mobile-console': '1' },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function refreshStatus() {
  try {
    const s = await api('status')
    const enabled = s.enabled !== false
    const connectionText = enabled
      ? ({ connected: '已连接', connecting: '连接中', reconnecting: '重连中', disconnected: '未连接' }[s.connection] || s.connection)
      : '已停用'
    $('status').textContent = connectionText
    $('statusPill').className = 'statusPill ' + (enabled ? (s.connection || '') : 'disabled')
    $('runtimeToggle').textContent = enabled ? '停用移动桥' : '启用移动桥'
    $('statusMeta').textContent = [
      s.instanceName || s.instanceId || '实例未命名',
      s.config && s.config.hubWssUrl ? s.config.hubWssUrl : 'Hub 未配置',
    ].join(' · ')
    $('pluginVersion').textContent = s.pluginVersion || '—'
    $('versionDrift').textContent = s.versionDrift || ''
    $('mobileApi').textContent = String(s.mobileApi ?? '—')
    $('buildId').textContent = s.buildId || '—'
    // Where the namespace came from matters: an auto id is this install's own
    // and changing it is what breaks every paired phone.
    $('activeInstance').textContent = (s.instanceId || '—')
      + (s.instanceIdSource === 'auto' ? '（本次安装自动生成）' : '')
    $('activeInstanceName').textContent = s.instanceName || s.instanceId || '—'
    $('gatewayId').textContent = s.gatewayId || '—'
    $('loadedFrom').textContent = s.loadedFrom || '—'
    $('startedAt').textContent = formatTime(s.startedAt)
    $('lastConnectedAt').textContent = formatTime(s.lastConnectedAt)
    $('lastReconnectAt').textContent = formatTime(s.lastReconnectAt)
    $('features').textContent = Array.isArray(s.features) ? s.features.join(' · ') : '—'
    $('lastError').textContent = s.lastError || '无'
    renderProfile(s.profile)
    renderLocalNats(s.localNats, s.localNatsRuntime)
    renderSetup(s)
    // A check or an install in flight owns the panel until it answers, so the
    // poll must not repaint over "正在更新…" with the last stored report.
    if (!updateBusy) renderUpdate(s.update)
    // Prefill only while the field is untouched; a poll every 5s must not
    // paste over an edit in progress (see prefill).
    prefill('hubWssUrl', s.config.hubWssUrl)
    prefill('hubUser', s.config.hubUser)
    renderHubCa(s.config)
    // The instance id is generated, not editable: the form shows the one in
    // effect (and where it came from), and never writes it back.
    $('instanceIdValue').textContent = (s.instanceId || '—')
      + (s.instanceIdSource === 'auto'
        ? '（本次安装自动生成）'
        : s.instanceIdSource === 'configured' ? '（profile 里手写覆盖）' : '')
    prefill('instanceName', s.config.instanceName || '')
    prefill('natsConfigPath', s.config.natsConfigPath || '')
    prefill('natsServerPath', s.config.natsServerPath || '')
    // Never prefill the password here — this response is polled every 5s and
    // 「显示」 is the one call that fetches the stored value.
    $('hubPass').placeholder = s.config.hubPassConfigured ? '已配置（留空保持不变）' : '未配置'
    // A QR minted without the Hub credential is dead on arrival, so the
    // credential gate comes before the connection gate.
    const hubReady = s.config.hubWssUrl.trim() !== '' && s.config.hubUser.trim() !== '' && s.config.hubPassConfigured
    $('pairBtn').disabled = !enabled || !hubReady || s.connection !== 'connected'
    $('pairHint').className = hubReady && enabled ? 'message' : 'message error'
    if (!enabled) {
      $('pairHint').textContent = '移动桥已停用，不会连接 NATS，也不会向手机发布事件。点右上角“启用移动桥”恢复。'
    } else if (!hubReady) {
      $('pairHint').textContent = '二维码要带上 Hub 的账号凭证，手机没有它连不上 Hub：请先在上方填写 Hub 地址、账号、密码并保存'
    } else if (s.connection === 'connected') {
      $('pairHint').textContent = '本地 NATS 已连接，可以生成二维码'
    } else {
      $('pairHint').textContent = '当前状态为“' + ({ connecting: '连接中', reconnecting: '重连中', disconnected: '未连接' }[s.connection] || s.connection) + '”，请先完成上面第 2 步「启动本地 NATS」'
    }
  } catch (error) {
    $('status').textContent = '状态读取失败'
    $('statusPill').className = 'statusPill disconnected'
    $('statusMeta').textContent = '连接状态不可用'
    $('lastError').textContent = String(error)
    $('pairBtn').disabled = true
    $('pairHint').className = 'message'
    $('pairHint').textContent = '状态不可用，请先启动本地 NATS'
  }
}

$('runtimeToggle').onclick = async () => {
  const button = $('runtimeToggle')
  const enable = button.textContent.indexOf('启用') === 0
  button.disabled = true
  $('saveMsg').className = 'message'
  $('saveMsg').textContent = enable ? '正在启用…' : '正在停用…'
  try {
    const r = await api('config', { enabled: enable })
    if (r.error) {
      $('saveMsg').className = 'message error'
      $('saveMsg').textContent = r.error
    } else {
      $('saveMsg').className = 'message ok'
      $('saveMsg').textContent = enable ? '移动桥已启用' : '移动桥已停用'
      await refreshStatus()
    }
  } catch (error) {
    $('saveMsg').className = 'message error'
    $('saveMsg').textContent = String(error)
  } finally {
    button.disabled = false
  }
}

function formatTime(value) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
}

/**
 * How far along the first-run order is.
 *
 * The CA row is the one step a Hub with a publicly signed certificate never
 * needs, so an empty field there reads as "skip it if it does not apply"
 * rather than "not done yet" — otherwise the checklist would send every owner
 * of a public-CA Hub hunting for a file they do not have.
 */
function renderSetup(s) {
  const hubReady = s.config.hubWssUrl.trim() !== '' && s.config.hubUser.trim() !== '' && s.config.hubPassConfigured
  const caReady = !!(s.config.hubCaSummary)
  const natsReady = !!(s.localNatsRuntime && s.localNatsRuntime.running)
  const connected = s.enabled !== false && s.connection === 'connected'
  const pending = []
  const mark = (id, ready, optional, label, action) => {
    const item = $(id)
    item.dataset.state = ready ? 'done' : (optional ? 'optional' : 'todo')
    // A finished row keeps the jump, so the control is still one click away;
    // it stops advertising an action that is already done.
    const jump = item.querySelector('.setupJump')
    if (jump) jump.textContent = ready ? '查看' : action
    if (!ready && !optional) pending.push(label)
  }
  mark('setupHub', hubReady, false, 'Hub 凭证', '去填写')
  mark('setupCa', caReady, true, 'CA 证书', '去获取')
  mark('setupNats', natsReady, false, '本机 NATS', '去启动')
  mark('setupPair', connected, false, '连接 Hub', '去配对')
  const summary = $('setupSummary')
  summary.className = pending.length === 0 ? 'message ok' : 'message warn'
  summary.textContent = pending.length === 0
    ? '✓ 必需的几项都就绪了，可以扫码配对'
    : '还剩 ' + pending.length + ' 项：' + pending.join('、')
}

/**
 * Show which leaf.conf the launch button will read. The path is discovered
 * (plugin home, then platform conventions) unless the owner set one, so a
 * machine that keeps the file elsewhere needs to see the path that was tried
 * before it can fix it — the failure alone names only one of them.
 */
function renderLocalNats(localNats, runtime) {
  const config = localNats && localNats.config
  const server = localNats && localNats.server
  const runtimeLine = runtime && typeof runtime.message === 'string'
    ? (runtime.running ? '● ' : '○ ') + runtime.message
    : ''
  if (!config || typeof config.path !== 'string') {
    $('natsPathLine').textContent = runtimeLine
    return
  }
  const line = (label, part) => {
    if (!part || typeof part.path !== 'string') return ''
    const source = { env: '来自环境变量', config: '来自本页填写', 'default': '自动查找' }[part.source] || part.source
    return (part.exists ? '✓ ' : '✗ ') + label + '：' + part.path + '（' + source + '）'
  }
  const lines = [runtimeLine, line('配置文件', config), line('nats-server', server)].filter(text => text !== '')
  if (config.exists && server && server.exists) {
    lines.push('启动命令：' + server.path + ' -c ' + config.path)
  }
  for (const part of [config, server]) {
    if (part && !part.exists && Array.isArray(part.candidates)) {
      lines.push('查找范围：\\n' + part.candidates.map(p => '  · ' + p).join('\\n'))
    }
  }
  // "找不到" alone leaves the owner with nothing to do next: the button only
  // launches what is already installed, so name what is missing and hand over
  // to the page's install line (docs/04) instead of letting them retry.
  const missing = [
    config.exists ? '' : 'leaf.conf（配置文件）',
    server && server.exists ? '' : 'nats-server（可执行文件）',
  ].filter(text => text !== '')
  if (missing.length > 0) {
    lines.push('缺 ' + missing.join(' 和 ') + '：这个按钮只启动装好的东西，按下面那条说明装好再点一次')
  }
  $('natsPathLine').textContent = lines.join('\\n')
}

/** Where the row comes from decides whether the Plugins page can manage it. */
const PROFILE_STATE_TEXT = {
  ok: '组合包（正常）',
  migrated: '已迁移为组合包',
  'awaiting-restart': '已登记组合包，重启 dsh 后完成迁移',
  disabled: '未自动迁移（autoMigrateProfile=false）',
  unavailable: '无法检查（宿主没有 profileContext）',
  error: '检查失败',
}

/**
 * Show the install shape and offer the repair. Only the two shapes a profile
 * patch can produce for this row are reachable here: the bundle's own row
 * (manageable) and a bare "insert" (no row toggle while the bundle is off,
 * and uninstall answers "bundle-in-use").
 */
function renderProfile(profile) {
  const state = profile && profile.state ? profile.state : 'unknown'
  const shape = profile ? profile.shape : null
  $('profileShape').textContent = PROFILE_STATE_TEXT[state] || '检查中…'
  // Clicking is only useful when something is still wrong and a write can fix
  // it: a settled profile and a pending restart both have nothing left to do.
  $('repairBtn').hidden = state === 'ok' || state === 'migrated' || state === 'awaiting-restart'
    || shape === null
  const notes = profile && Array.isArray(profile.notes) ? profile.notes : []
  $('profileNotes').textContent = notes.join('\\n')
}

/**
 * What the version panel shows. The update button only exists while a check
 * has found something newer: an always-present button that mostly answers
 * "已是最新" trains the owner to ignore it, and there is nothing to press
 * between checks anyway.
 */
let updateBusy = false

function renderUpdate(u) {
  if (!u) return
  const apply = $('updateApplyBtn')
  const newer = u.updatable === true
  apply.hidden = !newer
  if (newer) apply.textContent = '更新到 ' + (u.latest || '最新版本')
  const text = u.message || u.reason || ''
  $('updateMsg').className = 'message'
    + (u.phase === 'failed' ? ' error' : (u.phase === 'restart-required' ? ' ok' : ''))
  $('updateMsg').textContent = text
  // The reason explains a missing update button ("有新版本，但这个宿主没有插件
  // 管理器"); it is the same sentence as the message on a failed check, and
  // repeating it twice reads like two problems.
  $('updateHint').textContent = u.reason && u.reason !== text ? u.reason : ''
}

$('updateCheckBtn').onclick = async () => {
  updateBusy = true
  $('updateCheckBtn').disabled = true
  $('updateMsg').className = 'message'; $('updateMsg').textContent = '正在获取最新版本…'
  $('updateHint').textContent = ''
  try {
    const r = await api('update/check')
    if (r.error) { $('updateApplyBtn').hidden = true; $('updateMsg').className = 'message error'; $('updateMsg').textContent = r.error; return }
    renderUpdate(r)
  } catch (error) {
    $('updateMsg').className = 'message error'; $('updateMsg').textContent = String(error)
  } finally {
    updateBusy = false
    $('updateCheckBtn').disabled = false
  }
}

$('updateApplyBtn').onclick = async () => {
  updateBusy = true
  $('updateCheckBtn').disabled = true
  $('updateApplyBtn').disabled = true
  $('updateMsg').className = 'message'; $('updateMsg').textContent = '正在更新…'
  $('updateHint').textContent = ''
  try {
    const r = await api('update/apply', {})
    if (r.error) { $('updateMsg').className = 'message error'; $('updateMsg').textContent = r.error; return }
    renderUpdate(r)
  } catch (error) {
    $('updateMsg').className = 'message error'; $('updateMsg').textContent = String(error)
  } finally {
    updateBusy = false
    $('updateCheckBtn').disabled = false
    $('updateApplyBtn').disabled = false
  }
}

/** Device names come from the pairing client, so they are data, not markup. */
function escapeText(value) {
  return String(value).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ))
}

/** Which tab is showing; the full list stays in memory so counts are always both. */
let deviceTab = 'active'
let deviceList = []

/** Re-render the pane for the current tab, with both counts in the tab labels. */
function renderDevices() {
  const inUse = deviceList.filter(d => !d.revoked)
  const revoked = deviceList.filter(d => d.revoked)
  $('countActive').textContent = String(inUse.length)
  $('countRevoked').textContent = String(revoked.length)
  $('tabActive').setAttribute('aria-selected', deviceTab === 'active' ? 'true' : 'false')
  $('tabRevoked').setAttribute('aria-selected', deviceTab === 'revoked' ? 'true' : 'false')
  const rows = deviceTab === 'active' ? inUse : revoked
  $('devices').innerHTML = rows.map(d =>
    '<tr><td>' + escapeText(d.name) + '</td>' + '<td>' + d.createdAt.slice(0, 10) + '</td>' +
    '<td>' + (d.lastSeenAt ? formatTime(d.lastSeenAt) : '从未') + '</td>' +
    '<td>' + d.expiresAt.slice(0, 10) + '</td><td>' +
    (d.revoked
      // The record itself is the only thing left to act on, and it is already
      // dead: deleting it needs no confirmation dialog.
      ? '<span class="deviceState">已吊销</span> <button class="secondary" onclick="forgetDevice(\\'' + d.id + '\\')">删除记录</button>'
      : '<button class="secondary" onclick="revoke(\\'' + d.id + '\\')">吊销</button>') + '</td></tr>'
  ).join('') || '<tr><td colspan="5" class="deviceState">' +
    (deviceTab === 'active' ? '暂无设备' : '没有已吊销的设备') + '</td></tr>'
}

window.showDevices = (tab) => { deviceTab = tab; renderDevices() }

async function refreshDevices() {
  const { devices } = await api('devices')
  deviceList = Array.isArray(devices) ? devices : []
  renderDevices()
}

window.revoke = async (id) => { await api('revoke', { deviceId: id }); refreshDevices() }

window.forgetDevice = async (id) => { await api('forget', { deviceId: id }); refreshDevices() }

$('saveBtn').onclick = async () => {
  $('saveMsg').className = 'message'; $('saveMsg').textContent = '保存中…'
  const r = await api('config', {
    hubWssUrl: $('hubWssUrl').value, hubUser: $('hubUser').value,
    hubPass: $('hubPass').value, hubCaCert: $('hubCaCert').value,
    instanceName: $('instanceName').value,
    natsConfigPath: $('natsConfigPath').value, natsServerPath: $('natsServerPath').value,
  })
  if (r.ok) {
    // The stored values are what the fields should show again.
    editedFields.clear()
    $('saveMsg').className = 'message ok'; $('saveMsg').textContent = '已保存'
    refreshStatus()
    // Verify right after saving: a wrong password is invisible until the
    // phone fails, and that is the whole reason this round was confusing.
    void checkHub()
  }
  else { $('saveMsg').className = 'message error'; $('saveMsg').textContent = r.error || '保存失败' }
}

/**
 * The Hub fields as the page shows them.
 *
 * The read-only checks dial what the owner just typed rather than what the
 * profile has stored: on a new machine the address lives only in the form
 * until the first save, and the first save needs the certificate the fetch
 * brings back. An unrevealed password field posts an empty string, which the
 * route reads as "keep the stored one".
 */
function hubFormValues() {
  return { hubWssUrl: $('hubWssUrl').value, hubUser: $('hubUser').value, hubPass: $('hubPass').value }
}

async function checkHub() {
  $('hubCheckMsg').className = 'message checkResult'; $('hubCheckMsg').textContent = '正在校验整条链路…'
  const r = await api('hub-check', hubFormValues())
  const ok = r.reason === 'ok'
  const mark = (step) => (step.ok ? '✓ ' : '✗ ')
  const lines = (r.steps || []).map(step => mark(step) + step.message)
  // A certificate problem leaves the NATS path green while the phone still
  // cannot get in, so the colour follows the worst line rather than reason
  // alone. A port that will not answer is the one certificate verdict that
  // stays a warning: that is a blocked port, not a wrong certificate.
  const certBroken = !!r.certificate && r.certificate.ok === false && r.certificate.reason !== 'unreachable'
  const allOk = ok && !certBroken
  const blocked = certBroken || (!ok && r.reason !== 'unreachable')
  $('hubCheckMsg').className = 'message checkResult'
    + (allOk ? ' ok' : (blocked ? ' error' : ''))
  // Double-escaped on purpose: this code lives inside the page's own template
  // literal, where a single newline escape would become a real line break and
  // break the generated script.
  $('hubCheckMsg').textContent = lines.length > 0
    ? lines.join('\\n')
    : (ok ? '✓ ' : (r.reason === 'unreachable' ? '⚠ ' : '✗ ')) + r.message
}

$('hubCheckBtn').onclick = () => { void checkHub() }

/**
 * Fills the CA field from the Hub's own TLS chain.
 *
 * The field is marked as edited so the status poll cannot paste the stored
 * (empty) value back over what was just fetched; saving clears that flag.
 */
$('fetchCaBtn').onclick = async () => {
  $('fetchCaMsg').className = 'message'; $('fetchCaMsg').textContent = '正在从 Hub 取证书…'
  $('fetchCaBtn').disabled = true
  try {
    const r = await api('hub-ca/fetch', hubFormValues())
    if (r.ok && r.ca) {
      $('hubCaCert').value = r.ca.pem
      editedFields.add('hubCaCert')
      $('fetchCaMsg').className = 'message ok'
      $('fetchCaMsg').textContent = r.message + '\\n已填入证书字段，点「保存并测试」生效。'
      renderHubCa({ hubCaCert: r.ca.pem, hubCaSummary: r.ca, hubCaFingerprint: '' })
    } else {
      $('fetchCaMsg').className = 'message error'
      $('fetchCaMsg').textContent = r.message || r.error || '获取失败'
    }
  } catch (error) {
    $('fetchCaMsg').className = 'message error'; $('fetchCaMsg').textContent = String(error)
  } finally {
    $('fetchCaBtn').disabled = false
  }
}

$('startNatsBtn').onclick = async () => {
  $('natsMsg').className = 'message'; $('natsMsg').textContent = '启动中…'
  $('startNatsBtn').disabled = true
  try {
    const r = await api('nats/start', {})
    $('natsMsg').className = r.ok ? 'message ok' : 'message error'
    $('natsMsg').textContent = r.message || (r.ok ? '已启动' : '启动失败')
    refreshStatus()
  } catch (error) {
    $('natsMsg').className = 'message error'; $('natsMsg').textContent = String(error)
  } finally {
    $('startNatsBtn').disabled = false
  }
}

$('saveNatsPathBtn').onclick = async () => {
  $('natsPathMsg').className = 'message'; $('natsPathMsg').textContent = '保存中…'
  const r = await api('config', {
    natsConfigPath: $('natsConfigPath').value,
    natsServerPath: $('natsServerPath').value,
  })
  if (r.ok) {
    editedFields.delete('natsConfigPath')
    editedFields.delete('natsServerPath')
    $('natsPathMsg').className = 'message ok'; $('natsPathMsg').textContent = '已保存'
    refreshStatus()
  } else {
    $('natsPathMsg').className = 'message error'; $('natsPathMsg').textContent = r.error || '保存失败'
  }
}

$('repairBtn').onclick = async () => {
  $('repairMsg').className = 'message'; $('repairMsg').textContent = '处理中…'
  $('repairBtn').disabled = true
  try {
    const r = await api('migrate', {})
    $('repairMsg').className = r.state === 'error' ? 'message error' : 'message ok'
    $('repairMsg').textContent = r.state === 'error' ? '修复失败' : '已处理'
    await refreshStatus()
  } catch (error) {
    $('repairMsg').className = 'message error'; $('repairMsg').textContent = String(error)
  } finally {
    $('repairBtn').disabled = false
  }
}

$('pairBtn').onclick = async () => {
  $('pairErr').textContent = ''; $('qr').innerHTML = ''
  $('qrFullBtn').disabled = true
  closeQrFull()
  const r = await api('pair', {})
  if (r.error) { $('pairErr').textContent = r.error; return }
  $('qr').innerHTML = r.qrSvg
  pairing = { code: r.payload.code, expiresAt: r.expiresAt }
  $('qrFullBtn').disabled = false
  if (typeof r.hubWarning === 'string') {
    $('hubCheckMsg').className = 'message checkResult'; $('hubCheckMsg').textContent = '⚠ ' + r.hubWarning
  }
  renderQrMeta()
}

/** The live countdown is what tells you a code went stale mid-scan — without
    it a slow scan just looks broken. */
function renderQrMeta() {
  if (pairing === null) return
  const left = Math.max(0, Math.round((pairing.expiresAt - Date.now()) / 1000))
  const expired = left <= 0
  const text = expired
    ? '配对码已过期，请重新生成二维码'
    : '剩余 ' + left + ' 秒 · 配对码 ' + pairing.code
  $('qrExpiry').textContent = text
  $('qrExpiry').className = expired ? 'message error' : 'message'
  $('qrFullCode').textContent = pairing.code
  $('qrFullExpiry').textContent = expired ? '已过期，请关闭后重新生成' : '剩余 ' + left + ' 秒'
  if (expired) {
    $('qr').innerHTML = ''
    $('qrFullQr').innerHTML = ''
    $('qrFullBtn').disabled = true
    closeQrFull()
    pairing = null
  }
}

function openQrFull() {
  const svg = $('qr').innerHTML
  if (svg === '') return
  $('qrFullQr').innerHTML = svg
  $('qrFull').hidden = false
  renderQrMeta()
}

function closeQrFull() { $('qrFull').hidden = true }

$('qrFullBtn').onclick = openQrFull
$('qrFullClose').onclick = closeQrFull
// Clicking anywhere outside the code closes the fullscreen view too.
$('qrFull').addEventListener('click', event => { if (event.target === $('qrFull')) closeQrFull() })
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeQrFull() })

refreshStatus(); refreshDevices()
setInterval(refreshStatus, 5000)
setInterval(renderQrMeta, 1000)
</script>
</body>
</html>`
