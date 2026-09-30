import { describe, expect, it, vi } from 'vitest'
import { checkHubCertificate, checkHubPath, hubProbeAddress } from '../src/hub-check.js'
import type { Config } from '../src/config.js'
import { ALPHA_CA_BASE64, ALPHA_CA_FINGERPRINT, BETA_CA_FINGERPRINT, asPem } from './hub-ca-fixture.js'

const config: Config = {
  natsUrl: 'nats://127.0.0.1:4222',
  hubWssUrl: 'wss://hub.test:8443',
  hubUser: 'c-end-test',
  hubPass: 'real-password',
  hubCaCert: '',
  hubCaFingerprint: '',
  instanceId: 'home-test',
  tokenTtlDays: 90,
  pairCodeTtlSec: 120,
  maxDevices: 10,
  chunkCoalesceMs: 0,
}

/** A connect stub that fails with a NATS-shaped error code. */
function failingConnect(code: string): typeof import('nats').connect {
  return (() => Promise.reject(Object.assign(new Error('nope'), { code }))) as unknown as typeof import('nats').connect
}

/** A connect stub that reaches the Hub; `request` answers or rejects as told. */
function connectedConnect(answer: { data: Uint8Array } | Error): typeof import('nats').connect {
  return (() => Promise.resolve({
    close: () => Promise.resolve(),
    request: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)),
  })) as unknown as typeof import('nats').connect
}

const answered = { data: new TextEncoder().encode('{"result":{"ok":false}}') }
const noResponders = () => Object.assign(new Error('503'), { code: '503' })

describe('hubProbeAddress', () => {
  it('targets the Hub client port on the same host', () => {
    expect(hubProbeAddress('wss://hub.test:8443')).toBe('nats://hub.test:4222')
  })

  it('returns null for an address it cannot parse', () => {
    expect(hubProbeAddress('not a url')).toBeNull()
    expect(hubProbeAddress('')).toBeNull()
  })
})

describe('checkHubPath', () => {
  it('reports an incomplete configuration without touching the network', async () => {
    const connectImpl = vi.fn()
    const result = await checkHubPath({ ...config, hubPass: '' }, {
      connectImpl: connectImpl as unknown as typeof import('nats').connect,
    })
    expect(result.reason).toBe('unconfigured')
    expect(connectImpl).not.toHaveBeenCalled()
  })

  it('treats a Hub rejection as definitive', async () => {
    const result = await checkHubPath(config, { connectImpl: failingConnect('AUTHORIZATION_VIOLATION') })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('rejected')
    expect(result.message).toContain('c-end-test')
  })

  it('does not blame the password when the port is simply unreachable', async () => {
    const result = await checkHubPath(config, { connectImpl: failingConnect('TIMEOUT') })
    expect(result.reason).toBe('unreachable')
    expect(result.message).toContain('不代表密码有错')
  })

  it('passes only when the Hub can also reach this instance', async () => {
    const result = await checkHubPath(config, { connectImpl: connectedConnect(answered) })
    expect(result).toMatchObject({ ok: true, reason: 'ok' })
    expect(result.steps.map(step => step.key)).toEqual(['credentials', 'hub-path'])
    expect(result.steps.every(step => step.ok)).toBe(true)
  })

  it('names the Leaf link when the Hub has no responder for this instance', async () => {
    // The exact shape the phone sees: NATS answers a request nobody serves
    // with code AND message "503" — valid credentials, missing host.
    const result = await checkHubPath(config, { connectImpl: connectedConnect(noResponders()) })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('bridge-offline')
    expect(result.message).toContain('Leaf')
    expect(result.steps.find(step => step.key === 'hub-path')?.ok).toBe(false)
    // Credentials are still reported as fine, so the user fixes the right link.
    expect(result.steps.find(step => step.key === 'credentials')?.ok).toBe(true)
  })

  it('separates a local bridge that is down from a Leaf that is down', async () => {
    const local = await checkHubPath(config, { connectImpl: connectedConnect(noResponders()), localConnected: false })
    const leaf = await checkHubPath(config, { connectImpl: connectedConnect(noResponders()), localConnected: true })

    expect(local.steps.find(step => step.key === 'local')?.ok).toBe(false)
    expect(leaf.steps.find(step => step.key === 'local')?.ok).toBe(true)
    expect(local.message).toContain('本地 NATS')
    expect(leaf.message).toContain('Leaf')
  })
})

/**
 * A `tls.connect` stand-in. `completing` runs the handshake, an Error is
 * delivered as the socket's error event — the two shapes the real call
 * produces for every outcome this check distinguishes.
 */
