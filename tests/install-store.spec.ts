import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bridgeStoreKey,
  BRIDGE_DIR,
  IDENTITY_FILE,
  INSTALLS_DIR,
  OWNER_FILE,
  resolveBridgeStore,
  storeDirName,
  TOKENS_FILE,
} from '../src/install-store.js'
import { TokenStore } from '../src/tokens.js'

const dirs: string[] = []

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mobile-store-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('bridgeStoreKey', () => {
  it('keys on the namespace the phone dials when one is written by hand', () => {
    expect(bridgeStoreKey('home-mac', '/checkout/dsh-mobile-plugin')).toBe('home-mac')
    expect(bridgeStoreKey('  company-mac-client  ', '/checkout')).toBe('company-mac-client')
  })

  it('falls back to the install key while the namespace is still empty', () => {
    expect(bridgeStoreKey('', '/Users/me/dsh-mobile-plugin')).toBe('/Users/me/dsh-mobile-plugin')
    expect(bridgeStoreKey('   ', '/Users/me/.dsh/profiles/desktop')).toBe('/Users/me/.dsh/profiles/desktop')
  })
})

describe('storeDirName', () => {
  it('uses a namespace-shaped key as the directory name', () => {
    expect(storeDirName('home-mac')).toBe('home-mac')
    expect(storeDirName('company-mac-client')).toBe('company-mac-client')
  })

  it('slugs a path-shaped key and keeps a digest of the whole key', () => {
    const web = storeDirName('/Users/me/Documents/dsh/dsh-mobile-plugin')
    const desktop = storeDirName('/Users/me/.dsh/profiles/desktop')
    expect(web).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/)
    expect(desktop).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/)
    // Two checkouts named the same in different places must not collide.
    expect(storeDirName('/a/dsh-mobile-plugin')).not.toBe(storeDirName('/b/dsh-mobile-plugin'))
    expect(storeDirName('/a/dsh-mobile-plugin').split('-').at(-1))
      .not.toBe(storeDirName('/b/dsh-mobile-plugin').split('-').at(-1))
  })
})

describe('resolveBridgeStore', () => {
  it('lets the first install claim the pre-split files and keeps them in place', async () => {
    const home = await scratch()
    const layout = resolveBridgeStore(home, 'home-mac')
    const root = join(home, BRIDGE_DIR)

    expect(layout.ownership).toBe('mine')
    expect(layout.dir).toBe(root)
    expect(layout.identityPath).toBe(join(root, IDENTITY_FILE))
    expect(layout.tokensPath).toBe(join(root, TOKENS_FILE))
    expect(await readFile(join(root, OWNER_FILE), 'utf8')).toBe('home-mac\n')
  })

  it('never writes the identity or token file it is pointing at', async () => {
    const home = await scratch()
    const layout = resolveBridgeStore(home, 'home-mac')

    // The claim is a marker of its own: an existing pair of files (or a damaged
    // identity the plugin refuses to replace) must survive the upgrade untouched.
    expect(await readdir(layout.dir)).toEqual([OWNER_FILE])
  })

  it('gives every other install its own directory', async () => {
    const home = await scratch()
    const owner = resolveBridgeStore(home, 'home-mac')
    const second = resolveBridgeStore(home, '/Users/me/.dsh/profiles/desktop')

    expect(owner.ownership).toBe('mine')
    expect(second.ownership).toBe('other')
    expect(second.ownerKey).toBe('home-mac')
    expect(second.dir).toBe(join(home, BRIDGE_DIR, INSTALLS_DIR, storeDirName(second.key)))
    expect(second.identityPath).not.toBe(owner.identityPath)
    expect(second.tokensPath).not.toBe(owner.tokensPath)
  })

  it('is stable across calls, so a restart lands on the same files', async () => {
    const home = await scratch()
    const first = resolveBridgeStore(home, 'home-mac')
    const again = resolveBridgeStore(home, 'home-mac')
    expect(again).toEqual(first)
  })

  it('treats a marker naming its own key as owned, even after a restart', async () => {
    const home = await scratch()
    const root = join(home, BRIDGE_DIR)
    await mkdir(root, { recursive: true })
    await writeFile(join(root, OWNER_FILE), 'home-mac\n', 'utf8')

    expect(resolveBridgeStore(home, 'home-mac').ownership).toBe('mine')
    expect(resolveBridgeStore(home, 'other-host').ownership).toBe('other')
  })

  it('refuses to take over an unreadable marker, and says so', async () => {
    const home = await scratch()
    const root = join(home, BRIDGE_DIR)
    const ownerPath = join(root, OWNER_FILE)
    await mkdir(root, { recursive: true })
    await writeFile(ownerPath, '', 'utf8')

    const layout = resolveBridgeStore(home, 'home-mac')
    expect(layout.ownership).toBe('invalid')
    expect(layout.ownerKey).toBeNull()
    expect(layout.dir).toContain(INSTALLS_DIR)
    // The only record of which install holds the paired phones is left alone.
    expect(await readFile(ownerPath, 'utf8')).toBe('')
  })

  it('keeps the claimed key in the marker, not the store directory name', async () => {
    const home = await scratch()
    const key = '/Users/me/.dsh/profiles/web'
    const layout = resolveBridgeStore(home, key)

    expect(layout.ownership).toBe('mine')
    expect(await readFile(join(home, BRIDGE_DIR, OWNER_FILE), 'utf8')).toBe(`${key}\n`)
  })

  it('does not let a device paired with one install talk to the other', async () => {
    // The whole point of the split: two dsh on one machine used to accept each
    // other's phones, because both read the same token file.
    const home = await scratch()
    const owner = resolveBridgeStore(home, 'home-mac')
    const second = resolveBridgeStore(home, '/Users/me/.dsh/profiles/desktop')

    const pairWithOwner = new TokenStore(owner.tokensPath)
    await pairWithOwner.load()
    const { code } = pairWithOwner.createPairingCode(120)
    const paired = await pairWithOwner.redeemPairingCode(code, 'iPhone', 90, 20)
    expect(paired).not.toBeNull()

    const secondStore = new TokenStore(second.tokensPath)
    await secondStore.load()
    expect(secondStore.validate(paired!.token)).toBeNull()

    // …and the owner's own file still knows the device.
    const reloaded = new TokenStore(owner.tokensPath)
    await reloaded.load()
    expect(reloaded.validate(paired!.token)?.name).toBe('iPhone')
  })
})
