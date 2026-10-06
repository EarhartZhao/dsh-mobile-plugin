/**
 * Browser half: the bridge's configuration on the Plugins page.
 *
 * The page owns the bundle title, status and description; this contribution
 * owns the working surface below them. It deliberately renders native dsh
 * primitives instead of embedding the standalone console: the common path is
 * one status line and one pairing action, while connection details, devices
 * and diagnostics stay behind three explicit tabs. The standalone console
 * remains available from the diagnostics tab for the rare full-page workflow.
 *
 * Bundle format: lazy-CJS factory (see scripts/build-client.mjs) served by
 * the dsh client module system at /plugins/<package name>/client.js, scoped
 * name and all (@dsh-earhartzhao/dsh-mobile-plugin/client.js).
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  Button,
  IconCheckOutlineRegular,
  IconLinkOutlineRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconTrashOutlineRegular,
  IconWarningOutlineRegular,
  SegmentedTabs,
  StateDot,
  Switch,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** The package name the Plugins page keys this bundle's configuration by. */
const BUNDLE_NAME = '@dsh-earhartzhao/dsh-mobile-plugin'

/** Props the Plugins page binds for one bundle configuration entry. */
interface ConfigViewProps {
  /** `summary` renders inline text only; `page` renders the configuration body. */
  view: 'summary' | 'page'
}

/** Minimal structural view of the slots service this page consumes. */
interface SlotsService {
  inject(slot: string, callback: () => unknown): void
  register(options: { name: string; key: string }, component: unknown): () => void
}

interface ClientContext {
  slots: SlotsService
}

type TabValue = 'connection' | 'pair' | 'devices' | 'advanced'

interface ConfigSnapshot {
  enabled: boolean
  hubWssUrl: string
  hubUser: string
  hubPassConfigured: boolean
  hubCaCert: string
  hubCaFingerprint: string
  hubCaSummary: {
    fingerprint: string
    subject: string
    validTo: string
    isCa: boolean
  } | null
  instanceId: string
  instanceName: string
  natsConfigPath: string
  natsServerPath: string
}

interface LocalNatsPart {
  path: string
  source: string
  exists: boolean
  candidates?: readonly string[]
}

interface BridgeStatus {
  enabled: boolean
  connection: 'connected' | 'connecting' | 'reconnecting' | 'disconnected'
  devices: number
  pluginVersion: string
  installedVersion: string | null
  versionDrift: string | null
  mobileApi: number
  buildId: string
  loadedFrom: string
  instanceId: string
  instanceName: string
  gatewayId: string | null
  startedAt: string | null
  uptimeMs: number
  lastConnectedAt: string | null
  lastReconnectAt: string | null
  lastError: string | null
  config: ConfigSnapshot
  localNats: {
    config: LocalNatsPart | null
    server: LocalNatsPart | null
  } | null
  localNatsRuntime: {
    running: boolean
    managed: boolean
    endpoint: string
    message: string
  } | null
  profile: {
    state: string
    shape: { bundleListed: boolean, legacyInsert: boolean, overrideRow: boolean } | null
    notes: readonly string[]
  } | null
  update: {
    current: string
    latest: string | null
    updatable: boolean | null
    phase: string | null
    message: string
    reason: string | null
  } | null
}

interface DeviceRecord {
  id: string
  name: string
  createdAt: string
  expiresAt: string
  lastSeenAt: string | null
  revoked: boolean
  revokedAt: string | null
}

interface HubCheckStep {
  key: string
  ok: boolean
  message: string
}

interface HubCheckResult {
  reason: string
  message: string
  certificate?: { ok: boolean, reason?: string, message: string }
  steps?: readonly HubCheckStep[]
}

interface PairingResult {
  expiresAt: number
  payload: { code: string }
  qrSvg: string
  hubWarning?: string
  error?: string
}

interface FormState {
  hubWssUrl: string
  hubUser: string
  hubPass: string
  hubCaCert: string
  hubCaFingerprint: string
  instanceId: string
  instanceName: string
  natsConfigPath: string
  natsServerPath: string
}

interface Notice {
  tone: 'idle' | 'ok' | 'error' | 'warning'
  text: string
}

const TAB_ITEMS = [
  { value: 'connection', label: '连接', id: 'dsh-mobile-tab-connection', panelId: 'dsh-mobile-tabpanel-connection' },
  { value: 'pair', label: '配对手机', id: 'dsh-mobile-tab-pair', panelId: 'dsh-mobile-tabpanel-pair' },
  { value: 'devices', label: '已配对设备', id: 'dsh-mobile-tab-devices', panelId: 'dsh-mobile-tabpanel-devices' },
  { value: 'advanced', label: '高级诊断', id: 'dsh-mobile-tab-advanced', panelId: 'dsh-mobile-tabpanel-advanced' },
] as const

const CONNECTION_LABELS = {
  connected: '已连接',
  connecting: '连接中',
  reconnecting: '重连中',
  disconnected: '未连接',
} as const

const PROFILE_LABELS: Record<string, string> = {
  ok: '组合包（正常）',
  migrated: '已迁移为组合包',
  'awaiting-restart': '重启后完成迁移',
  disabled: '未自动迁移',
  unavailable: '宿主未提供安装信息',
  error: '检查失败',
}

