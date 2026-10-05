/**
 * The Hub's CA certificate, as the pairing QR carries it to the phone.
 *
 * The App no longer ships a fixed anchor for one Hub: the QR carries the CA
 * itself and the App installs it for the address the same QR names (docs/02
 * §「运行时信任锚」)。That makes the QR the single out-of-band trust bootstrap,
 * and it is why this module lives in the plugin — the desktop owns the
 * certificate, the phone gets a blob it can hand straight to the platform TLS
 * stack.
 *
 * Wire form is standard base64 of the DER certificate, without PEM armour. A
 * P-256 CA is ~700 bytes DER (~950 characters of base64); the armoured PEM adds
 * headers and newlines on top, and QR density is what decides whether a camera
 * resolves the code off a screen.
 */
import { createHash, X509Certificate } from 'node:crypto'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * `X509Certificate.validTo` is OpenSSL's `Sep 27 08:04:14 2036 GMT`. The
 * console shows this next to the fingerprint, so it is worth turning into a
 * date a person reads without counting months.
 */
function isoDateOf(validTo: string): string {
  const trimmed = validTo.trim()
  const match = /^([A-Z][a-z]{2}) (\d{1,2}) \d{2}:\d{2}:\d{2} (\d{4}) GMT$/.exec(trimmed)
  if (match === null) return trimmed
  const month = MONTHS.indexOf(match[1]) + 1
  if (month === 0) return trimmed
  return `${match[3]}-${String(month).padStart(2, '0')}-${match[2].padStart(2, '0')}`
}

/** A CA certificate in every shape the plugin needs it. */
export interface HubCa {
  /** Armoured PEM, for `tls.connect({ ca })` and for showing the owner. */
  pem: string
  /** Bare base64 DER — exactly what the QR's `ca` field carries. */
  base64: string
  /** Uppercase colon-separated SHA-256, the shape `openssl -fingerprint` prints. */
  fingerprint: string
  /** Distinguished name, for the console's readout. */
  subject: string
  /** Not-after date, `YYYY-MM-DD`, for the console's readout. */
  validTo: string
  /** Whether the certificate is itself a CA (`basicConstraints CA:TRUE`). */
  isCa: boolean
}

/**
 * Strips PEM armour or whitespace and returns DER, or null when unusable.
 *
 * Accepts `unknown` on purpose: this runs on every status poll, and a profile
 * whose settings predate this field hands over `undefined` rather than the
 * empty-string default.
 */
function decodeToDer(input: unknown): Buffer | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (trimmed === '') return null

  if (trimmed.includes('BEGIN CERTIFICATE')) {
    const body = trimmed
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s+/g, '')
    const der = Buffer.from(body, 'base64')
    return der.length === 0 ? null : der
  }

  // Bare base64 (the shape the QR uses). Anything else — a hex fingerprint, a
  // file path — fails the alphabet check and is reported as unreadable rather
  // than being silently decoded into garbage.
  const compact = trimmed.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null
  const der = Buffer.from(compact, 'base64')
  return der.length === 0 ? null : der
}

/**
 * Reads a CA certificate from PEM or base64 DER. Returns null when the text is
 * not a certificate at all, so callers can tell "not configured" from
 * "configured wrong" by testing the empty string separately.
 */
export function readHubCa(input: unknown): HubCa | null {
  const der = decodeToDer(input)
  return der === null ? null : hubCaFromDer(der)
}

/**
 * The same readout, for a certificate that arrived as DER rather than as text.
 *
 * {@link readHubCa} starts from what the owner pasted; this starts from what a
 * peer sent — the TLS chain a Hub hands over (see `fetchHubCertificate`).
 * @param der Raw certificate bytes.
 * @returns The certificate in every shape the plugin needs, or null when the
 * bytes are not a parseable X.509 certificate.
 */
export function hubCaFromDer(der: Buffer): HubCa | null {
  let certificate: X509Certificate
  try {
    certificate = new X509Certificate(der)
  } catch {
    return null
  }
  const base64 = der.toString('base64')
  return {
    pem: certificate.toString(),
    base64,
    fingerprint: fingerprintOfBase64(base64),
    subject: certificate.subject.replace(/\n/g, ', '),
    validTo: isoDateOf(certificate.validTo),
    isCa: certificate.ca,
  }
}

/** SHA-256 of a base64 DER certificate, in the shape humans compare. */
export function fingerprintOfBase64(base64: string): string {
  return fingerprintOf(Buffer.from(base64, 'base64'))
}

/** SHA-256 of a DER certificate, in the shape humans compare. */
export function fingerprintOf(der: Buffer): string {
  const digest = createHash('sha256').update(der).digest()
  return digest.toString('hex').toUpperCase().replace(/(..)(?=.)/g, '$1:')
}

/**
 * Whether two fingerprints name the same certificate. Tolerates case, missing
 * separators and the shapes people paste out of `openssl`, Keychain or a phone
 * screenshot — the point is to catch a genuinely different certificate, not to
 * police formatting.
 */
export function sameFingerprint(left: string, right: string): boolean {
  const normalize = (value: string): string => value.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  const a = normalize(left)
  const b = normalize(right)
  return a !== '' && a === b
}
