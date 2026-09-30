import { describe, expect, it } from 'vitest'
import { buildPairingPayload } from '../src/index.js'
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
  natsConfigPath: '',
  natsServerPath: '',
  autoMigrateProfile: true,
}

const withCa = (patch: Partial<Config>): Config => ({ ...config, ...patch })

describe('buildPairingPayload', () => {
  it('carries the account the phone needs', () => {
    const payload = buildPairingPayload(config, 'ABCDEFGH')

    expect(payload).toMatchObject({
      hub: 'wss://hub.test:8443',
      user: 'c-end-test',
      pass: 'real-password',
      instance: 'home-test',
      code: 'ABCDEFGH',
    })
  })

  it('adds the certificate when one is configured', () => {
    const payload = buildPairingPayload(withCa({ hubCaCert: asPem(ALPHA_CA_BASE64) }), 'ABCDEFGH')

    expect(payload.ca).toBe(ALPHA_CA_BASE64)
    // The fingerprint the App shows comes from the certificate itself, so it
    // cannot drift from the anchor the same QR installs.
    expect(payload.caFp).toBe(ALPHA_CA_FINGERPRINT)
  })

  it('leaves the certificate out — and the QR unchanged — when none is set', () => {
    const payload = buildPairingPayload(withCa({ hubCaFingerprint: ALPHA_CA_FINGERPRINT }), 'ABCDEFGH')

    expect(payload.ca).toBeUndefined()
    // A fingerprint alone is what the pre-certificate plugin shipped; keep
    // sending it so an older owner's QR is not silently emptied.
    expect(payload.caFp).toBe(ALPHA_CA_FINGERPRINT)
  })

  it('refuses to mint a QR whose fingerprint contradicts its certificate', () => {
    expect(() => buildPairingPayload(
      withCa({ hubCaCert: asPem(ALPHA_CA_BASE64), hubCaFingerprint: BETA_CA_FINGERPRINT }),
      'ABCDEFGH',
    )).toThrow(/不一致/)
  })

  it('accepts a fingerprint that matches, whatever the formatting', () => {
    const payload = buildPairingPayload(withCa({
      hubCaCert: asPem(ALPHA_CA_BASE64),
      hubCaFingerprint: ALPHA_CA_FINGERPRINT.toLowerCase().replace(/:/g, ''),
    }), 'ABCDEFGH')

    expect(payload.ca).toBe(ALPHA_CA_BASE64)
  })

  it('ignores an unreadable certificate field instead of blocking every scan', () => {
    // Clearing the field is how an owner takes a certificate back out; a typo
    // in it must not freeze the pairing button with no way forward.
    const payload = buildPairingPayload(withCa({ hubCaCert: 'not a certificate' }), 'ABCDEFGH')

    expect(payload.ca).toBeUndefined()
  })
})