const PANEL_CSS = `
.dsh-mobile-panel {
  --dsh-mobile-border: var(--dsw-alias-border-l1, rgba(127, 127, 127, .18));
  --dsh-mobile-border-strong: var(--dsw-alias-border-l2, rgba(127, 127, 127, .28));
  --dsh-mobile-surface: var(--dsw-alias-bg-layer-1, transparent);
  --dsh-mobile-soft: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, .06));
  --dsh-mobile-text: var(--dsw-alias-label-primary, currentColor);
  --dsh-mobile-muted: var(--dsw-alias-label-secondary, rgba(127, 127, 127, .9));
  --dsh-mobile-quiet: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, .72));
  color: var(--dsh-mobile-text);
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
}
.dsh-mobile-panel * { box-sizing: border-box; }
.dsh-mobile-panel button { white-space: nowrap; }
.dsh-mobile-summary {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding: 0 0 16px;
  border-bottom: 1px solid var(--dsh-mobile-border);
}
.dsh-mobile-summary-main { min-width: 0; }
.dsh-mobile-state {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-height: 28px;
}
.dsh-mobile-state strong { font-size: 15px; font-weight: 600; }
.dsh-mobile-summary-copy {
  max-width: 720px;
  margin: 7px 0 0;
  color: var(--dsh-mobile-muted);
  font-size: 12px;
  line-height: 1.55;
}
.dsh-mobile-summary-actions {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
.dsh-mobile-switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--dsh-mobile-muted);
  font-size: 12px;
}
.dsh-mobile-tabs { margin: 12px 0 18px; }
.dsh-mobile-tabs [role="tab"] {
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-mobile-tab-body { min-height: 0; }
.dsh-mobile-section {
  display: grid;
  width: 100%;
  gap: 14px;
}
.dsh-mobile-section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.dsh-mobile-section-head h4 { margin: 0; font-size: 14px; font-weight: 600; }
.dsh-mobile-section-head p {
  margin: 3px 0 0;
  color: var(--dsh-mobile-muted);
  font-size: 12px;
  line-height: 1.5;
}
.dsh-mobile-fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
}
.dsh-mobile-field { display: grid; gap: 6px; min-width: 0; }
.dsh-mobile-field-full { grid-column: 1 / -1; }
.dsh-mobile-field label { color: var(--dsh-mobile-muted); font-size: 12px; font-weight: 500; }
.dsh-mobile-input,
.dsh-mobile-textarea {
  width: 100%;
  min-width: 0;
  min-height: 36px;
  padding: 7px 10px;
  border: 1px solid var(--dsh-mobile-border-strong);
  border-radius: var(--dsw-radius-sm, 8px);
  outline: none;
  background: var(--dsh-mobile-surface);
  color: var(--dsh-mobile-text);
  font: inherit;
  font-size: 13px;
}
.dsh-mobile-textarea {
  min-height: 92px;
  resize: vertical;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
}
.dsh-mobile-input:focus,
.dsh-mobile-textarea:focus {
  border-color: var(--dsw-alias-brand-primary, #3964fe);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary, #3964fe) 18%, transparent);
}
.dsh-mobile-input::placeholder,
.dsh-mobile-textarea::placeholder { color: var(--dsh-mobile-quiet); }
.dsh-mobile-password { display: flex; align-items: center; gap: 6px; }
.dsh-mobile-password .dsh-mobile-input { flex: 1; }
.dsh-mobile-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dsh-mobile-notice {
  margin: 0;
  color: var(--dsh-mobile-muted);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-line;
}
.dsh-mobile-notice[data-tone="ok"] { color: var(--dsw-alias-state-success-primary, #18794e); }
.dsh-mobile-notice[data-tone="warning"] { color: var(--dsw-alias-state-warn-primary, #8a5a00); }
.dsh-mobile-notice[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #b42318); }
.dsh-mobile-callout {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 10px 12px;
  border: 1px solid var(--dsh-mobile-border);
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsh-mobile-soft);
}
.dsh-mobile-callout[data-tone="warning"] { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #8a5a00) 45%, transparent); }
.dsh-mobile-callout[data-tone="error"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #b42318) 45%, transparent); }
.dsh-mobile-callout svg { flex: none; margin-top: 1px; }
.dsh-mobile-steps {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dsh-mobile-step {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  color: var(--dsh-mobile-muted);
  font-size: 12px;
}
.dsh-mobile-step[data-ok="true"] { color: var(--dsw-alias-state-success-primary, #18794e); }
.dsh-mobile-step[data-ok="false"] { color: var(--dsw-alias-state-error-primary, #b42318); }
.dsh-mobile-qr-layout {
  display: grid;
  grid-template-columns: minmax(220px, 300px) minmax(0, 1fr);
  gap: 22px;
  align-items: start;
}
.dsh-mobile-qr {
  display: grid;
  min-height: 260px;
  padding: 14px;
  place-items: center;
  border: 1px solid var(--dsh-mobile-border);
  border-radius: var(--dsw-radius-md, 12px);
  background: #fff;
}
.dsh-mobile-qr[data-empty="true"] {
  border-style: dashed;
  background: var(--dsh-mobile-soft);
  color: var(--dsh-mobile-muted);
  font-size: 12px;
}
.dsh-mobile-qr svg { display: block; width: min(100%, 260px); height: auto; }
.dsh-mobile-qr-copy { display: grid; align-content: start; gap: 12px; }
.dsh-mobile-code {
  margin: 0;
  color: var(--dsh-mobile-text);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 18px;
  font-weight: 600;
  letter-spacing: 1px;
}
.dsh-mobile-device-list {
  --dsh-mobile-device-row-height: 66px;
  display: grid;
  gap: 0;
  margin: 0;
  padding: 0;
  min-height: calc(var(--dsh-mobile-device-row-height) * 3 + 1px);
  max-height: calc(var(--dsh-mobile-device-row-height) * 6 + 1px);
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  list-style: none;
  border-top: 1px solid var(--dsh-mobile-border);
}
.dsh-mobile-device {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 14px;
  align-items: center;
  height: var(--dsh-mobile-device-row-height);
  padding: 12px 0;
  border-bottom: 1px solid var(--dsh-mobile-border);
}
.dsh-mobile-device-name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
}
.dsh-mobile-device-name span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-mobile-device-meta {
  margin: 4px 0 0;
  color: var(--dsh-mobile-muted);
  font-size: 12px;
  line-height: 1.45;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-mobile-empty {
  padding: 30px 0;
  color: var(--dsh-mobile-muted);
  font-size: 13px;
  text-align: center;
}
.dsh-mobile-details {
  border: 1px solid var(--dsh-mobile-border);
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsh-mobile-soft);
}
.dsh-mobile-details > summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  cursor: pointer;
  color: var(--dsh-mobile-muted);
  font-size: 12px;
  font-weight: 500;
  list-style: none;
}
.dsh-mobile-details > summary::-webkit-details-marker { display: none; }
.dsh-mobile-details > summary::after {
  width: 7px;
  height: 7px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  content: "";
  transform: rotate(45deg);
  transition: transform 160ms ease;
}
.dsh-mobile-details[open] > summary::after { transform: rotate(225deg); }
.dsh-mobile-details-body {
  display: grid;
  gap: 12px;
  padding: 0 12px 12px;
  border-top: 1px solid var(--dsh-mobile-border);
}
.dsh-mobile-details-body > :first-child { margin-top: 12px; }
.dsh-mobile-subsection {
  display: grid;
  gap: 10px;
  padding-top: 16px;
  border-top: 1px solid var(--dsh-mobile-border);
}
.dsh-mobile-subsection:first-child { padding-top: 0; border-top: 0; }
.dsh-mobile-subsection h5 { margin: 0; font-size: 13px; font-weight: 600; }
.dsh-mobile-grid-2 {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 18px;
  align-items: start;
}
.dsh-mobile-dl {
  display: grid;
  grid-template-columns: minmax(110px, auto) minmax(0, 1fr);
  gap: 7px 14px;
  margin: 0;
  font-size: 12px;
}
.dsh-mobile-dl dt { color: var(--dsh-mobile-muted); }
.dsh-mobile-dl dd { margin: 0; overflow-wrap: anywhere; }
.dsh-mobile-link {
  color: var(--dsw-alias-brand-primary, #3964fe);
  font-size: 12px;
  text-decoration: none;
  text-underline-offset: 2px;
}
.dsh-mobile-link:hover { text-decoration: underline; }
@media (max-width: 760px) {
  .dsh-mobile-summary { flex-direction: column; }
  .dsh-mobile-summary-actions { justify-content: flex-start; }
  .dsh-mobile-fields,
  .dsh-mobile-grid-2,
  .dsh-mobile-qr-layout { grid-template-columns: minmax(0, 1fr); }
  .dsh-mobile-field-full { grid-column: auto; }
  .dsh-mobile-summary-actions > button { flex: 1 1 auto; }
}
`

