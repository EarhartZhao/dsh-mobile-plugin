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
import type { MobileBridge } from './index.js'
import type { Config } from './config.js'
import { checkHubPath, type HubCheckResult } from './hub-check.js'
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
            instanceId: config.instanceId,
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
          if (typeof body.hubWssUrl === 'string') patch.hubWssUrl = body.hubWssUrl.trim()
          if (typeof body.hubUser === 'string') patch.hubUser = body.hubUser.trim()
          if (typeof body.hubPass === 'string' && body.hubPass.length > 0) patch.hubPass = body.hubPass
          if (typeof body.instanceId === 'string') patch.instanceId = body.instanceId.trim()
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
            hubWarning: hub.ok ? undefined : hub.message,
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
        const result = await checkHub(backend.currentConfig())
        json(res, 200, result)
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
  <dt>实际加载路径</dt><dd id="loadedFrom">—</dd>
  <dt>桥启动时间</dt><dd id="startedAt">—</dd>
  <dt>最近连接</dt><dd id="lastConnectedAt">—</dd>
  <dt>最近重连</dt><dd id="lastReconnectAt">—</dd>
  <dt>功能</dt><dd id="features">—</dd>
  <dt>最近错误</dt><dd id="lastError">无</dd>
</dl>

<h2>服务器信息（NATS Hub）</h2>
<p style="font-size:12px;opacity:.7;margin:0 0 4px">配对二维码里带的就是这里的地址与账号凭证，手机靠它连 Hub，因此三项都必须先填写并保存，否则二维码扫了也连不上。</p>
<label>Hub 地址（wss://…:8443）</label><input id="hubWssUrl" placeholder="wss://203.0.113.10:8443">
<label>账号（Hub 的 C 端受限账号）</label><input id="hubUser" placeholder="你的 Hub 账号">
<label>密码（必填；留空表示不修改）</label>
<div style="display:flex;gap:8px;align-items:center">
  <input id="hubPass" type="text" placeholder="未配置" autocomplete="off" spellcheck="false">
  <button id="hubPassToggle" class="secondary" type="button" style="white-space:nowrap">隐藏</button>
</div>
<label>实例 ID（字母/数字/短横线）</label><input id="instanceId" placeholder="home">
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
    $('loadedFrom').textContent = s.loadedFrom || '—'
    $('startedAt').textContent = formatTime(s.startedAt)
    $('lastConnectedAt').textContent = formatTime(s.lastConnectedAt)
    $('lastReconnectAt').textContent = formatTime(s.lastReconnectAt)
    $('features').textContent = Array.isArray(s.features) ? s.features.join(' · ') : '—'
    $('lastError').textContent = s.lastError || '无'
    renderProfile(s.profile)
    renderLocalNats(s.localNats)
    $('hubWssUrl').value = s.config.hubWssUrl
    $('hubUser').value = s.config.hubUser
    $('instanceId').value = s.config.instanceId
    $('natsConfigPath').value = s.config.natsConfigPath || ''
    $('natsServerPath').value = s.config.natsServerPath || ''
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
    hubPass: $('hubPass').value, instanceId: $('instanceId').value,
    natsConfigPath: $('natsConfigPath').value, natsServerPath: $('natsServerPath').value,
  })
  if (r.ok) {
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
  $('hubCheckMsg').className = ok ? 'ok' : (r.reason === 'unreachable' ? '' : 'error')
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
