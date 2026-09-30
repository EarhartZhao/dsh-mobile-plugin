import { describe, expect, it } from 'vitest'
import { fingerprintOfBase64, readHubCa, sameFingerprint } from '../src/hub-ca.js'
import { ALPHA_CA_BASE64, ALPHA_CA_FINGERPRINT, asPem } from './hub-ca-fixture.js'

describe('readHubCa', () => {
  it('reads the PEM the Hub scripts produce', () => {
    const ca = readHubCa(asPem(ALPHA_CA_BASE64))
    expect(ca).not.toBeNull()
    // The fingerprint has to agree with `openssl x509 -fingerprint -sha256`,
    // because that is the value every runbook and the phone display quote.
    expect(ca!.fingerprint).toBe(ALPHA_CA_FINGERPRINT)
    expect(ca!.subject).toContain('dsh-test-alpha-ca')
    expect(ca!.validTo).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('reads the bare base64 the QR carries', () => {
    const ca = readHubCa(ALPHA_CA_BASE64)
    expect(ca?.fingerprint).toBe(ALPHA_CA_FINGERPRINT)
    // Re-encoding has to be stable, or the QR would carry a different blob
    // from the one the console showed.
    expect(ca?.base64).toBe(ALPHA_CA_BASE64)
  })

  it('gives the same answer either way round', () => {
    expect(readHubCa(asPem(ALPHA_CA_BASE64))?.base64).toBe(readHubCa(ALPHA_CA_BASE64)?.base64)
  })

  it('reports whether the certificate is a CA', () => {
    expect(readHubCa(ALPHA_CA_BASE64)?.isCa).toBe(true)
  })

  it('returns null for text that is not a certificate', () => {
    expect(readHubCa('')).toBeNull()
    expect(readHubCa('   ')).toBeNull()
    expect(readHubCa('-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----')).toBeNull()
    expect(readHubCa(ALPHA_CA_FINGERPRINT)).toBeNull()
    expect(readHubCa('C:\\nats\\tls\\ca.crt')).toBeNull()
  })

  it('tolerates a missing field rather than throwing', () => {
    // The status poll runs against profiles whose settings can predate this
    // field, where the value arrives as undefined.
    expect(readHubCa(undefined)).toBeNull()
    expect(readHubCa(null)).toBeNull()
  })
})

describe('fingerprintOfBase64', () => {
  it('matches what readHubCa reports', () => {
    expect(fingerprintOfBase64(ALPHA_CA_BASE64)).toBe(ALPHA_CA_FINGERPRINT)
  })
})

describe('sameFingerprint', () => {
  it('ignores case and separators', () => {
    expect(sameFingerprint(ALPHA_CA_FINGERPRINT.toLowerCase(), ALPHA_CA_FINGERPRINT)).toBe(true)
    expect(sameFingerprint(ALPHA_CA_FINGERPRINT.replace(/:/g, ''), ALPHA_CA_FINGERPRINT)).toBe(true)
    expect(sameFingerprint(ALPHA_CA_FINGERPRINT.replace(/:/g, ' '), ALPHA_CA_FINGERPRINT)).toBe(true)
  })

  it('separates different certificates', () => {
    expect(sameFingerprint(ALPHA_CA_FINGERPRINT, '61:49:3F:1A')).toBe(false)
  })

  it('treats an empty side as no match, never a match', () => {
    expect(sameFingerprint('', '')).toBe(false)
    expect(sameFingerprint('', ALPHA_CA_FINGERPRINT)).toBe(false)
  })
})
