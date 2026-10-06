/**
 * Device tokens and one-time pairing codes, per docs/01-auth-pairing.md.
 *
 * Tokens are random 32-byte values; only their SHA-256 hash is persisted.
 * Pairing codes are short-lived, in-memory only, and one-time. Guessing is
 * bounded by the code itself — 8 characters over a 32-letter alphabet
 * (32^8 ≈ 1.1e12), a 120-second lifetime, and at most three pending codes at
 * once — not by a per-code attempt counter: a wrong guess names no code, so
 * there is nothing to count against.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface DeviceEntry {
  id: string
  name: string
  tokenHash: string
  /**
   * Random per-device key used as an extra subject segment for downlink
   * events. Absent on records paired before device-scoped subjects existed,
   * which keeps those clients on the legacy shared subjects until they pair
   * again.
   */
  eventKey?: string
  /** True after the phone echoed eventKey on hello, proving it subscribes there. */
  eventCapable?: boolean
  /** Stable app-install id, when supplied at pairing/hello time. */
  installationId?: string
  createdAt: string
  expiresAt: string
  /** Last authenticated request observed for this device, if any. */
  lastSeenAt?: string | null
  revoked: boolean
}

interface TokenFile {
  version: 1 | 2
  devices: DeviceEntry[]
}

interface PairingCode {
  code: string
  expiresAt: number
}

export interface PairedDeviceToken {
  token: string
  deviceId: string
  expiresAt: string
  eventKey: string
  installationId?: string
}

export type PairingRedemption =
  | { ok: true, value: PairedDeviceToken }
  | { ok: false, reason: 'invalid-code' | 'device-limit' }

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I
const MAX_PENDING_CODES = 3

/**
 * Device records kept on disk. Revoked and expired devices stay listed (the
 * console shows them as history), so without a cap a long-lived bridge would
 * grow `tokens.json` with every pairing it ever saw.
 */
const DEVICE_HISTORY_LIMIT = 200

/** How often last-seen updates are persisted instead of waiting for the next mutation. */
const LAST_SEEN_SAVE_MS = 60_000

function normalizeInstallationId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)
    ? trimmed.toLowerCase()
    : undefined
}

/**
 * Identity used to present one row for one phone. Installation ids are the
 * reliable key when the App supplies one; older clients paired before that
 * field existed, so their display name is the only available fallback.
 */
function deviceIdentity(device: DeviceEntry): string {
  const installationId = normalizeInstallationId(device.installationId)
  return installationId === undefined
    ? `name:${device.name.trim().toLocaleLowerCase()}`
    : `installation:${installationId}`
}

function timeValue(value: string | null | undefined): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isNaN(parsed) ? 0 : parsed
}

/** Prefer live state, then the most recently active/newest duplicate. */
function preferDevice(left: DeviceEntry, right: DeviceEntry): boolean {
  if (left.revoked !== right.revoked) return !left.revoked
  const seen = timeValue(left.lastSeenAt) - timeValue(right.lastSeenAt)
  if (seen !== 0) return seen > 0
  return timeValue(left.createdAt) > timeValue(right.createdAt)
}

function hashToken(token: string): string {
  return 'sha256:' + createHash('sha256').update(token, 'utf8').digest('hex')
}

export class TokenStore {
  private devices = new Map<string, DeviceEntry>()
  private tokenIndex = new Map<string, string>() // tokenHash -> deviceId
  private pairingCodes = new Map<string, PairingCode>()
  private loaded = false
  /** Tail of the serialized write queue; see {@link save}. */
  private saveTail: Promise<void> = Promise.resolve()
  /** Set while a mutation is waiting to be written, so writes coalesce safely. */
  private saveRequested = false
  private lastSeenTimer: ReturnType<typeof setTimeout> | null = null

