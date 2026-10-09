/**
 * Which files back one installation's gateway identity and paired devices.
 *
 * `$DSH_HOME` is shared by every dsh on a machine — a `web` profile and the
 * Electron `desktop` profile both live under it — so the pre-split layout
 * (`identity.json` and `tokens.json` straight under `mobile-bridge/`) made two
 * installations one gateway: a phone paired with one was authorized on the
 * other, and both answered `mobile.info` with the same `gatewayId`. The wire
 * already keeps a namespace per install (`instanceId`, see src/instance-id.ts);
 * the state behind it has to be per install too.
 *
 * The split cannot move the existing files: whichever install happens to be
 * serving the paired phones has to keep them, or every phone needs a new scan.
 * So the old pair stays where it is and the **first install to reach it claims
 * it** by creating `mobile-bridge/owner` (an exclusive create: exactly one
 * writer wins, and the losers see the winner's key). The owner keeps using the
 * old paths — an upgrade of the install the phone talks to therefore changes
 * nothing for that phone — while every other install works in
 * `mobile-bridge/installs/<name>/`, mints its own gateway id and starts with an
 * empty device list.
 *
 * Everything here is synchronous on purpose: the identity store and the token
 * store are built in the plugin's constructor, and both have to be pointed at
 * the *same* answer, so the decision is taken once, before either store reads.
 *
 * `owner` is a one-line file holding the winner's key. It is deliberately not
 * a field inside `identity.json`: the plugin refuses to rewrite a damaged
 * identity file (a silent new id would turn a paired phone into a stranger),
 * and a claim must never depend on that file being writable. Releasing the
 * claim is a human action — delete `mobile-bridge/owner` and restart — because
 * only the owner knows which dsh should serve the phones.
 *
 * @module
 */

import { createHash, randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Directory under `$DSH_HOME` that holds every mobile-bridge file. */
export const BRIDGE_DIR = 'mobile-bridge'
/** Pre-split gateway identity file, kept for the install that owns it. */
export const IDENTITY_FILE = 'identity.json'
/** Pre-split device token file, kept for the install that owns it. */
export const TOKENS_FILE = 'tokens.json'
/** One-line file naming the installation that owns the two files above. */
export const OWNER_FILE = 'owner'
/** Subdirectory holding one directory per non-owning installation. */
export const INSTALLS_DIR = 'installs'

/** Longest key accepted from `owner`; a real key is a namespace or a path. */
const OWNER_MAX_CHARS = 4096
/** Longest readable slug kept from a path-shaped key. */
const SLUG_MAX_CHARS = 32
/** Hex characters of the key digest appended to a shortened slug. */
const HASH_CHARS = 8

/** Where the shared files stand for this installation. */
export type StoreOwnership =
  /** The pre-split files are this installation's. */
  | 'mine'
  /** Another installation claimed them. */
  | 'other'
  /** Nobody claimed them yet; this call tried to. */
  | 'unclaimed'
  /** `owner` exists but is unreadable or empty. */
  | 'invalid'

/** Files and ownership for one installation. */
export interface BridgeStoreLayout {
  /** This installation's key: see {@link bridgeStoreKey}. */
  readonly key: string
  /** Directory holding this installation's `identity.json` and `tokens.json`. */
  readonly dir: string
  /** Which install the pre-split files belong to. */
  readonly ownership: StoreOwnership
  /** Key recorded in `owner`, when one is readable. */
  readonly ownerKey: string | null
  /** Absolute path of the marker that records the owner. */
  readonly ownerFile: string
  /** Absolute path of the identity file this install reads and writes. */
  readonly identityPath: string
  /** Absolute path of the device token file this install reads and writes. */
  readonly tokensPath: string
}

/**
 * The key that identifies one installation's device state.
 *
 * A namespace written by hand wins, because that is the name the phone dials:
 * renaming it forces a new scan anyway, so the state behind it may as well move
 * with the name. Everything that does *not* change the wire (the package
 * arriving from a profile instead of a checkout, or the other way round) keeps
 * the same key — which is why the key is not simply the loaded-from path. With
 * the field empty there is no name to key on, so the install path is used —
 * the same key src/instance-id.ts keys a generated id by.
 * @param instanceId - the configured namespace, possibly empty.
 * @param installKey - stable key for this loaded copy, see src/instance-id.ts.
 * @returns the key both stores are keyed by; never empty.
 */
export function bridgeStoreKey(instanceId: string, installKey: string): string {
  const configured = instanceId.trim()
  return configured === '' ? installKey : configured
}

/**
 * Directory name for a non-owning install under `installs/`.
 *
 * A namespace-shaped key (`home-mac`, `company-mac-client`) is already a legal
 * directory name and is used as-is, so the directory says which install it
 * belongs to. Anything else — the loaded-from path of a checkout or a profile —
 * is slugged and suffixed with a digest of the full key, so two long paths that
 * share a tail cannot collide.
 * @param key - {@link bridgeStoreKey} of this installation.
 * @returns a single path segment; never empty.
 */
export function storeDirName(key: string): string {
  const slug = key.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^[^a-z0-9]+/u, '').replace(/-+$/u, '')
    .slice(0, SLUG_MAX_CHARS).replace(/-+$/u, '')
  if (slug === key) return key
  const digest = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, HASH_CHARS)
  return slug === '' ? `install-${digest}` : `${slug}-${digest}`
}

