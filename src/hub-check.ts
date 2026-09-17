/**
 * Verify the Hub account the QR is about to carry, from the machine that owns
 * it. The phone only ever sees the failure as a dead-end NATS error, so the
 * check runs where the password can still be corrected.
 *
 * The credential lives on the same nats-server that terminates WSS, so the
 * plain client port answers the same verdict. That port is the only one the
 * plugin can reach without a WebSocket implementation in the host process.
 */
import { connect } from 'nats'
import type { Config } from './config.js'

export type HubCheckReason = 'ok' | 'unconfigured' | 'rejected' | 'unreachable'

export interface HubCheckResult {
  reason: HubCheckReason
  /** True only for `ok`. Callers decide what a given failure blocks. */
  ok: boolean
  message: string
}

export interface HubCheckOptions {
  timeoutMs?: number
  /** Injection point for tests; defaults to the real nats client. */
  connectImpl?: typeof connect
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

export async function checkHubCredentials(
  config: Config,
  options: HubCheckOptions = {},
): Promise<HubCheckResult> {
  const unset = config.hubWssUrl.trim() === '' || config.hubUser.trim() === '' || config.hubPass === ''
  if (unset) {
    return { ok: false, reason: 'unconfigured', message: 'Hub 地址、账号、密码尚未配置完整' }
  }
  const address = hubProbeAddress(config.hubWssUrl)
  if (address === null) {
    return {
      ok: false,
      reason: 'unreachable',
      message: `无法从 Hub 地址解析出主机名：${config.hubWssUrl}`,
    }
  }

  const connectImpl = options.connectImpl ?? connect
  try {
    const connection = await connectImpl({
      servers: address,
      user: config.hubUser,
      pass: config.hubPass,
      timeout: options.timeoutMs ?? 5000,
      reconnect: false,
    })
    await connection.close()
    return { ok: true, reason: 'ok', message: `Hub 账号「${config.hubUser}」可用` }
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'AUTHORIZATION_VIOLATION') {
      return {
        ok: false,
        reason: 'rejected',
        message: `Hub 拒绝了账号「${config.hubUser}」的这组密码：手机扫码后会连不上 Hub。`
          + '请填 Hub 上实际配置的密码后重试。'
          + '密码是建 Hub 时随机生成、只存在 /etc/nats/hub.conf 里的，忘了就用 '
          + 'scripts/hub-credential.sh 在 Hub 上读回（`bash -s show`）或轮换（`bash -s rotate`）。',
      }
    }
    return {
      ok: false,
      reason: 'unreachable',
      // Not proof the credential is wrong — the port may simply be blocked
      // from here, so callers must not treat this as a hard failure.
      message: `无法通过 ${address} 校验 Hub 账号（${error instanceof Error ? error.message : String(error)}）。`
        + '这不代表密码有错，也可能是该端口不通；手机走 8443，可以照常扫码验证。',
    }
  }
}
