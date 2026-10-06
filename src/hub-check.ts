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
 *
 * {@link checkHubCertificate} is the fourth link and the only one that is not
 * about reachability: the phone's TLS trust for the Hub comes from the CA the
 * QR carries, so a certificate that does not match what the Hub actually
 * presents — or one the Hub is not signing with at all — makes every scan die
 * at the handshake, where nothing on the phone can explain why.
 */
import { connect } from 'nats'
import { connect as tlsConnect } from 'node:tls'
import { hubCaFromDer, readHubCa, sameFingerprint, type HubCa } from './hub-ca.js'
import type { Config } from './config.js'

export type HubCheckReason = 'ok' | 'unconfigured' | 'rejected' | 'unreachable' | 'bridge-offline'

/** One link in the chain, so a failure names the part to fix. */
export interface HubCheckStep {
  key: 'local' | 'credentials' | 'hub-path' | 'certificate'
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

export type HubCertificateReason =
  | 'ok'
  | 'public-ca'
  | 'unconfigured'
  | 'malformed'
  | 'fingerprint-mismatch'
  | 'plaintext'
  | 'host-mismatch'
  | 'not-the-hub'
  | 'unreachable'

export interface HubCertificateResult {
  /** True for `ok` and `plaintext`: both mean the QR is safe to hand out. */
  ok: boolean
  reason: HubCertificateReason
  /** Fingerprint of the configured certificate, when it parsed. */
  fingerprint: string | null
  message: string
}

export interface HubCertificateOptions {
  timeoutMs?: number
  /** Injection point for tests; defaults to `node:tls`. */
  tlsConnectImpl?: typeof tlsConnect
}

/** The WSS endpoint the phone will dial, or null when the URL is unusable. */
export function hubTlsEndpoint(hubWssUrl: string): { host: string, port: number, plaintext: boolean } | null {
  try {
    const url = new URL(normalizeHubWssUrl(hubWssUrl))
    if (url.hostname === '') return null
    const plaintext = url.protocol === 'ws:'
    const port = url.port === '' ? (plaintext ? 80 : 443) : Number(url.port)
    if (!Number.isInteger(port) || port <= 0) return null
    return { host: url.hostname, port, plaintext }
  } catch {
    return null
  }
}

/** Whether the host is a literal address, in which case SNI must stay unset. */
function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

/** TLS error codes that mean "handshake completed, the chain did not verify". */
const CA_REJECTION_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_SIGNATURE_FAILURE',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

/**
 * One TLS handshake against exactly what the phone will dial.
 *
 * `trustedCa` of `null` leaves `ca` unset, which is what makes Node fall back
 * to the platform trust store — the same store the App has when the QR carries
 * no certificate. Resolves on a completed handshake, rejects with the socket's
 * own error otherwise.
 */
function tlsProbe(
  endpoint: { host: string, port: number },
  trustedCa: string | null,
  timeout: number,
  connectImpl: typeof tlsConnect,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = connectImpl({
      host: endpoint.host,
      port: endpoint.port,
      ...(trustedCa === null ? {} : { ca: trustedCa }),
      rejectUnauthorized: true,
      // SNI carries a name, never an address; Node checks the certificate
      // against the IP SAN when it is given one.
      ...(isIpLiteral(endpoint.host) ? {} : { servername: endpoint.host }),
    }, () => {
      socket.destroy()
      resolve()
    })
    socket.setTimeout(timeout, () => {
      socket.destroy()
      reject(Object.assign(new Error('TLS handshake timed out'), { code: 'ETIMEDOUT' }))
    })
    socket.once('error', (error) => {
      socket.destroy()
      reject(error)
    })
  })
}

/** The Hub's plain client port, derived from the WSS URL the QR advertises. */
export function hubProbeAddress(hubWssUrl: string): string | null {
  try {
    const url = new URL(normalizeHubWssUrl(hubWssUrl))
    return url.hostname === '' ? null : `nats://${url.hostname}:4222`
  } catch {
    return null
  }
}

