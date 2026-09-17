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
import { checkHubCredentials, type HubCheckResult } from './hub-check.js'

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
  /** Overridable so route tests stay off the network. */
  checkHub?: (config: Config) => Promise<HubCheckResult>
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
 * unknown peer is treated as remote. Only the console secret below uses this
 * today — the wizard is the owner's own screen on their own machine, and
 * showing the saved password is what makes a wrong one visible, but the same
 * response served to another origin would hand it out.
 */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const remoteAddress = req.socket.remoteAddress
  return remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1'
}

/** Register all console routes on the webserver; returns the disposer. */
export function registerConsoleRoutes(webServer: WebRouter, backend: ConsoleBackend): () => void {
  const checkHub = backend.checkHub ?? ((config: Config) => checkHubCredentials(config))
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
        const bridge = backend.bridge()
        const config = backend.currentConfig()
        json(res, 200, {
          ...bridge.status(),
          config: {
            hubWssUrl: config.hubWssUrl,
            hubUser: config.hubUser,
            hubPassConfigured: config.hubPass.length > 0,
            // Loopback surfaces get the password itself so the field can show
            // what is actually stored; every other peer keeps the boolean.
            ...(isLoopbackRequest(req) ? { hubPass: config.hubPass } : {}),
            instanceId: config.instanceId,
          },
        })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/mobile-bridge/api/config',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        try {
          const body = await readJson(req)
          const patch: Partial<Config> = {}
          if (typeof body.hubWssUrl === 'string') patch.hubWssUrl = body.hubWssUrl.trim()
          if (typeof body.hubUser === 'string') patch.hubUser = body.hubUser.trim()
          if (typeof body.hubPass === 'string' && body.hubPass.length > 0) patch.hubPass = body.hubPass
          if (typeof body.instanceId === 'string') patch.instanceId = body.instanceId.trim()
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
        const remoteAddress = req.socket.remoteAddress
        if (remoteAddress !== undefined
          && remoteAddress !== '127.0.0.1'
          && remoteAddress !== '::1'
          && remoteAddress !== '::ffff:127.0.0.1') {
          return json(res, 403, { error: 'loopback only' })
        }
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
      path: '/mobile-bridge/api/pair',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
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
      handler: async (_req, res) => {
        const result = await checkHub(backend.currentConfig())
        json(res, 200, result)
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/mobile-bridge/api/devices',
      handler: (_req, res) => {
        json(res, 200, { devices: backend.bridge().listDevices() })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/mobile-bridge/api/revoke',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        const body = await readJson(req)
        const ok = await backend.bridge().revokeDevice(String(body.deviceId ?? ''))
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
  .error { color: #dc2626; font-size: 13px; } .ok { color: #16a34a; font-size: 13px; }
</style>
</head>
<body>
<h1>dsh-mobile 桥接配置</h1>
<p id="statusLine">状态：<span id="status">加载中…</span></p>
<div class="row">
  <button id="startNatsBtn" class="secondary">启动本地 NATS</button>
  <span id="natsMsg"></span>
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
<label>Hub 地址（wss://…:8443）</label><input id="hubWssUrl" placeholder="wss://115.159.57.137:8443">
<label>账号（Hub 的 C 端受限账号）</label><input id="hubUser" placeholder="c-end-dsh">
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
<p id="hubCheckMsg" style="font-size:12px;margin:6px 0 0"></p>

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
<table><thead><tr><th>设备</th><th>配对时间</th><th>到期</th><th></th></tr></thead><tbody id="devices"></tbody></table>

<script>
const $ = id => document.getElementById(id)

/** The code currently on screen, or null once it has expired. */
let pairing = null

/** Set once the owner edits the password field, so the 5s status poll stops
 *  refilling it. Cleared after a successful save. */
let hubPassDirty = false
$('hubPass').addEventListener('input', () => { hubPassDirty = true })
$('hubPassToggle').onclick = () => {
  const field = $('hubPass')
  const reveal = field.type === 'password'
  field.type = reveal ? 'text' : 'password'
  $('hubPassToggle').textContent = reveal ? '隐藏' : '显示'
}

async function api(path, body) {
  const res = await fetch('/mobile-bridge/api/' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
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
    $('hubWssUrl').value = s.config.hubWssUrl
    $('hubUser').value = s.config.hubUser
    $('instanceId').value = s.config.instanceId
    // Prefill from the saved value, but never while the field is being edited
    // or holds unsaved input — status is polled every 5s.
    if (!hubPassDirty && typeof s.config.hubPass === 'string') $('hubPass').value = s.config.hubPass
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

async function refreshDevices() {
  const { devices } = await api('devices')
  $('devices').innerHTML = devices.map(d =>
    '<tr><td>' + d.name + '</td><td>' + d.createdAt.slice(0, 10) + '</td><td>' + d.expiresAt.slice(0, 10) + '</td><td>' +
    (d.revoked ? '已吊销' : '<button class="secondary" onclick="revoke(\\'' + d.id + '\\')">吊销</button>') + '</td></tr>'
  ).join('') || '<tr><td colspan="4" style="opacity:.6">暂无设备</td></tr>'
}

window.revoke = async (id) => { await api('revoke', { deviceId: id }); refreshDevices() }

$('saveBtn').onclick = async () => {
  $('saveMsg').className = ''; $('saveMsg').textContent = '保存中…'
  const r = await api('config', {
    hubWssUrl: $('hubWssUrl').value, hubUser: $('hubUser').value,
    hubPass: $('hubPass').value, instanceId: $('instanceId').value,
  })
  if (r.ok) {
    $('saveMsg').className = 'ok'; $('saveMsg').textContent = '已保存'
    hubPassDirty = false
    refreshStatus()
    // Verify right after saving: a wrong password is invisible until the
    // phone fails, and that is the whole reason this round was confusing.
    void checkHub()
  }
  else { $('saveMsg').className = 'error'; $('saveMsg').textContent = r.error || '保存失败' }
}

async function checkHub() {
  $('hubCheckMsg').className = ''; $('hubCheckMsg').textContent = '正在校验 Hub 账号…'
  const r = await api('hub-check', {})
  const ok = r.reason === 'ok'
  $('hubCheckMsg').className = ok ? 'ok' : (r.reason === 'unreachable' ? '' : 'error')
  $('hubCheckMsg').textContent = (ok ? '✓ ' : (r.reason === 'unreachable' ? '⚠ ' : '✗ ')) + r.message
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