  /** @param filePath - e.g. $DSH_HOME/mobile-bridge/tokens.json */
  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const data = JSON.parse(raw) as TokenFile
      if ((data.version !== 1 && data.version !== 2) || !Array.isArray(data.devices)) return
      for (const device of data.devices) {
        this.devices.set(device.id, device)
        if (!device.revoked) this.tokenIndex.set(device.tokenHash, device.id)
      }
    } catch {
      // Missing or unreadable file starts an empty store; writes recreate it.
    }
    this.loaded = true
  }

  /**
   * Persist the current snapshot through one serialized writer.
   *
   * Pairing, rename, revoke and forget can all overlap (for example, the
   * console's device table makes several requests back-to-back). Writing
   * directly to one shared `.tmp` path lets those calls overwrite each other
   * or rename a path that another call already moved. Each write therefore
   * gets its own unique temporary file and the queue keeps the final mutation
   * authoritative. A call that arrives while a write is in flight sets the
   * requested bit, so that write cannot silently leave the newest state on the
   * floor.
   */
  private save(): Promise<void> {
    this.saveRequested = true
    const next = this.saveTail.then(async () => {
      if (!this.saveRequested) return
      this.saveRequested = false
      await this.writeSnapshot()
    })
    // A failed write must be reported to its caller, but must not poison the
    // queue: the next save should still be able to recover.
    this.saveTail = next.catch(() => undefined)
    return next
  }

  private async writeSnapshot(): Promise<void> {
    if (!this.loaded) return
    this.pruneDevices()
    const data: TokenFile = { version: 2, devices: [...this.devices.values()] }
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, this.filePath)
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  /** Drop the oldest records past the cap, dead ones first, keeping memory and disk in step. */
  private pruneDevices(): void {
    if (this.devices.size <= DEVICE_HISTORY_LIMIT) return
    const now = Date.now()
    const isDead = (device: DeviceEntry): boolean => device.revoked || Date.parse(device.expiresAt) <= now
    const byNewest = (left: DeviceEntry, right: DeviceEntry): number =>
      Date.parse(right.createdAt) - Date.parse(left.createdAt)
    const all = [...this.devices.values()]
    const keep = [
      ...all.filter(device => !isDead(device)).sort(byNewest),
      ...all.filter(isDead).sort(byNewest),
    ].slice(0, DEVICE_HISTORY_LIMIT)
    const kept = new Set(keep.map(device => device.id))
    for (const device of all) {
      if (kept.has(device.id)) continue
      this.devices.delete(device.id)
      this.tokenIndex.delete(device.tokenHash)
    }
  }

  /**
   * Mint a one-time pairing code. Codes live in memory: they expire with the
   * process, which is acceptable for a 120-second credential.
   */
  createPairingCode(ttlSec: number): { code: string, expiresAt: number } {
    this.prunePairingCodes()
    // Regenerating is the normal owner action — the previous code expired, it
    // went stale mid-scan, or it was shown on the wrong screen. Refusing the
    // mint with an opaque error only strands the wizard, so the oldest code
    // gives way. What limits a guesser is how many codes are valid at once,
    // and that stays MAX_PENDING_CODES.
    while (this.pairingCodes.size >= MAX_PENDING_CODES) {
      const oldest = [...this.pairingCodes]
        .sort((left, right) => left[1].expiresAt - right[1].expiresAt)[0]
      if (oldest === undefined) break
      this.pairingCodes.delete(oldest[0])
    }
    const raw = randomBytes(8)
    let code = ''
    for (let i = 0; i < 8; i++) code += PAIRING_ALPHABET[raw[i] % PAIRING_ALPHABET.length]
    const entry: PairingCode = { code, expiresAt: Date.now() + ttlSec * 1000 }
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
    installationId?: string,
  ): Promise<PairedDeviceToken | null> {
    const result = await this.redeemPairingCodeResult(code, deviceName, tokenTtlDays, maxDevices, installationId)
    return result.ok ? result.value : null
  }

  /** Redeem a pairing code while preserving the user-actionable refusal reason. */
  async redeemPairingCodeResult(
    code: string,
    deviceName: string,
    tokenTtlDays: number,
    maxDevices: number,
    installationId?: string,
  ): Promise<PairingRedemption> {
    this.prunePairingCodes()
    const entry = this.pairingCodes.get(code)
    if (entry === undefined) return { ok: false, reason: 'invalid-code' }
    this.pairingCodes.delete(code)

    const stableId = normalizeInstallationId(installationId)
    const existing = stableId === undefined
      ? undefined
      : [...this.devices.values()].find(device => device.installationId === stableId)
    const active = [...this.devices.values()].filter(d =>
      d.id !== existing?.id && !d.revoked && Date.parse(d.expiresAt) > Date.now())
    if (active.length >= maxDevices) return { ok: false, reason: 'device-limit' }

    const token = randomBytes(32).toString('base64url')
    const now = new Date()
    const expiresAt = new Date(now.getTime() + tokenTtlDays * 86400_000).toISOString()
    const device: DeviceEntry = existing === undefined
      ? {
          id: randomUUID(),
          name: deviceName.slice(0, 64) || 'unknown-device',
          tokenHash: hashToken(token),
          eventKey: randomBytes(18).toString('base64url'),
          ...(stableId === undefined ? {} : { installationId: stableId }),
          createdAt: now.toISOString(),
          expiresAt,
          lastSeenAt: null,
          revoked: false,
        }
      : {
          ...existing,
          name: deviceName.slice(0, 64) || existing.name,
          tokenHash: hashToken(token),
          ...(stableId === undefined ? {} : { installationId: stableId }),
          expiresAt,
          lastSeenAt: null,
          revoked: false,
        }
    if (existing !== undefined) this.tokenIndex.delete(existing.tokenHash)
    this.devices.set(device.id, device)
    this.tokenIndex.set(device.tokenHash, device.id)
    await this.save()
    return {
      ok: true,
      value: {
        token,
        deviceId: device.id,
        expiresAt: device.expiresAt,
        eventKey: device.eventKey!,
        ...(device.installationId === undefined ? {} : { installationId: device.installationId }),
      },
    }
  }

  /** Validate a bearer token; uniform null for missing/expired/revoked. */
  validate(token: string): DeviceEntry | null {
    const deviceId = this.tokenIndex.get(hashToken(token))
    if (deviceId === undefined) return null
    const device = this.devices.get(deviceId)
    if (device === undefined || device.revoked) return null
    if (Date.parse(device.expiresAt) <= Date.now()) return null
    this.markSeen(device.id)
    return device
  }

  /**
   * Record authenticated activity without turning every RPC into a disk write.
   * The latest value always lives in memory; it is flushed in the background
   * and by {@link flushSeen}, so a process crash loses at most a minute of
   * "last seen" precision.
   */
  markSeen(deviceId: string, at = new Date()): boolean {
    const device = this.devices.get(deviceId)
    if (device === undefined || device.revoked) return false
    device.lastSeenAt = at.toISOString()
    if (this.lastSeenTimer === null) {
      this.lastSeenTimer = setTimeout(() => {
        this.lastSeenTimer = null
        void this.save().catch(() => undefined)
      }, LAST_SEEN_SAVE_MS)
      this.lastSeenTimer.unref?.()
    }
    return true
  }

  /** Persist any last-seen changes immediately; lifecycle shutdown calls this. */
  async flushSeen(): Promise<void> {
    if (this.lastSeenTimer !== null) {
      clearTimeout(this.lastSeenTimer)
      this.lastSeenTimer = null
    }
    await this.save()
  }

  async revoke(deviceId: string): Promise<boolean> {
    const device = this.devices.get(deviceId)
    if (device === undefined || device.revoked) return false
    device.revoked = true
    this.tokenIndex.delete(device.tokenHash)
    await this.save()
    return true
  }

  /** Revoke every live record that presents the same device identity. */
  async revokeGroup(deviceId: string): Promise<boolean> {
    const device = this.devices.get(deviceId)
    if (device === undefined || device.revoked) return false
    const identity = deviceIdentity(device)
    const duplicates = [...this.devices.values()]
      .filter(candidate => !candidate.revoked && deviceIdentity(candidate) === identity)
    if (duplicates.length === 0) return false
    for (const duplicate of duplicates) {
      duplicate.revoked = true
      this.tokenIndex.delete(duplicate.tokenHash)
    }
    await this.save()
    return true
  }

  /**
   * Rename a live device. The phone owns its own name (its build, its system
   * version, or whatever its owner typed), so it re-states it on every
   * reconnect and the console stop showing a roster of identical `android`
   * rows. Revoked or unknown devices keep the name they were paired with:
   * history is a record, not a live label.
   * @param deviceId - record to rename.
   * @param name - new display name; trimmed and capped like pairing's.
   * @returns whether a live device was renamed.
   */
  async rename(deviceId: string, name: string): Promise<boolean> {
    const device = this.devices.get(deviceId)
    if (device === undefined || device.revoked) return false
    const trimmed = name.trim().slice(0, 64)
    if (trimmed === '' || trimmed === device.name) return false
    device.name = trimmed
    await this.save()
    return true
  }

  /**
   * Attach a stable app-install id to an existing device record. This lets a
   * phone upgrade to the installation-aware protocol without re-pairing first;
   * the next pairing can then replace the same record instead of adding a
   * duplicate.
   */
  async rememberInstallation(deviceId: string, installationId: string): Promise<boolean> {
    const device = this.devices.get(deviceId)
    const normalized = normalizeInstallationId(installationId)
    if (device === undefined || device.revoked || normalized === undefined) return false
    if (device.installationId === normalized) return false
    device.installationId = normalized
    await this.save()
    return true
  }

  /**
   * Mark a device as using device-scoped event subjects. The echoed key must
   * match the one assigned at pairing; an old App that ignores the response
   * never sends this, so the shared compatibility subject stays alive until
   * every active device proves it has migrated.
   */
  async rememberEventCapability(deviceId: string, eventKey: string): Promise<boolean> {
    const device = this.devices.get(deviceId)
    if (device === undefined || device.revoked || device.eventKey === undefined) return false
    if (device.eventKey !== eventKey || device.eventCapable === true) return false
    device.eventCapable = true
    await this.save()
    return true
  }

  /**
   * Drop one revoked device's record for good, so the console's history stops
   * carrying every pairing it ever saw. Only revoked devices are forgettable:
   * deleting a live one would leave its token working with nothing on disk to
   * attribute the request to — revoking first is the whole point of the step.
   * @param deviceId - record to delete.
   * @returns whether a revoked record was removed; false for live or unknown ids.
   */
  async forget(deviceId: string): Promise<boolean> {
    const device = this.devices.get(deviceId)
    if (device === undefined || !device.revoked) return false
    this.devices.delete(deviceId)
    this.tokenIndex.delete(device.tokenHash)
    await this.save()
    return true
  }

  /** Drop every revoked record behind one deduplicated history row. */
  async forgetGroup(deviceId: string): Promise<boolean> {
    const device = this.devices.get(deviceId)
    if (device === undefined || !device.revoked) return false
    const identity = deviceIdentity(device)
    const duplicates = [...this.devices.values()]
      .filter(candidate => candidate.revoked && deviceIdentity(candidate) === identity)
    if (duplicates.length === 0) return false
    for (const duplicate of duplicates) {
      this.devices.delete(duplicate.id)
      this.tokenIndex.delete(duplicate.tokenHash)
    }
    await this.save()
    return true
  }

  list(): Omit<DeviceEntry, 'tokenHash' | 'eventKey'>[] {
    return [...this.devices.values()].map(({ tokenHash: _, eventKey: _eventKey, ...rest }) => rest)
  }

  /**
   * The roster the UI shows: one row per installation id, or per legacy name
   * when an old pairing never carried an installation id. A live record wins
   * over revoked history so a re-paired phone does not appear twice.
   */
  listDeduplicated(): Omit<DeviceEntry, 'tokenHash' | 'eventKey'>[] {
    const selected = new Map<string, DeviceEntry>()
    for (const device of this.devices.values()) {
      const identity = deviceIdentity(device)
      const current = selected.get(identity)
      if (current === undefined || preferDevice(device, current)) selected.set(identity, device)
    }
    return [...selected.values()].map(({ tokenHash: _, eventKey: _eventKey, ...rest }) => rest)
  }

  /** Random subject segments for active, event-capable devices. */
  eventKeys(): string[] {
    const now = Date.now()
    return [...this.devices.values()]
      .filter(device => !device.revoked && Date.parse(device.expiresAt) > now && device.eventKey !== undefined)
      .map(device => device.eventKey!)
  }

  /** Whether any active device still needs the legacy shared event subjects. */
  hasLegacyActiveDevices(): boolean {
    const now = Date.now()
    return [...this.devices.values()].some(device =>
      !device.revoked && Date.parse(device.expiresAt) > now
      && (device.eventKey === undefined || device.eventCapable !== true))
  }

  /** Number of non-revoked, non-expired devices counted against the limit. */
  activeCount(): number {
    const now = Date.now()
    return [...this.devices.values()].filter(device => !device.revoked && Date.parse(device.expiresAt) > now).length
  }

  /** Active device rows after duplicate attendance is collapsed for display. */
  activeVisibleCount(): number {
    const now = Date.now()
    return [...this.devices.values()]
      .filter(device => !device.revoked && Date.parse(device.expiresAt) > now)
      .reduce((selected, device) => {
        const identity = deviceIdentity(device)
        const current = selected.get(identity)
        if (current === undefined || preferDevice(device, current)) selected.set(identity, device)
        return selected
      }, new Map<string, DeviceEntry>())
      .size
  }

  private prunePairingCodes(): void {
    const now = Date.now()
    for (const [code, entry] of this.pairingCodes) {
      if (entry.expiresAt <= now) this.pairingCodes.delete(code)
    }
  }
}