function readOwner(ownerPath: string): { kind: 'absent' } | { kind: 'key', key: string } | { kind: 'invalid' } {
  let raw: string
  try {
    raw = readFileSync(ownerPath, 'utf8')
  } catch (error) {
    if (isErrno(error) && error.code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'invalid' }
  }
  const key = raw.trim()
  if (key === '' || key.length > OWNER_MAX_CHARS) return { kind: 'invalid' }
  return { kind: 'key', key }
}

/**
 * Try to become the owner of the pre-split files.
 *
 * `linkSync` is the claim: creating a hard link to a fully written temporary
 * file fails with `EEXIST` when the target is already there, so exactly one
 * process is told it created it. A loser re-reads the file and answers honestly
 * — including the case where the winner used the same key (two copies of one
 * install), which is still an owner, just not a new one.
 * @param root - `$DSH_HOME/mobile-bridge`.
 * @param ownerPath - `root/owner`.
 * @param key - this installation's key.
 * @returns whether this install owns the shared files.
 */
function claimOwner(root: string, ownerPath: string, key: string): boolean {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 })
  } catch (error) {
    console.warn('[mobile-bridge] 无法创建 mobile-bridge 目录，本安装改用独立数据目录：', String(error))
    return false
  }
  const tmp = `${ownerPath}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, `${key}\n`, { encoding: 'utf8', mode: 0o600 })
    linkSync(tmp, ownerPath)
    return true
  } catch (error) {
    if (!isErrno(error) || error.code !== 'EEXIST') {
      console.warn('[mobile-bridge] 无法写 owner 标记，本安装改用独立数据目录：', String(error))
      return false
    }
    const current = readOwner(ownerPath)
    return current.kind === 'key' && current.key === key
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      // The temporary file is already gone when link() consumed nothing, or the
      // directory vanished; neither leaves anything to clean up.
    }
  }
}

/**
 * Resolve where this installation reads and writes device state.
 * @param dshHome - the shared harness home, `$DSH_HOME`.
 * @param key - {@link bridgeStoreKey} of this installation.
 * @returns the layout, with the claim already settled.
 */
export function resolveBridgeStore(dshHome: string, key: string): BridgeStoreLayout {
  const root = join(dshHome, BRIDGE_DIR)
  const ownerPath = join(root, OWNER_FILE)
  const existing = readOwner(ownerPath)
  const shared = (ownership: StoreOwnership, ownerKey: string | null): BridgeStoreLayout => ({
    key,
    dir: root,
    ownership,
    ownerKey,
    ownerFile: ownerPath,
    identityPath: join(root, IDENTITY_FILE),
    tokensPath: join(root, TOKENS_FILE),
  })
  const independent = (ownership: StoreOwnership, ownerKey: string | null): BridgeStoreLayout => {
    const dir = join(root, INSTALLS_DIR, storeDirName(key))
    return {
      key,
      dir,
      ownership,
      ownerKey,
      ownerFile: ownerPath,
      identityPath: join(dir, IDENTITY_FILE),
      tokensPath: join(dir, TOKENS_FILE),
    }
  }

  if (existing.kind === 'key') {
    return existing.key === key ? shared('mine', existing.key) : independent('other', existing.key)
  }
  // An unreadable marker is never overwritten: it may be the only record of
  // which install holds the paired phones, and two installs racing to replace
  // it could both end up believing they own the files.
  if (existing.kind === 'invalid') {
    console.warn(`[mobile-bridge] owner 标记无法解析（${ownerPath}），本安装改用独立数据目录；`
      + '要让本安装接管已有的身份与设备，删除该文件后重启。')
    return independent('invalid', null)
  }
  if (claimOwner(root, ownerPath, key)) return shared('mine', key)
  // The claim failed: another install got there first (its key is now in the
  // file) or the marker could not be written at all. The two are worth telling
  // apart, because only the first one is a healthy machine.
  const settled = readOwner(ownerPath)
  if (settled.kind === 'key') return independent('other', settled.key)
  return independent(settled.kind === 'absent' ? 'unclaimed' : 'invalid', null)
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error
}
