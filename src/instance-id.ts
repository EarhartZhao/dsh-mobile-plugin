/**
 * The per-install subject namespace, `instanceId`.
 *
 * Every install that a phone can talk to needs its own namespace
 * (`svc.dsh.<id>.*` / `evt.dsh.<id>.*`): two hosts answering on the same one
 * both receive every request and race to reply — the phone takes whichever
 * answer lands first, which can be the other machine's, or a
 * `mobile-unauthenticated` from a host that never paired that device. The old
 * schema default was the literal `home`, i.e. every install that never picked
 * a name shared one namespace.
 *
 * So an install that leaves the field empty gets an id generated once and kept:
 *
 * - **8 characters of lowercase base36**: 4 from the millisecond timestamp,
 *   then 4 random. Short enough to read off the console and dictate, and the
 *   random half is 36^4 ≈ 1.7M wide, so two installs created in the same
 *   millisecond still almost never collide. The timestamp half keeps ids that
 *   were minted close together looking alike, which is what makes "which of
 *   these two is the newer install" answerable at a glance.
 * - **Persisted outside the package**, in `$DSH_HOME/mobile-bridge/instances.json`,
 *   under the key of the profile this copy was loaded from. Two profiles on one
 *   machine share that file (and the whole `$DSH_HOME`), so the key is what
 *   keeps them from sharing a namespace.
 * - **An explicit `instanceId` always wins.** Generation is only the fallback
 *   for an empty field, and the stored value survives reinstall, upgrade and
 *   config reset because it never lived in the package or the profile patch.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Characters an id is built from, and the width of each half. */
const ALPHABET = 36
const TIME_CHARS = 4
const RANDOM_CHARS = 4
/** Total: 8 characters, `[0-9a-z]`. */
const ID_LENGTH = TIME_CHARS + RANDOM_CHARS

/** What an id looks like once minted, and what a stored one has to match. */
export const INSTANCE_ID_PATTERN = /^[0-9a-z]{8}$/

/** Where the generated ids live, relative to `$DSH_HOME`. */
export const INSTANCES_FILE = 'mobile-bridge/instances.json'

/** Versioned shape of `instances.json`: one id per install key. */
export interface InstanceIdRecord {
  version: 1
  instances: Record<string, string>
}

/** Where the namespace in effect came from: the config field, or the store. */
export type InstanceIdSource = 'configured' | 'auto'

function base36(value: number, width: number): string {
  return value.toString(ALPHABET).padStart(width, '0')
}

/**
 * Mint one id: `<4 chars of the ms timestamp><4 random base36 chars>`.
 * @param now - millisecond timestamp; injected so a test can pin the clock.
 * @param random - three random bytes; injected so a test can pin the entropy.
 * @returns 8 characters of `[0-9a-z]`, e.g. `n4q7x82b`.
 */
export function generateInstanceId(now: number = Date.now(), random: Uint8Array = randomBytes(3)): string {
  const stamp = base36(now % ALPHABET ** TIME_CHARS, TIME_CHARS)
  const bytes = random.length >= 3 ? random : randomBytes(3)
  const draw = ((bytes[0]! << 16) | (bytes[1]! << 8) | bytes[2]!) % ALPHABET ** RANDOM_CHARS
  return stamp + base36(draw, RANDOM_CHARS)
}

/**
 * Which installation this loaded copy belongs to.
 *
 * Packages arrive from a profile (`profiles/<name>/node_modules/…`, possibly
 * through a pnpm `.pnpm/<hash>` directory whose name changes every release) or
 * straight from a checkout (`link:`, `file:`). Taking everything before the
 * first `node_modules` names the profile in both the hoisted and the isolated
 * layout; a checkout falls back to its own root, which is where a `link:`
 * install of two profiles into one repository would collide — that case has to
 * set `instanceId` by hand.
 * @param loadedFrom - absolute path of the file the plugin was loaded from.
 * @returns a stable key for this installation; never empty.
 */
export function installKey(loadedFrom: string): string {
  const normalized = loadedFrom.replace(/\\/gu, '/')
  const marker = normalized.indexOf('/node_modules/')
  if (marker > 0) return normalized.slice(0, marker)
  const lib = normalized.search(/\/lib\/[^/]*$/u)
  return lib > 0 ? normalized.slice(0, lib) : normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads and writes `instances.json`.
 *
 * A missing file is the normal first run. A damaged one is not silently
 * replaced: the ids in it are what paired phones dial, so the caller gets told
 * and the file is rebuilt from scratch only for the key being asked about
 * (which is the one namespace this install can still fix by re-scanning).
 */
export class InstanceIdStore {
  /** Serializes read-modify-write, so two profiles cannot drop each other's ids. */
  private queue: Promise<unknown> = Promise.resolve()

  /** @param filePath - e.g. `$DSH_HOME/mobile-bridge/instances.json`. */
  constructor(private readonly filePath: string) {}

  /**
   * The id for one installation, minting and persisting it on first use.
   * @param key - {@link installKey} of the loaded copy.
   * @returns the id, and whether this call is what created it.
   */
  load(key: string): Promise<{ id: string, created: boolean }> {
    const run = this.queue.then(() => this.readOrMint(key))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async readOrMint(key: string): Promise<{ id: string, created: boolean }> {
    const record = await this.read()
    const stored = record?.instances[key]
    if (typeof stored === 'string' && INSTANCE_ID_PATTERN.test(stored)) return { id: stored, created: false }
    const id = generateInstanceId()
    await this.write({
      version: 1,
      instances: { ...(record?.instances ?? {}), [key]: id },
    })
    return { id, created: true }
  }

  private async read(): Promise<InstanceIdRecord | null> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return null
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      console.warn(`[mobile-bridge] 实例 ID 文件不是有效 JSON（${this.filePath}）：${String(error)}`
        + '；这台机器会重新生成一个实例 ID，已配对的手机需要重新扫码。')
      return null
    }
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.instances)) {
      console.warn(`[mobile-bridge] 实例 ID 文件格式无效（${this.filePath}）；`
        + '这台机器会重新生成一个实例 ID，已配对的手机需要重新扫码。')
      return null
    }
    const instances: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed.instances)) {
      if (typeof value === 'string') instances[key] = value
    }
    return { version: 1, instances }
  }

  private async write(record: InstanceIdRecord): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, this.filePath)
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

/** Exported for the tests that assert the shape of a minted id. */
export const INSTANCE_ID_LENGTH = ID_LENGTH