function tlsStub(outcome: 'completing' | Error): typeof import('node:tls').connect {
  return ((_options: unknown, onSecure?: () => void) => {
    const socket = {
      destroy: () => undefined,
      setTimeout: () => socket,
      once: (event: string, handler: (error: Error) => void) => {
        if (event === 'error' && outcome !== 'completing') queueMicrotask(() => handler(outcome))
        return socket
      },
    }
    if (outcome === 'completing') queueMicrotask(() => onSecure?.())
    return socket
  }) as unknown as typeof import('node:tls').connect
}

describe('checkHubCertificate', () => {
  const withCa = (patch: Partial<Config>): Config => ({ ...config, ...patch })

  it('accepts a certificate the Hub actually signs with', async () => {
    const result = await checkHubCertificate(
      withCa({ hubCaCert: asPem(ALPHA_CA_BASE64) }),
      { tlsConnectImpl: tlsStub('completing') },
    )

    expect(result.ok).toBe(true)
    expect(result.reason).toBe('ok')
    expect(result.message).toContain('dsh-test-alpha-ca')
    expect(result.message).toContain(ALPHA_CA_FINGERPRINT)
  })

  it('carries the derived fingerprint so the phone display can be checked', async () => {
    const result = await checkHubCertificate(
      withCa({ hubCaCert: ALPHA_CA_BASE64 }),
      { tlsConnectImpl: tlsStub('completing') },
    )

    expect(result.fingerprint).toBe(ALPHA_CA_FINGERPRINT)
  })

  it('warns, without failing, when no certificate is configured', async () => {
    const result = await checkHubCertificate(config, { tlsConnectImpl: tlsStub('completing') })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('unconfigured')
    // The QR is still usable by an App that bundles this CA, so the message
    // has to explain the consequence rather than call it broken.
    expect(result.message).toContain('二维码不带证书')
  })

  it('rejects text that is not a certificate', async () => {
    const result = await checkHubCertificate(
      withCa({ hubCaCert: 'C:\\nats\\tls\\ca.crt' }),
      { tlsConnectImpl: tlsStub('completing') },
    )

    expect(result.reason).toBe('malformed')
  })

  it('catches a certificate that contradicts the configured fingerprint', async () => {
    const result = await checkHubCertificate(
      withCa({ hubCaCert: asPem(ALPHA_CA_BASE64), hubCaFingerprint: BETA_CA_FINGERPRINT }),
      { tlsConnectImpl: tlsStub('completing') },
    )

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('fingerprint-mismatch')
    expect(result.message).toContain(ALPHA_CA_FINGERPRINT)
    expect(result.message).toContain(BETA_CA_FINGERPRINT)
  })

  it('accepts a fingerprint that matches the certificate, however it is typed', async () => {
    const result = await checkHubCertificate(
      withCa({ hubCaCert: asPem(ALPHA_CA_BASE64), hubCaFingerprint: ALPHA_CA_FINGERPRINT.toLowerCase().replace(/:/g, '') }),
      { tlsConnectImpl: tlsStub('completing') },
    )

    expect(result.reason).toBe('ok')
  })

  it('names the certificate when the Hub presents a different chain', async () => {
    const result = await checkHubCertificate(
      withCa({ hubCaCert: asPem(ALPHA_CA_BASE64) }),
      { tlsConnectImpl: tlsStub(Object.assign(new Error('bad chain'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })) },
    )

    expect(result.reason).toBe('not-the-hub')
    expect(result.message).toContain('不是这张 CA 签的')
  })

  it('separates a name mismatch from a wrong certificate', async () => {
    const result = await checkHubCertificate(
      withCa({ hubCaCert: asPem(ALPHA_CA_BASE64) }),
      { tlsConnectImpl: tlsStub(Object.assign(new Error('bad name'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' })) },
    )

    expect(result.reason).toBe('host-mismatch')
    expect(result.message).toContain('SAN')
  })

  it('treats an unreachable port as a warning, not a verdict', async () => {
    const result = await checkHubCertificate(
      withCa({ hubCaCert: asPem(ALPHA_CA_BASE64) }),
      { tlsConnectImpl: tlsStub(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })) },
    )

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('unreachable')
    expect(result.message).toContain('不代表证书有问题')
  })

  it('skips the handshake for a plaintext Hub', async () => {
    const connect = vi.fn()
    const result = await checkHubCertificate(
      withCa({ hubWssUrl: 'ws://hub.test:8443', hubCaCert: asPem(ALPHA_CA_BASE64) }),
      { tlsConnectImpl: connect as unknown as typeof import('node:tls').connect },
    )

    expect(result.reason).toBe('plaintext')
    expect(connect).not.toHaveBeenCalled()
  })
})
