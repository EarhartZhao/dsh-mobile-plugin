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
}

/** Register all console routes on the webserver; returns the disposer. */
export function registerConsoleRoutes(webServer: WebRouter, backend: ConsoleBackend): () => void {
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
      handler: (_req, res) => {
        const bridge = backend.bridge()
        const config = backend.currentConfig()
        json(res, 200, {
          ...bridge.status(),
          config: {
            hubWssUrl: config.hubWssUrl,
            hubUser: config.hubUser,
            hubPassConfigured: config.hubPass.length > 0,
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
      path: '/mobile-bridge/api/pair',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        try {
          const pairing = backend.bridge().createPairingQr()
          const text = JSON.stringify(pairing.payload)
          const qrSvg = await QRCode.toString(text, { type: 'svg', margin: 2 })
          json(res, 200, { expiresAt: pairing.expiresAt, payload: pairing.payload, qrSvg })
        } catch (error) {
          json(res, 400, { error: String(error) })
        }
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
  #qr svg { width: 240px; height: 240px; }
  #qrExpiry { font-size: 12px; opacity: .7; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td, th { text-align: left; padding: 6px 4px; border-bottom: 1px solid #8882; }
  .error { color: #dc2626; font-size: 13px; } .ok { color: #16a34a; font-size: 13px; }
</style>
</head>
<body>
<h1>dsh-mobile 桥接配置</h1>
<p id="statusLine">状态：<span id="status">加载中…</span></p>
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
<label>Hub 地址（wss://…:8443）</label><input id="hubWssUrl" placeholder="wss://115.159.57.137:8443">
<label>账号</label><input id="hubUser" placeholder="c-end-dsh">
<label>密码（不回填；留空表示不修改）</label><input id="hubPass" type="password" placeholder="••••••">
<label>实例 ID（字母/数字/短横线）</label><input id="instanceId" placeholder="home">
<div class="row">
  <button id="saveBtn">保存并连接</button>
  <span id="saveMsg"></span>
</div>

<h2>配对新设备</h2>
<div class="row">
  <button id="pairBtn">生成配对二维码</button>
  <span class="error" id="pairErr"></span>
</div>
<div id="qr"></div>
<p id="qrExpiry"></p>

<h2>已配对设备</h2>
<table><thead><tr><th>设备</th><th>配对时间</th><th>到期</th><th></th></tr></thead><tbody id="devices"></tbody></table>

<script>
const $ = id => document.getElementById(id)

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
    $('hubPass').placeholder = s.config.hubPassConfigured ? '已配置（留空保持不变）' : '未配置'
    $('pairBtn').disabled = s.connection !== 'connected'
  } catch (error) {
    $('status').textContent = '状态读取失败'
    $('lastError').textContent = String(error)
    $('pairBtn').disabled = true
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
  if (r.ok) { $('saveMsg').className = 'ok'; $('saveMsg').textContent = '已保存'; $('hubPass').value = ''; refreshStatus() }
  else { $('saveMsg').className = 'error'; $('saveMsg').textContent = r.error || '保存失败' }
}

$('pairBtn').onclick = async () => {
  $('pairErr').textContent = ''; $('qr').innerHTML = ''
  const r = await api('pair', {})
  if (r.error) { $('pairErr').textContent = r.error; return }
  $('qr').innerHTML = r.qrSvg
  $('qrExpiry').textContent = '配对码 ' + r.payload.code + '，' + Math.max(0, Math.round((r.expiresAt - Date.now()) / 1000)) + ' 秒内有效'
}

refreshStatus(); refreshDevices()
setInterval(refreshStatus, 5000)
</script>
</body>
</html>`
