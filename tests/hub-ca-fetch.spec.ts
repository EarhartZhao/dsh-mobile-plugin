import { describe, expect, it } from 'vitest'
import { fetchHubCertificate } from '../src/hub-check.js'
import type { Config } from '../src/config.js'
import { ALPHA_CA_BASE64, ALPHA_CA_FINGERPRINT, HUB_LEAF_BASE64, asPem } from './hub-ca-fixture.js'

const config: Config = {
  enabled: true,
  natsUrl: 'nats://127.0.0.1:4222',
  hubWssUrl: 'wss://hub.test:8443',
  hubUser: 'c-end-test',
  hubPass: 'real-password',
  hubCaCert: '',
  hubCaFingerprint: '',
  instanceId: 'home-test',
  instanceName: '',
  tokenTtlDays: 90,
  pairCodeTtlSec: 120,
  maxDevices: 10,
  chunkCoalesceMs: 0,
  natsConfigPath: '',
  natsServerPath: '',
  autoMigrateProfile: true,
}

interface PeerCertificateLink {
  raw: Buffer
  subject: { CN: string }
  issuerCertificate?: PeerCertificateLink
}

/**
 * The chain `getPeerCertificate(true)` hands back: leaf first, each link
 * pointing at its issuer, and the top self-signed one pointing at itself —
 * which is why the walk needs a seen-set.
 */
function peerCertificate(certs: string[]): PeerCertificateLink {
  let head: PeerCertificateLink | undefined
  for (let index = certs.length - 1; index >= 0; index -= 1) {
    head = {
      raw: Buffer.from(certs[index]!, 'base64'),
      subject: { CN: `cert-${index}` },
      ...(head === undefined ? {} : { issuerCertificate: head }),
    }
  }
  const leaf = head!
  let top = leaf
  while (top.issuerCertificate !== undefined) top = top.issuerCertificate
  top.issuerCertificate = top
  return leaf
}

/**
 * A `node:tls` stub for both handshakes the fetch performs.
 *
 * The first is the fetch itself and is recognised by `rejectUnauthorized:
 * false`; the second is the verification against the fetched certificate, and
 * is what `probe` answers. `seen` collects the option objects so a test can
 * assert the fetched PEM really is what the verification used.
 */
function tlsStub(input: {
  chain: string[] | null
  probe?: Error
  seen?: Record<string, unknown>[]
  fetchError?: Error
}): typeof import('node:tls').connect {
  return ((options: Record<string, unknown>, onSecure?: () => void) => {
    input.seen?.push(options)
    const failure = options.rejectUnauthorized === false ? input.fetchError : input.probe
    const socket = {
      destroy: () => undefined,
      setTimeout: () => socket,
      getPeerCertificate: () => (input.chain === null ? null : peerCertificate(input.chain)),
      once: (event: string, handler: (error: Error) => void) => {
        if (event === 'error' && failure instanceof Error) queueMicrotask(() => handler(failure))
        return socket
      },
    }
    if (!(failure instanceof Error)) queueMicrotask(() => onSecure?.())
    return socket
  }) as unknown as typeof import('node:tls').connect
}

describe('fetchHubCertificate', () => {
  it('takes the CA out of a chain that carries one', async () => {
    const seen: Record<string, unknown>[] = []
    const result = await fetchHubCertificate(config, {
      tlsConnectImpl: tlsStub({ chain: [HUB_LEAF_BASE64, ALPHA_CA_BASE64], seen }),
    })

    expect(result.ok).toBe(true)
    expect(result.reason).toBe('ok')
    expect(result.ca?.fingerprint).toBe(ALPHA_CA_FINGERPRINT)
    expect(result.message).toContain('取到 CA')
    // The fetched certificate is what the verification handshake trusts, and
    // the first handshake deliberately asked for no verification at all.
    expect(seen[0]?.rejectUnauthorized).toBe(false)
    expect(seen[1]?.ca).toBe(asPem(ALPHA_CA_BASE64))
  })

  it('reports a Hub that sends its leaf alone instead of filling the field', async () => {
    const result = await fetchHubCertificate(config, {
      tlsConnectImpl: tlsStub({ chain: [HUB_LEAF_BASE64] }),
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('no-ca')
    expect(result.ca).toBeNull()
    // The message has to be runnable on the Hub, not a diagnosis.
    expect(result.message).toContain('/etc/nats/tls')
    expect(result.message).toContain('systemctl restart nats')
    // Writing in place is the part that keeps a nats-owned certificate
    // readable: a freshly created file would be root-owned.
    expect(result.message).toContain('就地重写')
    // The CA goes in beside a copy of the leaf. `cat server.crt ca.crt >
    // server.crt` shipped in 0.2.30 and empties the source before cat reads
    // it: the Hub would come back with a certificate file holding only the
    // CA. No hint may ever redirect a file onto itself again.
    expect(result.message).toContain('cat server.leaf.crt')
    for (const [, sources, target] of result.message.matchAll(/cat\s+([^\n>]*?)\s*>\s*([^\s'"]+)/g)) {
      expect(sources!.trim().split(/\s+/)).not.toContain(target)
    }
  })

  it('withholds a certificate that fails its own verification', async () => {
    const result = await fetchHubCertificate(config, {
      tlsConnectImpl: tlsStub({
        chain: [HUB_LEAF_BASE64, ALPHA_CA_BASE64],
        probe: Object.assign(new Error('bad chain'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }),
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('mismatch')
    expect(result.ca?.fingerprint).toBe(ALPHA_CA_FINGERPRINT)
    expect(result.message).not.toContain('已从')
  })

  it('has nothing to fetch on a plaintext Hub', async () => {
    const result = await fetchHubCertificate({ ...config, hubWssUrl: 'ws://hub.test:8080' }, {
      tlsConnectImpl: tlsStub({ chain: [ALPHA_CA_BASE64] }),
    })

    expect(result.reason).toBe('plaintext')
    expect(result.ca).toBeNull()
  })

  it('names an address it cannot parse', async () => {
    const result = await fetchHubCertificate({ ...config, hubWssUrl: 'not a url' }, {
      tlsConnectImpl: tlsStub({ chain: null }),
    })

    expect(result.reason).toBe('bad-address')
    expect(result.message).toContain('Hub 地址')
  })

  it('names the empty field as empty instead of quoting nothing', async () => {
    // The state a brand-new install is in when the button is pressed before the
    // address is typed. 「」 quoted the field back at the owner and read like a
    // parsing failure, so the wording has to say which field and what to put in
    // it.
    const result = await fetchHubCertificate({ ...config, hubWssUrl: '   ' }, {
      tlsConnectImpl: tlsStub({ chain: null }),
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('bad-address')
    expect(result.ca).toBeNull()
    expect(result.message).toContain('Hub 地址')
    expect(result.message).toContain('wss://')
    expect(result.message).not.toContain('「」')
  })

  it('keeps a blocked port a report, not an exception', async () => {
    const result = await fetchHubCertificate(config, {
      tlsConnectImpl: tlsStub({
        chain: null,
        fetchError: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('unreachable')
    expect(result.message).toContain('ECONNREFUSED')
  })

  it('reports a handshake that handed over no certificate at all', async () => {
    const result = await fetchHubCertificate(config, { tlsConnectImpl: tlsStub({ chain: null }) })

    expect(result.reason).toBe('no-certificate')
  })
})
