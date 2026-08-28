/**
 * Device tokens and one-time pairing codes, per docs/01-auth-pairing.md.
 *
 * Tokens are random 32-byte values; only their SHA-256 hash is persisted.
 * Pairing codes are short-lived, in-memory only, one-time, and rate-limited.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface DeviceEntry {
  id: string
  name: string
  tokenHash: string
  createdAt: string
  expiresAt: string
  revoked: boolean
}

interface TokenFile {
  version: 1
  devices: DeviceEntry[]
}

interface PairingCode {
  code: string
  expiresAt: number
  failures: number
}

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I
const MAX_PAIRING_FAILURES = 5
const MAX_PENDING_CODES = 3

function hashToken(token: string): string {
  return 'sha256:' + createHash('sha256').update(token, 'utf8').digest('hex')
}

export class TokenStore {
  private devices = new Map<string, DeviceEntry>()
  private tokenIndex = new Map<string, string>() // tokenHash -> deviceId
  private pairingCodes = new Map<string, PairingCode>()
  private loaded = false

  /** @param filePath - e.g. $DSH_HOME/mobile-bridge/tokens.json */
  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const data = JSON.parse(raw) as TokenFile
      if (data.version !== 1 || !Array.isArray(data.devices)) return
      for (const device of data.devices) {
        this.devices.set(device.id, device)
        if (!device.revoked) this.tokenIndex.set(device.tokenHash, device.id)
      }
    } catch {
      // Missing or unreadable file starts an empty store; writes recreate it.
    }
    this.loaded = true
  }

  private async save(): Promise<void> {
    if (!this.loaded) return
    const data: TokenFile = { version: 1, devices: [...this.devices.values()] }
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = this.filePath + '.tmp'
    await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, this.filePath)
  }

  /**
   * Mint a one-time pairing code. Codes live in memory: they expire with the
   * process, which is acceptable for a 120-second credential.
   */
  createPairingCode(ttlSec: number): { code: string, expiresAt: number } {
    this.prunePairingCodes()
    if (this.pairingCodes.size >= MAX_PENDING_CODES) {
      throw new Error('too many pending pairing codes')
    }
    const raw = randomBytes(8)
    let code = ''
    for (let i = 0; i < 8; i++) code += PAIRING_ALPHABET[raw[i] % PAIRING_ALPHABET.length]
    const entry: PairingCode = { code, expiresAt: Date.now() + ttlSec * 1000, failures: 0 }
    this.pairingCodes.set(code, entry)
    return { code, expiresAt: entry.expiresAt }
  }

  /**
   * Redeem a pairing code for a long-lived device token.
   * The code burns on use whether redemption succeeds or not.
   */
  async redeemPairingCode(
    code: string,
    deviceName: string,
    tokenTtlDays: number,
    maxDevices: number,
  ): Promise<{ token: string, deviceId: string, expiresAt: string } | null> {
    this.prunePairingCodes()
    const entry = this.pairingCodes.get(code)
    if (entry === undefined) return null
    this.pairingCodes.delete(code)

    const active = [...this.devices.values()].filter(d => !d.revoked && Date.parse(d.expiresAt) > Date.now())
    if (active.length >= maxDevices) return null

    const token = randomBytes(32).toString('base64url')
    const now = new Date()
    const device: DeviceEntry = {
      id: randomUUID(),
      name: deviceName.slice(0, 64) || 'unknown-device',
      tokenHash: hashToken(token),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + tokenTtlDays * 86400_000).toISOString(),
      revoked: false,
    }
    this.devices.set(device.id, device)
    this.tokenIndex.set(device.tokenHash, device.id)
    await this.save()
    return { token, deviceId: device.id, expiresAt: device.expiresAt }
  }

  /** Validate a bearer token; uniform null for missing/expired/revoked. */
  validate(token: string): DeviceEntry | null {
    const deviceId = this.tokenIndex.get(hashToken(token))
    if (deviceId === undefined) return null
    const device = this.devices.get(deviceId)
    if (device === undefined || device.revoked) return null
    if (Date.parse(device.expiresAt) <= Date.now()) return null
    return device
  }

  async revoke(deviceId: string): Promise<boolean> {
    const device = this.devices.get(deviceId)
    if (device === undefined || device.revoked) return false
    device.revoked = true
    this.tokenIndex.delete(device.tokenHash)
    await this.save()
    return true
  }

  list(): Omit<DeviceEntry, 'tokenHash'>[] {
    return [...this.devices.values()].map(({ tokenHash: _, ...rest }) => rest)
  }

  private prunePairingCodes(): void {
    const now = Date.now()
    for (const [code, entry] of this.pairingCodes) {
      if (entry.expiresAt <= now || entry.failures > MAX_PAIRING_FAILURES) this.pairingCodes.delete(code)
    }
  }
}