/**
 * Coerce what an owner typed into the WSS URL the QR advertises. The field is
 * labelled `wss://…:8443` but what people paste is the address on its own, and
 * `new URL('203.0.113.10')` throws — so a perfectly good Hub used to come back
 * as "无法从 Hub 地址解析出主机名". A bare `host[:port][/path]` becomes
 * `wss://host[:port][/path]`, and a bare address with no port gets 8443 rather
 * than letting the URL default to 443: this field is the Hub's WSS listener.
 * A `wss://` URL with no port gets the same treatment — see {@link withHubPort}
 * — and everything else carrying a scheme is kept as typed. An empty value
 * stays empty so "not configured yet" keeps working.
 */
export function normalizeHubWssUrl(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return withHubPort(trimmed)
  const bare = trimmed.replace(/^\/+/, '')
  const slash = bare.indexOf('/')
  const authority = slash === -1 ? bare : bare.slice(0, slash)
  const path = slash === -1 ? '' : bare.slice(slash)
  return `wss://${/:\d+$/.test(authority) ? authority : `${authority}:8443`}${path}`
}

/**
 * `wss://` with no port is the spelling that silently points somewhere else:
 * the URL spec fills in 443, so the QR sends the phone to a port the Hub does
 * not listen on and the scan ends on the same "无法连接公网 NATS" screen a wrong
 * password gives — with nothing on the desktop pointing at the address. The
 * bare-address shorthand got this port filled in from the start; an address
 * typed with the scheme did not, which is how `wss://<hub-host>` reached a Hub
 * listening on 8443.
 *
 * Only `wss://` is touched. `ws://` without a port is the plaintext stand-in an
 * owner runs locally, where 80 is no better a guess than any other.
 */