async function api<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/mobile-bridge/api/${path}`, body === undefined ? {} : {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-dsh-mobile-console': '1',
    },
    body: JSON.stringify(body),
  })
  return await response.json() as T
}

function formatTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString('zh-CN', { hour12: false })
}

function hostFromUrl(value: string): string {
  if (value.trim() === '') return 'Hub 未配置'
  try {
    return new URL(value).host
  } catch {
    return value
  }
}

function formFromStatus(status: BridgeStatus): FormState {
  return {
    hubWssUrl: status.config.hubWssUrl,
    hubUser: status.config.hubUser,
    hubPass: '',
    hubCaCert: status.config.hubCaCert,
    hubCaFingerprint: status.config.hubCaFingerprint,
    instanceId: status.config.instanceId,
    instanceName: status.config.instanceName,
    natsConfigPath: status.config.natsConfigPath,
    natsServerPath: status.config.natsServerPath,
  }
}

function connectionTone(connection: BridgeStatus['connection']): 'done' | 'warning' | 'ongoing' | 'error' | 'idle' {
  if (connection === 'connected') return 'done'
  if (connection === 'connecting' || connection === 'reconnecting') return 'ongoing'
  if (connection === 'disconnected') return 'error'
  return 'idle'
}

function DetailMessage({ notice }: { notice: Notice | null }): ReactNode {
  if (notice === null || notice.text === '') return null
  return <p className="dsh-mobile-notice" data-tone={notice.tone} role="status">{notice.text}</p>
}

function MobileBridgePanel(): ReactNode {
  const [status, setStatus] = useState<BridgeStatus | null>(null)
  const [devices, setDevices] = useState<readonly DeviceRecord[]>([])
  const [tab, setTab] = useState<TabValue>('connection')
  const [deviceTab, setDeviceTab] = useState<'active' | 'revoked'>('active')
  const [form, setForm] = useState<FormState | null>(null)
  const formLoaded = useRef(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [connectionNotice, setConnectionNotice] = useState<Notice | null>(null)
  const [hubCheck, setHubCheck] = useState<HubCheckResult | null>(null)
  const [checkingHub, setCheckingHub] = useState(false)
  const [saving, setSaving] = useState(false)
  const [runtimeBusy, setRuntimeBusy] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [pairing, setPairing] = useState<PairingResult | null>(null)
  const [pairingError, setPairingError] = useState('')
  const [pairingBusy, setPairingBusy] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [advancedNotice, setAdvancedNotice] = useState<Notice | null>(null)
  const [updateNotice, setUpdateNotice] = useState<Notice | null>(null)
  const [natsPaths, setNatsPaths] = useState({ config: '', server: '' })
  const natsLoaded = useRef(false)
  const [refreshing, setRefreshing] = useState(false)
  const [devicesRefreshing, setDevicesRefreshing] = useState(false)
  const [natsStarting, setNatsStarting] = useState(false)

  const refreshStatus = useCallback(async () => {
    try {
      const next = await api<BridgeStatus>('status')
      setStatus(next)
      if (!formLoaded.current) {
        setForm(formFromStatus(next))
        formLoaded.current = true
      }
      if (!natsLoaded.current) {
        setNatsPaths({
          config: next.config.natsConfigPath,
          server: next.config.natsServerPath,
        })
        natsLoaded.current = true
      }
      return true
    } catch (error) {
      setNotice({ tone: 'error', text: `无法读取桥接状态：${String(error)}` })
      return false
    }
  }, [])

  const refreshDevices = useCallback(async () => {
    try {
      const result = await api<{ devices: readonly DeviceRecord[] }>('devices')
      setDevices(Array.isArray(result.devices) ? result.devices : [])
      return true
    } catch (error) {
      setNotice({ tone: 'error', text: `无法读取设备列表：${String(error)}` })
      return false
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
    void refreshDevices()
    const statusTimer = window.setInterval(() => { void refreshStatus() }, 5000)
    const devicesTimer = window.setInterval(() => { void refreshDevices() }, 10000)
    return () => {
      window.clearInterval(statusTimer)
      window.clearInterval(devicesTimer)
    }
  }, [refreshDevices, refreshStatus])

  useEffect(() => {
    if (pairing === null) return
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [pairing])

  const patchConfig = useCallback(async (patch: Record<string, unknown>) => {
    const result = await api<{ ok?: boolean, error?: string }>('config', patch)
    if (result.error !== undefined) throw new Error(result.error)
    await refreshStatus()
    return result
  }, [refreshStatus])

  const runHubCheck = useCallback(async () => {
    setCheckingHub(true)
    setConnectionNotice({ tone: 'idle', text: '正在检查本机 NATS、Hub 和当前实例…' })
    try {
      const result = await api<HubCheckResult>('hub-check')
      setHubCheck(result)
      const certBroken = result.certificate !== undefined
        && !result.certificate.ok
        && result.certificate.reason !== 'unreachable'
      const ok = result.reason === 'ok' && !certBroken
      setConnectionNotice({
        tone: ok ? 'ok' : certBroken ? 'error' : 'warning',
        text: ok ? '整条链路可用。' : result.message,
      })
    } catch (error) {
      setConnectionNotice({ tone: 'error', text: `检查失败：${String(error)}` })
    } finally {
      setCheckingHub(false)
    }
  }, [])

  /**
   * The header's 刷新. Unlike the background poll it speaks: the button locks
   * into 刷新中 while the reads are in flight and the summary line lands on
   * 已刷新, so a click on a healthy bridge is visibly acknowledged.
   */
  const refreshAll = useCallback(async () => {
    setRefreshing(true)
    setNotice({ tone: 'idle', text: '正在刷新状态与设备…' })
    try {
      const results = await Promise.all([refreshStatus(), refreshDevices()])
      await runHubCheck()
      if (results.every(Boolean)) {
        setNotice({ tone: 'ok', text: `已刷新 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}` })
      }
    } catch (error) {
      setNotice({ tone: 'error', text: `刷新失败：${String(error)}` })
    } finally {
      setRefreshing(false)
    }
  }, [refreshDevices, refreshStatus, runHubCheck])

  /** The devices tab's own 刷新, a narrower version of {@link refreshAll}. */
  const refreshDeviceList = useCallback(async () => {
    setDevicesRefreshing(true)
    try {
      if (await refreshDevices()) {
        setNotice({ tone: 'ok', text: `设备列表已刷新 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}` })
      }
    } catch (error) {
      setNotice({ tone: 'error', text: `刷新失败：${String(error)}` })
    } finally {
      setDevicesRefreshing(false)
    }
  }, [refreshDevices])

  const saveConnection = useCallback(async () => {
    if (form === null) return
    setSaving(true)
    setConnectionNotice({ tone: 'idle', text: '正在保存并检查连接…' })
    try {
      await patchConfig({
        hubWssUrl: form.hubWssUrl,
        hubUser: form.hubUser,
        ...(form.hubPass === '' ? {} : { hubPass: form.hubPass }),
        hubCaCert: form.hubCaCert,
        hubCaFingerprint: form.hubCaFingerprint,
        instanceId: form.instanceId,
        instanceName: form.instanceName,
      })
      setForm(current => current === null ? current : { ...current, hubPass: '' })
      setConnectionNotice({ tone: 'ok', text: '配置已保存。' })
      await runHubCheck()
    } catch (error) {
      setConnectionNotice({ tone: 'error', text: `保存失败：${String(error)}` })
    } finally {
      setSaving(false)
    }
  }, [form, patchConfig, runHubCheck])

  const setEnabled = useCallback(async (enabled: boolean) => {
    setRuntimeBusy(true)
    setNotice({ tone: 'idle', text: enabled ? '正在启用移动桥…' : '正在停用移动桥…' })
    try {
      await patchConfig({ enabled })
      setNotice({ tone: 'ok', text: enabled ? '移动桥已启用。' : '移动桥已停用。' })
    } catch (error) {
      setNotice({ tone: 'error', text: `切换失败：${String(error)}` })
    } finally {
      setRuntimeBusy(false)
    }
  }, [patchConfig])

  const generatePairing = useCallback(async () => {
    setPairingBusy(true)
    setPairingError('')
    setPairing(null)
    try {
      const result = await api<PairingResult>('pair', {})
      if (result.error !== undefined) {
        setPairingError(result.error)
        return
      }
      setPairing(result)
      setNow(Date.now())
    } catch (error) {
      setPairingError(`生成失败：${String(error)}`)
    } finally {
      setPairingBusy(false)
    }
  }, [])

  const revokeDevice = useCallback(async (device: DeviceRecord) => {
    if (!window.confirm(`吊销 ${device.name} 的访问权限？该设备必须重新配对。`)) return
    setNotice({ tone: 'idle', text: `正在吊销 ${device.name}…` })
    try {
      await api('revoke', { deviceId: device.id })
      setNotice({ tone: 'ok', text: `${device.name} 已吊销。` })
      await refreshDevices()
      await refreshStatus()
    } catch (error) {
      setNotice({ tone: 'error', text: `吊销失败：${String(error)}` })
    }
  }, [refreshDevices, refreshStatus])

  const forgetDevice = useCallback(async (device: DeviceRecord) => {
    setNotice({ tone: 'idle', text: `正在删除 ${device.name} 的记录…` })
    try {
      await api('forget', { deviceId: device.id })
      await refreshDevices()
      await refreshStatus()
      setNotice({ tone: 'ok', text: `${device.name} 的记录已删除。` })
    } catch (error) {
      setNotice({ tone: 'error', text: `删除失败：${String(error)}` })
    }
  }, [refreshDevices, refreshStatus])

  const startNats = useCallback(async () => {
    setNatsStarting(true)
    setAdvancedNotice({ tone: 'idle', text: '正在启动本机 NATS…' })
    try {
      const result = await api<{ ok?: boolean, message?: string }>('nats/start', {})
      setAdvancedNotice({
        tone: result.ok ? 'ok' : 'error',
        text: result.message ?? (result.ok ? '已启动。' : '启动失败。'),
      })
      await refreshStatus()
    } catch (error) {
      setAdvancedNotice({ tone: 'error', text: `启动失败：${String(error)}` })
    } finally {
      setNatsStarting(false)
    }
  }, [refreshStatus])

  const saveNatsPaths = useCallback(async () => {
    setAdvancedNotice({ tone: 'idle', text: '正在保存路径…' })
    try {
      await patchConfig(natsPaths)
      setAdvancedNotice({ tone: 'ok', text: '本机 NATS 路径已保存。' })
    } catch (error) {
      setAdvancedNotice({ tone: 'error', text: `保存失败：${String(error)}` })
    }
  }, [natsPaths, patchConfig])

  const checkUpdate = useCallback(async () => {
    setUpdateNotice({ tone: 'idle', text: '正在检查更新…' })
    try {
      const result = await api<BridgeStatus['update'] & { error?: string }>('update/check')
      if (result?.error !== undefined) {
        setUpdateNotice({ tone: 'error', text: result.error })
        return
      }
      setUpdateNotice({
        tone: result?.phase === 'failed' ? 'error' : result?.updatable ? 'warning' : 'ok',
        text: result?.message ?? result?.reason ?? '已完成检查。',
      })
      await refreshStatus()
    } catch (error) {
      setUpdateNotice({ tone: 'error', text: `检查失败：${String(error)}` })
    }
  }, [refreshStatus])

  const applyUpdate = useCallback(async () => {
    setUpdateNotice({ tone: 'idle', text: '正在更新插件…' })
    try {
      const result = await api<BridgeStatus['update'] & { error?: string }>('update/apply', {})
      if (result?.error !== undefined) {
        setUpdateNotice({ tone: 'error', text: result.error })
        return
      }
      setUpdateNotice({
        tone: result?.phase === 'failed' ? 'error' : 'ok',
        text: result?.message ?? '更新已处理，按提示重启 dsh 后生效。',
      })
      await refreshStatus()
    } catch (error) {
      setUpdateNotice({ tone: 'error', text: `更新失败：${String(error)}` })
    }
  }, [refreshStatus])

  const enabled = status?.enabled ?? true
  const connected = status?.connection === 'connected'
  const connectionText = status === null
    ? '读取状态中'
    : status.enabled
      ? CONNECTION_LABELS[status.connection]
      : '已停用'
  const activeDevices = devices.filter(device => !device.revoked)
  const revokedDevices = devices.filter(device => device.revoked)
  const shownDevices = deviceTab === 'active' ? activeDevices : revokedDevices
  const pairSecondsLeft = pairing === null
    ? 0
    : Math.max(0, Math.round((pairing.expiresAt - now) / 1000))
  const pairExpired = pairing !== null && pairSecondsLeft <= 0

  return (
    <>
      <style data-plugin={BUNDLE_NAME}>{PANEL_CSS}</style>
      <div className="dsh-mobile-panel" data-mobile-bridge-panel>
        <header className="dsh-mobile-summary">
          <div className="dsh-mobile-summary-main">
            <div className="dsh-mobile-state">
              <StateDot state={enabled ? connectionTone(status?.connection ?? 'disconnected') : 'idle'} />
              <strong>{connectionText}</strong>
              {status === null ? null : <Tag tone="neutral">v{status.pluginVersion}</Tag>}
              {status === null ? null : <Tag tone="quiet">{status.devices} 台设备</Tag>}
            </div>
            <p className="dsh-mobile-summary-copy">
              {status === null
                ? '正在读取实例与 Hub 信息。'
                : `${status.instanceName || status.instanceId} · ${hostFromUrl(status.config.hubWssUrl)}`}
            </p>
          </div>
          <div className="dsh-mobile-summary-actions">
            <Button
              variant="outline"
              size="sm"
              icon={<IconRefreshOutlineRegular size={14} />}
              disabled={refreshing}
              onClick={() => { void refreshAll() }}
            >
              {refreshing ? '刷新中' : '刷新'}
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<IconPlusOutlineRegular size={14} />}
              onClick={() => { setTab('pair'); void generatePairing() }}
              disabled={!enabled || !connected}
            >
              配对手机
            </Button>
            <span className="dsh-mobile-switch">
              <Switch
                checked={enabled}
                disabled={runtimeBusy}
                label={enabled ? '停用移动桥' : '启用移动桥'}
                onChange={(next) => { void setEnabled(next) }}
              />
              {enabled ? '已启用' : '已停用'}
            </span>
          </div>
        </header>

        <div style={{ minHeight: 10 }}><DetailMessage notice={notice} /></div>
        {status?.versionDrift === null || status?.versionDrift === undefined
          ? null
          : (
            <div className="dsh-mobile-callout" data-tone="warning" style={{ marginBottom: 12 }}>
              <IconWarningOutlineRegular size={15} />
              <p className="dsh-mobile-notice" data-tone="warning">{status.versionDrift}</p>
            </div>
          )}

        <SegmentedTabs
          className="dsh-mobile-tabs"
          items={TAB_ITEMS}
          value={tab}
          onChange={setTab}
          label="移动桥设置"
        />

        <div
          className="dsh-mobile-tab-body"
          id={`dsh-mobile-tabpanel-${tab}`}
          role="tabpanel"
          aria-labelledby={`dsh-mobile-tab-${tab}`}
        >
          {tab === 'connection' && form !== null
            ? (
              <section className="dsh-mobile-section" aria-label="连接">
                <div className="dsh-mobile-section-head">
                  <div>
                    <h4>连接 Hub</h4>
                    <p>保存后立即验证本机 NATS、Hub 和当前实例。</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    icon={<IconLinkOutlineRegular size={14} />}
                    disabled={checkingHub}
                    onClick={() => { void runHubCheck() }}
                  >
                    {checkingHub ? '检查中' : '测试链路'}
                  </Button>
                </div>
                <div className="dsh-mobile-fields">
                  <div className="dsh-mobile-field dsh-mobile-field-full">
                    <label htmlFor="dsh-mobile-hub-url">Hub 地址</label>
                    <input
                      id="dsh-mobile-hub-url"
                      className="dsh-mobile-input"
                      value={form.hubWssUrl}
                      placeholder="wss://203.0.113.10:8443"
                      autoComplete="off"
                      spellCheck={false}
                      onChange={event => { setForm({ ...form, hubWssUrl: event.currentTarget.value }) }}
                    />
                  </div>
                  <div className="dsh-mobile-field">
                    <label htmlFor="dsh-mobile-hub-user">账号</label>
                    <input
                      id="dsh-mobile-hub-user"
                      className="dsh-mobile-input"
                      value={form.hubUser}
                      placeholder="Hub 的 C 端受限账号"
                      autoComplete="off"
                      spellCheck={false}
                      onChange={event => { setForm({ ...form, hubUser: event.currentTarget.value }) }}
                    />
                  </div>
                  <div className="dsh-mobile-field">
                    <label htmlFor="dsh-mobile-hub-pass">密码</label>
                    <span className="dsh-mobile-password">
                      <input
                        id="dsh-mobile-hub-pass"
                        className="dsh-mobile-input"
                        type={showPassword ? 'text' : 'password'}
                        value={form.hubPass}
                        placeholder={status?.config.hubPassConfigured ? '已配置，留空保持不变' : '未配置'}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={event => { setForm({ ...form, hubPass: event.currentTarget.value }) }}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          const reveal = !showPassword
                          setShowPassword(reveal)
                          if (!reveal || form.hubPass !== '' || !status?.config.hubPassConfigured) return
                          void api<{ hubPass?: string, error?: string }>('reveal', {})
                            .then((result) => {
                              if (result.error !== undefined) {
                                setConnectionNotice({ tone: 'error', text: result.error })
                                return
                              }
                              setForm(current => current === null
                                ? current
                                : { ...current, hubPass: result.hubPass ?? '' })
                            })
                            .catch((error: unknown) => {
                              setConnectionNotice({ tone: 'error', text: `读取密码失败：${String(error)}` })
                            })
                        }}
                      >
                        {showPassword ? '隐藏' : '显示'}
                      </Button>
                    </span>
                  </div>
                  <div className="dsh-mobile-field">
                    <label htmlFor="dsh-mobile-instance-id">实例 ID</label>
                    <input
                      id="dsh-mobile-instance-id"
                      className="dsh-mobile-input"
                      value={form.instanceId}
                      placeholder="home"
                      autoComplete="off"
                      spellCheck={false}
                      onChange={event => { setForm({ ...form, instanceId: event.currentTarget.value }) }}
                    />
                  </div>
                  <div className="dsh-mobile-field">
                    <label htmlFor="dsh-mobile-instance-name">本机名称</label>
                    <input
                      id="dsh-mobile-instance-name"
                      className="dsh-mobile-input"
                      value={form.instanceName}
                      placeholder="例如：家里的 Mac mini"
                      autoComplete="off"
                      spellCheck={false}
                      onChange={event => { setForm({ ...form, instanceName: event.currentTarget.value }) }}
                    />
                  </div>
                </div>

                <details className="dsh-mobile-details">
                  <summary>Hub CA 证书</summary>
                  <div className="dsh-mobile-details-body">
                    <p className="dsh-mobile-notice">
                      {form.hubCaCert === ''
                        ? '未配置：二维码不带证书，只适用于公共 CA 签发的 Hub。'
                        : status?.config.hubCaSummary === null || status?.config.hubCaSummary === undefined
                          ? '已填写，但当前无法解析，请检查是否为完整 PEM。'
                          : `${status.config.hubCaSummary.subject} · 有效期至 ${status.config.hubCaSummary.validTo}`}
                    </p>
                    <textarea
                      className="dsh-mobile-textarea"
                      value={form.hubCaCert}
                      placeholder={'-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----'}
                      spellCheck={false}
                      onChange={event => { setForm({ ...form, hubCaCert: event.currentTarget.value }) }}
                    />
                    <div className="dsh-mobile-actions">
                      <Button
                        variant="outline"
                        size="sm"
                        icon={<IconLinkOutlineRegular size={14} />}
                        onClick={() => {
                          void api<{ ok?: boolean, ca?: { pem: string }, message?: string, error?: string }>('hub-ca/fetch')
                            .then((result) => {
                              if (result.ok && result.ca !== undefined) {
                                setForm(current => current === null
                                  ? current
                                  : { ...current, hubCaCert: result.ca?.pem ?? '' })
                                setConnectionNotice({ tone: 'ok', text: result.message ?? '已从 Hub 获取证书，保存后生效。' })
                              } else {
                                setConnectionNotice({ tone: 'error', text: result.error ?? result.message ?? '获取证书失败。' })
                              }
                            })
                            .catch((error: unknown) => {
                              setConnectionNotice({ tone: 'error', text: `获取证书失败：${String(error)}` })
                            })
                        }}
                      >
                        从 Hub 获取
                      </Button>
                      <span className="dsh-mobile-notice">公开材料，不含私钥。</span>
                    </div>
                  </div>
                </details>

                <div className="dsh-mobile-actions">
                  <Button variant="primary" size="sm" disabled={saving} onClick={() => { void saveConnection() }}>
                    {saving ? '保存中…' : '保存并测试'}
                  </Button>
                  <DetailMessage notice={connectionNotice} />
                </div>
                {hubCheck?.steps === undefined || hubCheck.steps.length === 0
                  ? null
                  : (
                    <ul className="dsh-mobile-steps">
                      {hubCheck.steps.map(step => (
                        <li className="dsh-mobile-step" data-ok={step.ok} key={step.key}>
                          {step.ok
                            ? <IconCheckOutlineRegular size={14} />
                            : <IconWarningOutlineRegular size={14} />}
                          <span>{step.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}
              </section>
            )
            : null}

          {tab === 'pair'
            ? (
              <section className="dsh-mobile-section" aria-label="配对手机">
                <div className="dsh-mobile-section-head">
                  <div>
                    <h4>配对新设备</h4>
                    <p>二维码有效期 120 秒，手机扫码后会自动保存访问令牌。</p>
                  </div>
                  <Button
                    variant={pairing === null || pairExpired ? 'primary' : 'outline'}
                    size="sm"
                    icon={<IconPlusOutlineRegular size={14} />}
                    disabled={pairingBusy || !enabled || !connected}
                    onClick={() => { void generatePairing() }}
                  >
                    {pairingBusy ? '生成中…' : pairing === null || pairExpired ? '生成二维码' : '重新生成'}
                  </Button>
                </div>

                {!enabled
                  ? <div className="dsh-mobile-callout" data-tone="warning"><IconWarningOutlineRegular size={15} /><p className="dsh-mobile-notice" data-tone="warning">移动桥已停用，启用后才能配对。</p></div>
                  : !connected
                    ? <div className="dsh-mobile-callout" data-tone="warning"><IconWarningOutlineRegular size={15} /><p className="dsh-mobile-notice" data-tone="warning">本机 NATS 未连接，请先在「连接」中保存并测试，或到「高级诊断」启动本机 NATS。</p></div>
                    : null}

                <div className="dsh-mobile-qr-layout">
                  <div className="dsh-mobile-qr" data-empty={pairing === null || pairExpired}>
                    {pairing === null || pairExpired
                      ? '生成后在这里扫码'
                      : <span dangerouslySetInnerHTML={{ __html: pairing.qrSvg }} />}
                  </div>
                  <div className="dsh-mobile-qr-copy">
                    {pairing === null
                      ? <p className="dsh-mobile-notice">点击「生成二维码」，然后用手机 App 的配对入口扫码。</p>
                      : pairExpired
                        ? <p className="dsh-mobile-notice" data-tone="error">二维码已过期，请重新生成。</p>
                        : (
                          <>
                            <p className="dsh-mobile-code">{pairing.payload.code}</p>
                            <p className="dsh-mobile-notice">剩余 {pairSecondsLeft} 秒</p>
                          </>
                        )}
                    {pairingError === ''
                      ? null
                      : <p className="dsh-mobile-notice" data-tone="error">{pairingError}</p>}
                    {pairing?.hubWarning === undefined
                      ? null
                      : (
                        <div className="dsh-mobile-callout" data-tone="warning">
                          <IconWarningOutlineRegular size={15} />
                          <p className="dsh-mobile-notice" data-tone="warning">{pairing.hubWarning}</p>
                        </div>
                      )}
                  </div>
                </div>
              </section>
            )
            : null}

          {tab === 'devices'
            ? (
              <section className="dsh-mobile-section" aria-label="已配对设备">
                <div className="dsh-mobile-section-head">
                  <div>
                    <h4>设备访问</h4>
                    <p>吊销后设备令牌立即失效；删除只会清理已吊销的历史记录。</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    icon={<IconRefreshOutlineRegular size={14} />}
                    disabled={devicesRefreshing}
                    onClick={() => { void refreshDeviceList() }}
                  >
                    {devicesRefreshing ? '刷新中' : '刷新'}
                  </Button>
                </div>
                <SegmentedTabs
                  items={[
                    { value: 'active', label: `正在使用 ${activeDevices.length}`, id: 'dsh-mobile-device-tab-active', panelId: 'dsh-mobile-device-panel' },
                    { value: 'revoked', label: `已吊销 ${revokedDevices.length}`, id: 'dsh-mobile-device-tab-revoked', panelId: 'dsh-mobile-device-panel' },
                  ]}
                  value={deviceTab}
                  onChange={setDeviceTab}
                  label="设备状态"
                />
                {shownDevices.length === 0
                  ? <p className="dsh-mobile-empty">{deviceTab === 'active' ? '还没有已配对的设备。' : '没有已吊销的设备。'}</p>
                  : (
                    <ul className="dsh-mobile-device-list" id="dsh-mobile-device-panel">
                      {shownDevices.map(device => (
                        <li className="dsh-mobile-device" key={device.id}>
                          <div>
                            <div className="dsh-mobile-device-name">
                              <span title={device.name}>{device.name}</span>
                              <Tag tone={device.revoked ? 'neutral' : 'success'}>{device.revoked ? '已吊销' : '有效'}</Tag>
                            </div>
                            <p className="dsh-mobile-device-meta">
                              最近活动 {device.lastSeenAt === null ? '从未' : formatTime(device.lastSeenAt)}
                              {' · '}
                              到期 {device.expiresAt.slice(0, 10)}
                            </p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            icon={<IconTrashOutlineRegular size={13} />}
                            onClick={() => {
                              if (device.revoked) void forgetDevice(device)
                              else void revokeDevice(device)
                            }}
                          >
                            {device.revoked ? '删除记录' : '吊销'}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
              </section>
            )
            : null}

          {tab === 'advanced'
            ? (
              <section className="dsh-mobile-section" aria-label="高级诊断">
                <div className="dsh-mobile-subsection">
                  <h5>本机 NATS</h5>
                  <div className="dsh-mobile-state">
                    <StateDot state={status?.localNatsRuntime?.running ? 'done' : 'idle'} />
                    <strong>{status?.localNatsRuntime?.message ?? '本机 NATS 状态未知'}</strong>
                  </div>
                  <div className="dsh-mobile-actions">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={natsStarting}
                      onClick={() => { void startNats() }}
                    >
                      {natsStarting ? '启动中…' : '启动本机 NATS'}
                    </Button>
                    <DetailMessage notice={advancedNotice} />
                  </div>
                  {status?.localNats?.config === null || status?.localNats?.config === undefined
                    ? null
                    : (
                      <p className="dsh-mobile-notice">
                        配置 {status.localNats.config.exists ? '已找到' : '未找到'}：{status.localNats.config.path}
                        {status.localNats.server === null
                          ? ''
                          : `\n服务 ${status.localNats.server.exists ? '已找到' : '未找到'}：${status.localNats.server.path}`}
                      </p>
                    )}
                  <details className="dsh-mobile-details">
                    <summary>手动指定路径</summary>
                    <div className="dsh-mobile-details-body">
                      <div className="dsh-mobile-fields">
                        <div className="dsh-mobile-field">
                          <label htmlFor="dsh-mobile-nats-config">leaf.conf 路径</label>
                          <input
                            id="dsh-mobile-nats-config"
                            className="dsh-mobile-input"
                            value={natsPaths.config}
                            placeholder="留空 = 自动查找"
                            spellCheck={false}
                            onChange={event => { setNatsPaths(current => ({ ...current, config: event.currentTarget.value })) }}
                          />
                        </div>
                        <div className="dsh-mobile-field">
                          <label htmlFor="dsh-mobile-nats-server">nats-server 路径</label>
                          <input
                            id="dsh-mobile-nats-server"
                            className="dsh-mobile-input"
                            value={natsPaths.server}
                            placeholder="留空 = 自动查找"
                            spellCheck={false}
                            onChange={event => { setNatsPaths(current => ({ ...current, server: event.currentTarget.value })) }}
                          />
                        </div>
                      </div>
                      <div className="dsh-mobile-actions">
                        <Button variant="outline" size="sm" onClick={() => { void saveNatsPaths() }}>保存路径</Button>
                      </div>
                    </div>
                  </details>
                </div>

                <div className="dsh-mobile-subsection">
                  <h5>安装与更新</h5>
                  <div className="dsh-mobile-grid-2">
                    <dl className="dsh-mobile-dl">
                      <dt>安装形态</dt>
                      <dd>{status?.profile === null || status?.profile === undefined ? '—' : PROFILE_LABELS[status.profile.state] ?? status.profile.state}</dd>
                      <dt>当前版本</dt>
                      <dd>{status?.pluginVersion ?? '—'}</dd>
                      <dt>磁盘版本</dt>
                      <dd>{status?.installedVersion ?? '—'}</dd>
                    </dl>
                    <div className="dsh-mobile-actions">
                      <Button variant="outline" size="sm" onClick={() => { void checkUpdate() }}>检查更新</Button>
                      {status?.update?.updatable === true
                        ? <Button variant="primary" size="sm" onClick={() => { void applyUpdate() }}>更新到 {status.update.latest}</Button>
                        : null}
                      <DetailMessage notice={updateNotice} />
                    </div>
                  </div>
                </div>

                <div className="dsh-mobile-subsection">
                  <h5>运行信息</h5>
                  <dl className="dsh-mobile-dl">
                    <dt>实例</dt>
                    <dd>
                      {status === null
                        ? '—'
                        : status.instanceName === status.instanceId
                          ? status.instanceName
                          : `${status.instanceName} · ${status.instanceId}`}
                    </dd>
                    <dt>网关 ID</dt>
                    <dd>{status?.gatewayId ?? '—'}</dd>
                    <dt>最近连接</dt>
                    <dd>{formatTime(status?.lastConnectedAt)}</dd>
                    <dt>最近重连</dt>
                    <dd>{formatTime(status?.lastReconnectAt)}</dd>
                    <dt>构建 ID</dt>
                    <dd>{status?.buildId ?? '—'}</dd>
                    <dt>加载路径</dt>
                    <dd>{status?.loadedFrom ?? '—'}</dd>
                    <dt>最近错误</dt>
                    <dd>{status?.lastError ?? '无'}</dd>
                  </dl>
                  <a className="dsh-mobile-link" href="/mobile-bridge" target="_blank" rel="noreferrer">
                    打开独立控制台
                  </a>
                </div>
              </section>
            )
            : null}
        </div>
      </div>
    </>
  )
}

function MobileBridgeConfig({ view }: ConfigViewProps): ReactNode {
  if (view !== 'page') return null
  return <MobileBridgePanel />
}

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register({
      name: 'plugins.bundle.config',
      key: BUNDLE_NAME,
    }, MobileBridgeConfig))
}
