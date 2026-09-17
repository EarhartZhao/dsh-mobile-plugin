/**
 * Verify the whole path a phone will take, from the machine that owns the QR.
 *
 * Pairing crosses three links, and each fails differently on the phone:
 *
 *   1. local    — the bridge's connection to this machine's NATS
 *   2. credentials — Hub account handed to the phone in the QR
 *   3. hub-path — Hub → this instance, i.e. whether the local Leaf is bridged
 *                 to the Hub at all
 *
 * The third is the one a credential test cannot see: with valid credentials
 * and an unbridged Leaf, `svc.dsh.{instance}.pair` has no responder on the Hub
 * and the phone gets NATS's bare no-responders `503`. Checking it means asking
 * the Hub — over a second, direct connection — to reach this instance, which
 * is exactly what the phone does.
 *
 * The credential lives on the same nats-server that terminates WSS, so the
 * plain client port answers the same verdict. That port is the only one the
 * plugin can reach without a WebSocket implementation in the host process.
 */
import { connect } from 'nats'
import type { Config } from './config.js'

export type HubCheckReason = 'ok' | 'unconfigured' | 'rejected' | 'unreachable' | 'bridge-offline'

/** One link in the chain, so a failure names the part to fix. */
export interface HubCheckStep {
  key: 'local' | 'credentials' | 'hub-path'
  ok: boolean
  message: string
}

export interface HubCheckResult {
  reason: HubCheckReason
  /** True only for `ok`. Callers decide what a given failure blocks. */
  ok: boolean
  message: string
  /** `local` is included only when the caller reports its connection state. */
  steps: HubCheckStep[]
}

export interface HubCheckOptions {
  timeoutMs?: number
  /** Injection point for tests; defaults to the real nats client. */
  connectImpl?: typeof connect
  /** Whether the bridge itself is connected to this machine's NATS. */
  localConnected?: boolean
}

/** The Hub's plain client port, derived from the WSS URL the QR advertises. */
export function hubProbeAddress(hubWssUrl: string): string | null {
  try {
    const url = new URL(hubWssUrl)
    return url.hostname === '' ? null : `nats://${url.hostname}:4222`
  } catch {
    return null
  }
}

export async function checkHubPath(
  config: Config,
  options: HubCheckOptions = {},
): Promise<HubCheckResult> {
  const localStep: HubCheckStep | null = options.localConnected === undefined ? null : {
    key: 'local',
    ok: options.localConnected,
    message: options.localConnected
      ? '本机移动端桥已连上本地 NATS'
      : '本机移动端桥没有连上本地 NATS（先在设置卡里点「启动本地 NATS」）',
  }
  const steps: HubCheckStep[] = localStep === null ? [] : [localStep]

  const unset = config.hubWssUrl.trim() === '' || config.hubUser.trim() === '' || config.hubPass === ''
  if (unset) {
    steps.push({ key: 'credentials', ok: false, message: 'Hub 地址、账号、密码尚未配置完整' })
    return { ok: false, reason: 'unconfigured', message: 'Hub 地址、账号、密码尚未配置完整', steps }
  }
  const address = hubProbeAddress(config.hubWssUrl)
  if (address === null) {
    steps.push({ key: 'credentials', ok: false, message: `无法从 Hub 地址解析出主机名：${config.hubWssUrl}` })
    return {
      ok: false,
      reason: 'unreachable',
      message: `无法从 Hub 地址解析出主机名：${config.hubWssUrl}`,
      steps,
    }
  }

  const connectImpl = options.connectImpl ?? connect
  const timeout = options.timeoutMs ?? 5000
  let connection: Awaited<ReturnType<typeof connect>>
  try {
    connection = await connectImpl({
      servers: address,
      user: config.hubUser,
      pass: config.hubPass,
      timeout,
      reconnect: false,
    })
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'AUTHORIZATION_VIOLATION') {
      const message = `Hub 拒绝了账号「${config.hubUser}」的这组密码：手机扫码后会连不上 Hub。`
        + '请填 Hub 上实际配置的密码后重试。'
        + '密码是建 Hub 时随机生成、只存在 /etc/nats/hub.conf 里的，忘了就用 '
        + 'scripts/hub-credential.sh 在 Hub 上读回（`bash -s show`）或轮换（`bash -s rotate`）。'
      steps.push({ key: 'credentials', ok: false, message })
      return {
        ok: false,
        reason: 'rejected',
        message,
        steps,
      }
    }
    const message = `无法通过 ${address} 校验 Hub 账号（${error instanceof Error ? error.message : String(error)}）。`
      + '这不代表密码有错，也可能是该端口不通；手机走 8443，可以照常扫码验证。'
    steps.push({ key: 'credentials', ok: false, message })
    return {
      ok: false,
      reason: 'unreachable',
      // Not proof the credential is wrong — the port may simply be blocked
      // from here, so callers must not treat this as a hard failure.
      message,
      steps,
    }
  }

  steps.push({ key: 'credentials', ok: true, message: `Hub 账号「${config.hubUser}」可用` })

  // Ask the Hub, on a connection that did not originate here, to reach this
  // instance. An unanswered request is the phone's 503; a reply proves the
  // local Leaf is bridged and the bridge is subscribed.
  try {
    const reply = await connection.request(
      `svc.dsh.${config.instanceId}.pair`,
      new TextEncoder().encode(JSON.stringify({
        type: 'client-request',
        rpcId: 'hub-check',
        payload: { code: '__hub-check__', deviceName: 'hub-check' },
      })),
      { timeout },
    )
    steps.push({
      key: 'hub-path',
      ok: true,
      message: `Hub 能把请求送到本机实例「${config.instanceId}」（扫码可用）`,
    })
    void reply
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    const unreachable = code === '503' || String((error as Error | null)?.message ?? '').includes('no responders')
    const message = unreachable
      ? options.localConnected === false
        ? '本机移动端桥没连上本地 NATS，Hub 上因此找不到这个实例。'
        : `Hub 上找不到本机实例「${config.instanceId}」：通常是本机 Leaf 没有连上 Hub`
          + '（插件显示"已连接"只说明它连上了本机 NATS）。手机扫码会得到 503。'
          + '请确认 Leaf 进程在跑、leaf.conf 的 remotes 指向 Hub，然后重试。'
      : `Hub 上询问本机实例失败：${error instanceof Error ? error.message : String(error)}`
    steps.push({ key: 'hub-path', ok: false, message })
    await connection.close().catch(() => undefined)
    return { ok: false, reason: unreachable ? 'bridge-offline' : 'unreachable', message, steps }
  }

  await connection.close().catch(() => undefined)
  return {
    ok: true,
    reason: 'ok',
    message: `整条链路可用：Hub 账号有效，且 Hub 能联系到本机实例「${config.instanceId}」`,
    steps,
  }
}