function withHubPort(url: string): string {
  const match = /^(wss):\/\/([^/?#]*)(.*)$/i.exec(url)
  if (match === null) return url
  const authority = match[2]
  if (authority === '' || /:\d+$/.test(authority)) return url
  return `${match[1]}://${authority}:8443${match[3]}`
}

/**
 * One wording for every unparseable address. It names the value that failed,
 * shows a form that works, and says the bare-address shorthand is allowed —
 * the old text only said the host name could not be parsed, which sent an
 * owner with a perfectly good Hub looking for a DNS problem that was not there.
 */
function unparseableHubAddress(hubWssUrl: string): string {
  return `无法把「${hubWssUrl}」当作 Hub 地址：要写成 wss://主机:8443（例如 wss://203.0.113.10:8443），`
    + '只填主机或 IP 也可以（缺端口按 8443 补）。'
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
    steps.push({ key: 'credentials', ok: false, message: unparseableHubAddress(config.hubWssUrl) })
    return {
      ok: false,
      reason: 'unreachable',
      message: unparseableHubAddress(config.hubWssUrl),
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
        + 'dsh-mobile 仓库的 scripts/hub-credential.sh 在 Hub 上读回（`bash -s show`）或轮换（`bash -s rotate`）；'
        + '自建 NATS 的完整流程见 docs/03-nats-self-host.md。'
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

/**
 * Whether the CA the QR will carry is the CA the Hub actually signs with.
 *
 * The phone trusts exactly what the QR hands it, so the two ways this goes
 * wrong are both silent from the desktop and fatal on the phone: a certificate
 * that is not the Hub's (hand-edited field, an old file after a rotation, the
 * server certificate pasted instead of the CA) and a fingerprint that
 * contradicts the certificate beside it. Checking costs one TLS handshake to
 * the WSS port the phone will dial.
 *
 * An unset certificate is not assumed to be fine and is not assumed to be
 * broken: the App carries no CA of its own, so leaving the field empty is only
 * viable for a Hub whose certificate a public CA signed, and the only way to
 * tell the two apart is to handshake against the platform trust store. A
 * self-signed Hub then reports `unconfigured` as a failure — "every scan will
 * die at the handshake" — instead of the green verdict this check used to give
 * it, and a public-CA Hub reports `public-ca`, which is a pass.
 */
export async function checkHubCertificate(
  config: Config,
  options: HubCertificateOptions = {},
): Promise<HubCertificateResult> {
  const timeout = options.timeoutMs ?? 5000
  const connectImpl = options.tlsConnectImpl ?? tlsConnect
  const configured = typeof config.hubCaCert === 'string' ? config.hubCaCert.trim() : ''
  if (configured === '') {
    // An empty field is only viable when a public CA signed the Hub, and that
    // is checkable: ask the same trust store the phone ends up with. Skipping
    // the probe made this report "整条链路可用" for a self-signed Hub whose every
    // scan dies at the handshake — the one failure the owner cannot see from
    // the desktop, and the reason "测试 Hub 账号" was asked to cover the whole
    // path in the first place.
    const endpoint = hubTlsEndpoint(config.hubWssUrl)
    if (endpoint === null) {
      return {
        ok: false,
        reason: 'unconfigured',
        fingerprint: null,
        message: unparseableHubAddress(config.hubWssUrl),
      }
    }
    if (endpoint.plaintext) {
      return {
        ok: true,
        reason: 'plaintext',
        fingerprint: null,
        message: 'Hub 地址是 ws://（明文），这条链路不做 TLS，CA 证书不会用到；也只有 debug 构建能连这种 Hub。',
      }
    }
    try {
      await tlsProbe(endpoint, null, timeout, connectImpl)
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      const codeText = typeof code === 'string' ? code : ''
      if (CA_REJECTION_CODES.has(codeText)) {
        return {
          ok: false,
          reason: 'unconfigured',
          fingerprint: null,
          message: `没有配置 Hub 的 CA 证书，而 ${endpoint.host}:${endpoint.port} 的证书不是公共 CA 签的（${codeText}）：`
            + '二维码不带证书，App 里也没有内置任何 CA，手机每次扫码都会卡在 TLS 握手上。'
            + '点上面的「从 Hub 获取 CA」可以自动取（前提是 Hub 的证书链里带着 CA），'
            + '也可以把 Hub 的 ca.crt 粘进上面的字段，保存后再点这个按钮。',
        }
      }
      return {
        ok: false,
        reason: 'unreachable',
        fingerprint: null,
        message: `无法与 ${endpoint.host}:${endpoint.port} 完成 TLS 握手（${codeText === '' ? String(error) : codeText}），也没有配置 CA 证书。`
          + '这不代表证书有问题，也可能是端口不通；手机走同一条链路，可以先扫码试。',
      }
    }
    return {
      ok: true,
      reason: 'public-ca',
      fingerprint: null,
      message: `没有配置 CA 证书，但 ${endpoint.host}:${endpoint.port} 的证书能通过系统信任库校验（公共 CA 签发），`
        + '二维码不带证书也能连。',
    }
  }

  const ca = readHubCa(configured)
  if (ca === null) {
    return {
      ok: false,
      reason: 'malformed',
      fingerprint: null,
      message: 'CA 证书无法解析：请粘贴 ca.crt 的完整 PEM（含 BEGIN/END CERTIFICATE 行），或它的 base64 内容。',
    }
  }

  const expected = typeof config.hubCaFingerprint === 'string' ? config.hubCaFingerprint.trim() : ''
  if (expected !== '' && !sameFingerprint(expected, ca.fingerprint)) {
    return {
      ok: false,
      reason: 'fingerprint-mismatch',
      fingerprint: ca.fingerprint,
      message: `配置的 CA 指纹与 CA 证书不是同一张：配置里写的是 ${expected}，证书实际是 ${ca.fingerprint}。`
        + '两者不一致时手机扫到的指纹对不上证书，会直接拒绝这个 Hub。',
    }
  }

  const endpoint = hubTlsEndpoint(config.hubWssUrl)
  if (endpoint === null) {
    return {
      ok: false,
      reason: 'unreachable',
      fingerprint: ca.fingerprint,
      message: unparseableHubAddress(config.hubWssUrl),
    }
  }
  if (endpoint.plaintext) {
    return {
      ok: true,
      reason: 'plaintext',
      fingerprint: ca.fingerprint,
      message: 'Hub 地址是 ws://（明文），这条链路不做 TLS，CA 证书不会用到；也只有 debug 构建能连这种 Hub。',
    }
  }

  try {
    await tlsProbe(endpoint, ca.pem, timeout, connectImpl)
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    const codeText = typeof code === 'string' ? code : ''
    if (CA_REJECTION_CODES.has(codeText)) {
      const altName = codeText === 'ERR_TLS_CERT_ALTNAME_INVALID'
      return {
        ok: false,
        reason: altName ? 'host-mismatch' : 'not-the-hub',
        fingerprint: ca.fingerprint,
        message: altName
          ? `${endpoint.host}:${endpoint.port} 出示的证书不覆盖这个地址：换过地址（域名 ↔ IP）后要在 Hub 上用新 SAN 重签服务器证书。`
          : `${endpoint.host}:${endpoint.port} 出示的证书不是这张 CA 签的（${codeText}）：`
            + 'Hub 上装的可能还是旧证书，或者这个字段里粘的不是它当前用的 CA。',
      }
    }
    return {
      ok: false,
      reason: 'unreachable',
      fingerprint: ca.fingerprint,
      message: `无法与 ${endpoint.host}:${endpoint.port} 完成 TLS 握手（${codeText === '' ? String(error) : codeText}）。`
        + '这不代表证书有问题，也可能是端口不通；手机走同一条链路，可以先扫码试。',
    }
  }

  return {
    ok: true,
    reason: 'ok',
    fingerprint: ca.fingerprint,
    message: `Hub 出示的证书由这张 CA 签发（${ca.subject}，有效期至 ${ca.validTo}）。`
      + `指纹 ${ca.fingerprint}。`,
  }
}

export type HubCaFetchReason =
  | 'ok'
  | 'plaintext'
  | 'bad-address'
  | 'unreachable'
  | 'no-certificate'
  | 'no-ca'
  | 'mismatch'

export interface HubCaFetchResult {
  /** True only when {@link HubCaFetchResult.ca} is a certificate worth saving. */
  ok: boolean
  reason: HubCaFetchReason
  /** The CA the Hub's chain carries, when it carries a usable one. */
  ca: HubCa | null
  message: string
}

export interface HubCaFetchOptions {
  timeoutMs?: number
  /** Injection point for tests; defaults to `node:tls`. */
  tlsConnectImpl?: typeof tlsConnect
}

/** The certificate chain a peer sent, leaf first, without repeats. */
interface PeerCertificate {
  raw?: Buffer
  subject?: { CN?: string }
  issuerCertificate?: PeerCertificate
}

/**
 * Every certificate the peer put on the wire, leaf first.
 *
 * `getPeerCertificate(true)` walks the chain Node managed to build, which for
 * a server that sends only its leaf is that leaf and nothing else — the same
 * list `openssl s_client -showcerts` prints. `issuerCertificate` cycles back to
 * the certificate itself for a self-signed one, hence the seen-set.
 */
function peerChain(leaf: PeerCertificate | null | undefined): Buffer[] {
  const chain: Buffer[] = []
  const seen = new Set<string>()
  let current: PeerCertificate | null | undefined = leaf
  while (current != null && Buffer.isBuffer(current.raw)) {
    const der = current.raw
    const key = der.toString('base64')
    if (seen.has(key)) break
    seen.add(key)
    chain.push(der)
    current = current.issuerCertificate
  }
  return chain
}

/** The one wording for "the Hub sends its certificate, but not the CA". */
function missingChainCa(leafSubject: string): string {
  return `Hub 只发了服务器证书（${leafSubject}），证书链里没有签发它的 CA，客户端拿不到信任锚。`
    + '在 Hub 上把 CA 拼进正在服务的那份证书就能自动取到（CA 是公开材料，私钥 ca.key 不需要上服务器）：\n'
    + '  scp ca.crt root@<hub-host>:/root/dsh-mobile-setup/\n'
    + "  ssh root@<hub-host> 'set -e; cd /etc/nats/tls && [ -f server.leaf.crt ] || cp -p server.crt server.leaf.crt && cat server.leaf.crt /root/dsh-mobile-setup/ca.crt > server.crt && systemctl restart nats && systemctl is-active nats'\n"
    + '  幂等：先把叶子另存成 server.leaf.crt，再从它拼出 server.crt。就地重写让属主、权限与 SELinux 上下文都保持原样'
    + '（新建文件是做 root 属主的，以 nats 用户运行的服务会读不到证书）；重复跑不会叠加。'
    + '注意输出不能指向输入——重定向会在 cat 读到源文件之前先把它清空。\n'
    + 'nats.conf 不用改：cert_file 一直指着这个文件名。然后回到这里再点一次「从 Hub 获取 CA」。'
    + 'docs/03 的「让新机器一键取到 CA」是同一套命令。'
}

/**
 * Fetches the Hub's CA certificate out of the TLS handshake the phone will do.
 *
 * Pasting `ca.crt` on every machine is the part of onboarding that has nothing
 * to do with understanding the setup, and it fails silently: a typo'd or stale
 * certificate only shows up later, on the phone, as a handshake with no
 * explanation. A server that sends its chain (the standard `fullchain.pem`
 * arrangement) hands the CA over during the handshake the plugin already
 * performs, so the console can fill the field in one click.
 *
 * The certificate is never taken on faith: whatever is fetched has to validate
 * the Hub in a second handshake before it is offered, so a chain that names
 * some other CA is reported rather than installed. A Hub that sends only its
 * leaf is reported with the one command that fixes it — the certificate itself
 * cannot be turned into its issuer.
 * @param config Live plugin config; only `hubWssUrl` is read.
 * @param options Timeout and the TLS implementation (tests inject a stub).
 * @returns The certificate plus a message for the console, never a throw.
 */
export async function fetchHubCertificate(
  config: Config,
  options: HubCaFetchOptions = {},
): Promise<HubCaFetchResult> {
  const timeout = options.timeoutMs ?? 5000
  const connectImpl = options.tlsConnectImpl ?? tlsConnect
  const endpoint = hubTlsEndpoint(config.hubWssUrl)
  if (endpoint === null) {
    return { ok: false, reason: 'bad-address', ca: null, message: unparseableHubAddress(config.hubWssUrl) }
  }
  if (endpoint.plaintext) {
    return {
      ok: false,
      reason: 'plaintext',
      ca: null,
      message: 'Hub 地址是 ws://（明文），这条链路不做 TLS，也就没有证书可取；也只有 debug 构建能连这种 Hub。',
    }
  }

  let chain: Buffer[]
  let leafSubject: string
  try {
    const { certificates, subject } = await new Promise<{ certificates: Buffer[], subject: string }>((resolve, reject) => {
      const socket = connectImpl({
        host: endpoint.host,
        port: endpoint.port,
        // The point is to see the certificate, not to have it accepted: a
        // self-signed Hub is exactly the case this exists for.
        rejectUnauthorized: false,
        ...(isIpLiteral(endpoint.host) ? {} : { servername: endpoint.host }),
      }, () => {
        const peer = socket.getPeerCertificate(true) as PeerCertificate | null
        socket.destroy()
        resolve({
          certificates: peerChain(peer),
          subject: peer?.subject?.CN ?? '未知',
        })
      })
      socket.setTimeout(timeout, () => {
        socket.destroy()
        reject(Object.assign(new Error('TLS handshake timed out'), { code: 'ETIMEDOUT' }))
      })
      socket.once('error', (error) => {
        socket.destroy()
        reject(error)
      })
    })
    chain = certificates
    leafSubject = subject
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    const codeText = typeof code === 'string' ? code : String(error)
    return {
      ok: false,
      reason: 'unreachable',
      ca: null,
      message: `无法与 ${endpoint.host}:${endpoint.port} 完成 TLS 握手（${codeText}），取不到证书。`
        + '端口不通、防火墙挡下都会这样；也可以先手工粘贴 ca.crt。',
    }
  }

  const top = chain[chain.length - 1]
  if (top === undefined) {
    return {
      ok: false,
      reason: 'no-certificate',
      ca: null,
      message: `${endpoint.host}:${endpoint.port} 的握手完成了，但没给出任何证书：它没有配置 TLS，或中间有人拦下了连接。`,
    }
  }

  const ca = hubCaFromDer(top)
  if (ca === null || !ca.isCa) {
    return { ok: false, reason: 'no-ca', ca: null, message: missingChainCa(leafSubject) }
  }

  // The fetched certificate has to be the one that validates this Hub; a chain
  // that hands over something else is a report, not an anchor.
  try {
    await tlsProbe(endpoint, ca.pem, timeout, connectImpl)
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    const codeText = typeof code === 'string' ? code : String(error)
    return {
      ok: false,
      reason: 'mismatch',
      ca,
      message: `从 ${endpoint.host}:${endpoint.port} 取到的证书（${ca.subject}）没能通过它自己的校验（${codeText}），`
        + '不会自动填入。这通常说明链里带的是中间证书，或 Hub 的 cert_file 配错了。',
    }
  }

  return {
    ok: true,
    reason: 'ok',
    ca,
    message: `已从 ${endpoint.host}:${endpoint.port} 取到 CA：${ca.subject}｜有效期至 ${ca.validTo}｜SHA-256 ${ca.fingerprint}`,
  }
}
