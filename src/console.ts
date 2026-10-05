/**
 * Loopback console: a self-contained page plus JSON routes on the dsh
 * webserver (bound to 127.0.0.1 by default, so only this machine's browser
 * can reach it). This is the onboarding wizard: server-info form, connection
 * status, pairing QR, and device management.
 *
 * The official settings card (src/client) embeds this same page, so both
 * surfaces share one backend and never diverge.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import QRCode from 'qrcode'
import type { MobileBridge, UpdateReport } from './index.js'
import type { Config } from './config.js'
import { checkHubCertificate, checkHubPath, normalizeHubWssUrl, type HubCheckResult } from './hub-check.js'
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
  /** Check (and repair) how the profile mounts this plugin's row. */
  repairProfile: () => Promise<ProfileRepairReport>
  /** Overridable so route tests stay off the network. */
  checkHub?: (config: Config) => Promise<HubCheckResult>
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
      handler: (req, res) => {
        const rejected = consoleRequestRejection(req, { mutating: false })
        if (rejected !== null) return json(res, rejected.status, { error: rejected.error })
        const bridge = backend.bridge()
        const config = backend.currentConfig()
        const ca = readHubCa(config.hubCaCert)
        // The password is deliberately absent here: this response is polled
        // every few seconds, and a secret that rides a poll is available to any
        // local process at any moment. It comes from `/api/reveal` instead, only
        // when the owner asks to see it.
        json(res, 200, {
          ...bridge.status(),
          localNats: backend.localNats?.() ?? null,
          config: {
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
        const hub = await checkHub(backend.currentConfig())
        if (hub.reason === 'rejected') return json(res, 400, { error: hub.message })
        // A certificate that is missing, unreadable or simply not the one the
        // Hub signs with does not stop the QR from being minted — the owner may
        // be fixing the Hub side right now — but a scan that will fail at the
        // handshake deserves a warning here instead of that same failure on the
        // phone, where nothing can explain it.
        const certificate = await checkHubCertificate(backend.currentConfig())
        const hubWarning = [hub.ok ? null : hub.message, certificate.ok ? null : certificate.message]
          .filter((line): line is string => line !== null)
          .join('\n\n')
        // A Hub that cannot reach this instance means the phone will get a bare
        // no-responders 503. Unlike a credential typo this can heal on its own
        // (the Leaf reconnects), so warn instead of refusing to mint.
        try {
          const pairing = backend.bridge().createPairingQr()
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
        const config = backend.currentConfig()
        const result = await checkHub(config)
        // The certificate is the one link the phone cannot report on: a wrong
        // one is an opaque handshake failure there, so it rides along here as
        // a step the owner can read.
        const certificate = await checkHubCertificate(config)
        json(res, 200, {
          ...result,
          certificate,
          steps: [...result.steps, { key: 'certificate', ok: certificate.ok, message: certificate.message }],
        })
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
<title>dsh-mobile 桥接配置</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 24px auto; padding: 0 16px 32px; }
  h1 { font-size: 20px; } h2 { font-size: 15px; margin-top: 28px; }
  label { display: block; font-size: 13px; margin: 10px 0 4px; opacity: .8; }
  input { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #8884; border-radius: 6px; background: transparent; color: inherit; }
  textarea { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #8884; border-radius: 6px; background: transparent; color: inherit;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; resize: vertical; }
  button { padding: 8px 16px; border: 0; border-radius: 6px; background: #2563eb; color: #fff; cursor: pointer; }
  button.secondary { background: #8884; color: inherit; }
  button:disabled { opacity: .5; cursor: default; }
  .row { display: flex; gap: 8px; margin-top: 14px; align-items: center; }
  #status { font-size: 13px; padding: 6px 10px; border-radius: 6px; background: #8882; }
  .health { display: grid; grid-template-columns: minmax(110px, auto) 1fr; gap: 7px 14px; padding: 14px; border: 1px solid #8883; border-radius: 8px; font-size: 12px; }
  .health dt { opacity: .65; } .health dd { margin: 0; overflow-wrap: anywhere; }
  #qr { margin-top: 16px; text-align: center; }
  /* The SVG carries its own white background and quiet zone; sizing it up is
     what makes the camera lock on in well under a second. */
  #qr svg { width: min(360px, 92vw); height: auto; background: #fff; border-radius: 8px; }
  #qrExpiry { font-size: 13px; opacity: .8; margin: 8px 0 0; }
  #qrFull { position: fixed; inset: 0; z-index: 50; background: #fff; color: #111;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; }
  #qrFull[hidden] { display: none; }
  #qrFull svg { width: min(84vmin, 92vw); height: auto; }
  #qrFull .fullMeta { font-size: 14px; opacity: .75; text-align: center; }
  #qrFull .fullMeta b { font-size: 20px; letter-spacing: 2px; }
  #qrFull .fullActions { display: flex; gap: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td, th { text-align: left; padding: 6px 4px; border-bottom: 1px solid #8882; }
  .tabs { display: flex; gap: 6px; margin: 0 0 8px; }
  .tab { padding: 4px 12px; border: 1px solid #8884; border-radius: 999px; background: transparent; color: inherit; font-size: 13px; cursor: pointer; }
  .tab[aria-selected="true"] { border-color: #2563eb; color: #2563eb; background: #2563eb1a; }
  .tab .count { opacity: .6; margin-left: 5px; font-variant-numeric: tabular-nums; }
  /* The device list is the only unbounded section here: cap it and scroll,
     with the header pinned so the columns stay labelled. */
  .devicePane { max-height: 520px; overflow: auto; border: 1px solid #8883; border-radius: 8px; }
  .devicePane table { border-collapse: separate; border-spacing: 0; }
  .devicePane th { position: sticky; top: 0; background: Canvas; }
  .devicePane td, .devicePane th { padding: 6px 10px; }
  .devicePane td:last-child, .devicePane th:last-child { text-align: right; }
  .deviceState { opacity: .6; }
  .error { color: #dc2626; font-size: 13px; } .ok { color: #16a34a; font-size: 13px; }
</style>
</head>
<body>
<h1>dsh-mobile 桥接配置</h1>
<p id="statusLine">状态：<span id="status">加载中…</span></p>
<p id="profileLine">安装形态：<span id="profileShape">检查中…</span>
  <button id="repairBtn" class="secondary" type="button" style="margin-left:8px" hidden>修复安装形态</button>
  <span id="repairMsg"></span></p>
<p id="profileNotes" style="font-size:12px;opacity:.7;margin:2px 0 0;white-space:pre-line"></p>
<div class="row">
  <button id="startNatsBtn" class="secondary">启动本地 NATS</button>
  <span id="natsMsg" style="white-space:pre-line"></span>
</div>
<p id="natsPathLine" style="font-size:12px;opacity:.7;margin:2px 0 0;white-space:pre-line"></p>
<div class="row">
  <input id="natsConfigPath" placeholder="leaf.conf 路径（留空 = 自动查找）" style="flex:1" autocomplete="off" spellcheck="false">
  <button id="saveNatsPathBtn" class="secondary" type="button" style="white-space:nowrap">保存路径</button>
  <span id="natsPathMsg"></span>
</div>
<div class="row">
  <input id="natsServerPath" placeholder="nats-server 路径（留空 = 自动查找，含 PATH）" style="flex:1" autocomplete="off" spellcheck="false">
</div>
<dl class="health">
  <dt>插件版本</dt><dd id="pluginVersion">—</dd>
  <dt>mobileApi</dt><dd id="mobileApi">—</dd>
  <dt>构建 ID</dt><dd id="buildId">—</dd>
  <dt>实例 ID</dt><dd id="activeInstance">—</dd>
  <dt>本机名称</dt><dd id="activeInstanceName">—</dd>
  <dt>实际加载路径</dt><dd id="loadedFrom">—</dd>
  <dt>桥启动时间</dt><dd id="startedAt">—</dd>
  <dt>最近连接</dt><dd id="lastConnectedAt">—</dd>
  <dt>最近重连</dt><dd id="lastReconnectAt">—</dd>
  <dt>功能</dt><dd id="features">—</dd>
  <dt>最近错误</dt><dd id="lastError">无</dd>
</dl>

<h2>插件更新</h2>
<div class="row">
  <button id="updateCheckBtn" class="secondary">刷新</button>
  <button id="updateApplyBtn" hidden>更新</button>
  <span id="updateMsg"></span>
</div>
<p id="updateHint" style="font-size:12px;opacity:.7;margin:6px 0 0;white-space:pre-line"></p>

<h2>服务器信息（NATS Hub）</h2>
<p style="font-size:12px;opacity:.7;margin:0 0 4px">配对二维码里带的就是这里的地址与账号凭证，手机靠它连 Hub，因此三项都必须先填写并保存，否则二维码扫了也连不上。地址可以只填主机或 IP，缺端口按 8443 补。</p>
<label>Hub 地址（wss://…:8443）</label><input id="hubWssUrl" placeholder="wss://203.0.113.10:8443">
<label>账号（Hub 的 C 端受限账号）</label><input id="hubUser" placeholder="你的 Hub 账号">
<label>密码（必填；留空表示不修改）</label>
<div style="display:flex;gap:8px;align-items:center">
  <input id="hubPass" type="text" placeholder="未配置" autocomplete="off" spellcheck="false">
  <button id="hubPassToggle" class="secondary" type="button" style="white-space:nowrap">隐藏</button>
</div>
<label>Hub CA 证书（ca.crt 内容；二维码会把它带给手机当信任锚）</label>
<textarea id="hubCaCert" rows="5" spellcheck="false" autocomplete="off" placeholder="-----BEGIN CERTIFICATE-----&#10;…&#10;-----END CERTIFICATE-----"></textarea>
<p id="hubCaHint" style="font-size:12px;margin:4px 0 0;opacity:.75"></p>
<label>实例 ID（字母/数字/短横线）</label><input id="instanceId" placeholder="home">
<label>本机名称（手机上显示的名字；留空则显示实例 ID）</label><input id="instanceName" placeholder="例如：家里的 Mac mini">
<div class="row">
  <button id="saveBtn">保存并连接</button>
  <button id="hubCheckBtn" class="secondary">测试 Hub 账号</button>
  <span id="saveMsg"></span>
</div>
<p id="hubCheckMsg" style="font-size:12px;margin:6px 0 0;white-space:pre-line"></p>

<h2>配对新设备</h2>
<div class="row">
  <button id="pairBtn">生成配对二维码</button>
  <button id="qrFullBtn" class="secondary" disabled>放大显示</button>
  <span class="error" id="pairErr"></span>
</div>
<p id="pairHint" style="font-size:12px;opacity:.7">需先在上方配置 Hub 账号密码并连接本地 NATS，才能生成可用二维码</p>
<div id="qr"></div>
<p id="qrExpiry"></p>
<p class="hintLine" style="font-size:12px;opacity:.7;margin:6px 0 0">同一时间最多 3 个配对码有效（120 秒）；重新生成会让最早的码作废，卡住时直接再点一次即可。</p>

<div id="qrFull" hidden>
  <div id="qrFullQr"></div>
  <p class="fullMeta">配对码 <b id="qrFullCode">—</b><br><span id="qrFullExpiry"></span></p>
  <div class="fullActions">
    <button id="qrFullClose" class="secondary">关闭放大</button>
  </div>
</div>

<h2>已配对设备</h2>
<div class="tabs" role="tablist">
  <button class="tab" id="tabActive" role="tab" aria-selected="true" onclick="showDevices('active')">正在使用<span class="count" id="countActive">0</span></button>
  <button class="tab" id="tabRevoked" role="tab" aria-selected="false" onclick="showDevices('revoked')">已吊销<span class="count" id="countRevoked">0</span></button>
</div>
<div class="devicePane">
  <table><thead><tr><th>设备</th><th>配对时间</th><th>到期</th><th></th></tr></thead><tbody id="devices"></tbody></table>
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

for (const id of ['hubWssUrl', 'hubUser', 'hubCaCert', 'instanceId', 'instanceName', 'natsConfigPath', 'natsServerPath']) {
  $(id).addEventListener('input', () => { editedFields.add(id) })
}

/** Shows the configured certificate, or why there is nothing to show. */
function renderHubCa(config) {
  prefill('hubCaCert', config.hubCaCert || '')
  const hint = $('hubCaHint')
  hint.className = ''
  if (!config.hubCaCert) {
    hint.textContent = '未配置：二维码不带证书，App 里也没有内置任何 CA。'
      + '只有由公共 CA 签发证书的 Hub 能连上；自签证书的 Hub 必须在这里填 ca.crt 全文。'
    return
  }
  const summary = config.hubCaSummary
  if (!summary) {
    hint.className = 'error'
    hint.textContent = '无法解析：请粘贴 ca.crt 的完整 PEM（含 BEGIN/END CERTIFICATE 行）或它的 base64 内容。'
    return
  }
  hint.textContent = summary.subject + '｜有效期至 ' + summary.validTo + '｜SHA-256 ' + summary.fingerprint
  const configured = (config.hubCaFingerprint || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  const actual = summary.fingerprint.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  if (configured && configured !== actual) {
    hint.className = 'error'
    // Double-escaped: this code lives inside the page's own template literal.
    hint.textContent += '\\n配置的指纹与证书不一致，手机扫码会拒绝这个 Hub。'
  } else if (!summary.isCa) {
    hint.className = 'error'
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
      $('saveMsg').className = 'error'
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
    $('status').textContent = { connected: '已连接', connecting: '连接中', reconnecting: '重连中', disconnected: '未连接' }[s.connection] || s.connection
    $('pluginVersion').textContent = s.pluginVersion || '—'
    $('mobileApi').textContent = String(s.mobileApi ?? '—')
    $('buildId').textContent = s.buildId || '—'
    $('activeInstance').textContent = s.instanceId || '—'
    $('activeInstanceName').textContent = s.instanceName || s.instanceId || '—'
    $('loadedFrom').textContent = s.loadedFrom || '—'
    $('startedAt').textContent = formatTime(s.startedAt)
    $('lastConnectedAt').textContent = formatTime(s.lastConnectedAt)
    $('lastReconnectAt').textContent = formatTime(s.lastReconnectAt)
    $('features').textContent = Array.isArray(s.features) ? s.features.join(' · ') : '—'
    $('lastError').textContent = s.lastError || '无'
    renderProfile(s.profile)
    renderLocalNats(s.localNats)
    // A check or an install in flight owns the panel until it answers, so the
    // poll must not repaint over "正在更新…" with the last stored report.
    if (!updateBusy) renderUpdate(s.update)
    // Prefill only while the field is untouched; a poll every 5s must not
    // paste over an edit in progress (see prefill).
    prefill('hubWssUrl', s.config.hubWssUrl)
    prefill('hubUser', s.config.hubUser)
    renderHubCa(s.config)
    prefill('instanceId', s.config.instanceId)
    prefill('instanceName', s.config.instanceName || '')
    prefill('natsConfigPath', s.config.natsConfigPath || '')
    prefill('natsServerPath', s.config.natsServerPath || '')
    // Never prefill the password here — this response is polled every 5s and
    // 「显示」 is the one call that fetches the stored value.
    $('hubPass').placeholder = s.config.hubPassConfigured ? '已配置（留空保持不变）' : '未配置'
    // A QR minted without the Hub credential is dead on arrival, so the
    // credential gate comes before the connection gate.
    const hubReady = s.config.hubWssUrl.trim() !== '' && s.config.hubUser.trim() !== '' && s.config.hubPassConfigured
    $('pairBtn').disabled = !hubReady || s.connection !== 'connected'
    $('pairHint').style.color = hubReady ? '' : '#dc2626'
    if (!hubReady) {
      $('pairHint').textContent = '二维码要带上 Hub 的账号凭证，手机没有它连不上 Hub：请先在上方填写 Hub 地址、账号、密码并保存'
    } else if (s.connection === 'connected') {
      $('pairHint').textContent = '本地 NATS 已连接，可以生成二维码'
    } else {
      $('pairHint').textContent = '当前状态为“' + ({ connecting: '连接中', reconnecting: '重连中', disconnected: '未连接' }[s.connection] || s.connection) + '”，请先点击“启动本地 NATS”'
    }
  } catch (error) {
    $('status').textContent = '状态读取失败'
    $('lastError').textContent = String(error)
    $('pairBtn').disabled = true
    $('pairHint').style.color = ''
    $('pairHint').textContent = '状态不可用，请先启动本地 NATS'
  }
}

function formatTime(value) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
}

/**
 * Show which leaf.conf the launch button will read. The path is discovered
 * (plugin home, then platform conventions) unless the owner set one, so a
 * machine that keeps the file elsewhere needs to see the path that was tried
 * before it can fix it — the failure alone names only one of them.
 */
function renderLocalNats(localNats) {
  const config = localNats && localNats.config
  const server = localNats && localNats.server
  if (!config || typeof config.path !== 'string') {
    $('natsPathLine').textContent = ''
    return
  }
  const line = (label, part) => {
    if (!part || typeof part.path !== 'string') return ''
    const source = { env: '来自环境变量', config: '来自本页填写', 'default': '自动查找' }[part.source] || part.source
    return (part.exists ? '✓ ' : '✗ ') + label + '：' + part.path + '（' + source + '）'
  }
  const lines = [line('配置文件', config), line('nats-server', server)].filter(text => text !== '')
  if (config.exists && server && server.exists) {
    lines.push('启动命令：' + server.path + ' -c ' + config.path)
  }
  for (const part of [config, server]) {
    if (part && !part.exists && Array.isArray(part.candidates)) {
      lines.push('查找范围：\\n' + part.candidates.map(p => '  · ' + p).join('\\n'))
    }
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
  $('updateMsg').className = u.phase === 'failed' ? 'error' : (u.phase === 'restart-required' ? 'ok' : '')
  $('updateMsg').textContent = text
  // The reason explains a missing update button ("有新版本，但这个宿主没有插件
  // 管理器"); it is the same sentence as the message on a failed check, and
  // repeating it twice reads like two problems.
  $('updateHint').textContent = u.reason && u.reason !== text ? u.reason : ''
}

$('updateCheckBtn').onclick = async () => {
  updateBusy = true
  $('updateCheckBtn').disabled = true
  $('updateMsg').className = ''; $('updateMsg').textContent = '正在获取最新版本…'
  $('updateHint').textContent = ''
  try {
    const r = await api('update/check')
    if (r.error) { $('updateApplyBtn').hidden = true; $('updateMsg').className = 'error'; $('updateMsg').textContent = r.error; return }
    renderUpdate(r)
  } catch (error) {
    $('updateMsg').className = 'error'; $('updateMsg').textContent = String(error)
  } finally {
    updateBusy = false
    $('updateCheckBtn').disabled = false
  }
}

$('updateApplyBtn').onclick = async () => {
  updateBusy = true
  $('updateCheckBtn').disabled = true
  $('updateApplyBtn').disabled = true
  $('updateMsg').className = ''; $('updateMsg').textContent = '正在更新…'
  $('updateHint').textContent = ''
  try {
    const r = await api('update/apply', {})
    if (r.error) { $('updateMsg').className = 'error'; $('updateMsg').textContent = r.error; return }
    renderUpdate(r)
  } catch (error) {
    $('updateMsg').className = 'error'; $('updateMsg').textContent = String(error)
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
    '<td>' + d.expiresAt.slice(0, 10) + '</td><td>' +
    (d.revoked
      // The record itself is the only thing left to act on, and it is already
      // dead: deleting it needs no confirmation dialog.
      ? '<span class="deviceState">已吊销</span> <button class="secondary" onclick="forgetDevice(\\'' + d.id + '\\')">删除记录</button>'
      : '<button class="secondary" onclick="revoke(\\'' + d.id + '\\')">吊销</button>') + '</td></tr>'
  ).join('') || '<tr><td colspan="4" class="deviceState">' +
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
  $('saveMsg').className = ''; $('saveMsg').textContent = '保存中…'
  const r = await api('config', {
    hubWssUrl: $('hubWssUrl').value, hubUser: $('hubUser').value,
    hubPass: $('hubPass').value, hubCaCert: $('hubCaCert').value,
    instanceId: $('instanceId').value,
    instanceName: $('instanceName').value,
    natsConfigPath: $('natsConfigPath').value, natsServerPath: $('natsServerPath').value,
  })
  if (r.ok) {
    // The stored values are what the fields should show again.
    editedFields.clear()
    $('saveMsg').className = 'ok'; $('saveMsg').textContent = '已保存'
    refreshStatus()
    // Verify right after saving: a wrong password is invisible until the
    // phone fails, and that is the whole reason this round was confusing.
    void checkHub()
  }
  else { $('saveMsg').className = 'error'; $('saveMsg').textContent = r.error || '保存失败' }
}

async function checkHub() {
  $('hubCheckMsg').className = ''; $('hubCheckMsg').textContent = '正在校验整条链路…'
  const r = await api('hub-check', {})
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
  $('hubCheckMsg').className = allOk ? 'ok' : (blocked ? 'error' : '')
  // Double-escaped on purpose: this code lives inside the page's own template
  // literal, where a single newline escape would become a real line break and
  // break the generated script.
  $('hubCheckMsg').textContent = lines.length > 0
    ? lines.join('\\n')
    : (ok ? '✓ ' : (r.reason === 'unreachable' ? '⚠ ' : '✗ ')) + r.message
}

$('hubCheckBtn').onclick = () => { void checkHub() }

$('startNatsBtn').onclick = async () => {
  $('natsMsg').className = ''; $('natsMsg').textContent = '启动中…'
  $('startNatsBtn').disabled = true
  try {
    const r = await api('nats/start', {})
    $('natsMsg').className = r.ok ? 'ok' : 'error'
    $('natsMsg').textContent = r.message || (r.ok ? '已启动' : '启动失败')
    refreshStatus()
  } catch (error) {
    $('natsMsg').className = 'error'; $('natsMsg').textContent = String(error)
  } finally {
    $('startNatsBtn').disabled = false
  }
}

$('saveNatsPathBtn').onclick = async () => {
  $('natsPathMsg').className = ''; $('natsPathMsg').textContent = '保存中…'
  const r = await api('config', {
    natsConfigPath: $('natsConfigPath').value,
    natsServerPath: $('natsServerPath').value,
  })
  if (r.ok) {
    editedFields.delete('natsConfigPath')
    editedFields.delete('natsServerPath')
    $('natsPathMsg').className = 'ok'; $('natsPathMsg').textContent = '已保存'
    refreshStatus()
  } else {
    $('natsPathMsg').className = 'error'; $('natsPathMsg').textContent = r.error || '保存失败'
  }
}

$('repairBtn').onclick = async () => {
  $('repairMsg').className = ''; $('repairMsg').textContent = '处理中…'
  $('repairBtn').disabled = true
  try {
    const r = await api('migrate', {})
    $('repairMsg').className = r.state === 'error' ? 'error' : 'ok'
    $('repairMsg').textContent = r.state === 'error' ? '修复失败' : '已处理'
    await refreshStatus()
  } catch (error) {
    $('repairMsg').className = 'error'; $('repairMsg').textContent = String(error)
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
    $('hubCheckMsg').className = ''; $('hubCheckMsg').textContent = '⚠ ' + r.hubWarning
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
  $('qrExpiry').className = expired ? 'error' : ''
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
