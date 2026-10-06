import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  generateInstanceId,
  InstanceIdStore,
  INSTANCE_ID_PATTERN,
  installKey,
} from '../src/instance-id.js'

const scratch: string[] = []

async function scratchFile(name = 'instances.json'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-instance-'))
  scratch.push(dir)
  return join(dir, name)
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('generateInstanceId', () => {
  it('mints eight characters of lowercase base36', () => {
    for (let i = 0; i < 50; i += 1) {
      const id = generateInstanceId()
      expect(id).toMatch(INSTANCE_ID_PATTERN)
      expect(id).toHaveLength(8)
      expect(id).toBe(id.toLowerCase())
    }
  })

  it('mixes the millisecond timestamp with the random half', () => {
    const random = new Uint8Array([1, 2, 3])
    // Same instant + same entropy = same id, so the halves are actually used.
    expect(generateInstanceId(1_780_000_000_000, random)).toBe(generateInstanceId(1_780_000_000_000, random))
    // A different millisecond changes the first half…
    const base = generateInstanceId(1_780_000_000_000, random)
    expect(generateInstanceId(1_780_000_000_001, random).slice(0, 4)).not.toBe(base.slice(0, 4))
    // …and different entropy changes the second half.
    expect(generateInstanceId(1_780_000_000_000, new Uint8Array([9, 9, 9])).slice(4)).not.toBe(base.slice(4))
  })

  it('keeps ids from the same millisecond apart', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 500; i += 1) ids.add(generateInstanceId(1_780_000_000_000))
    // The random half is 36^4 ≈ 1.7M wide; 500 draws collide with probability
    // ~7%, so this asserts the half exists at all rather than a collision rate.
    expect(ids.size).toBeGreaterThan(450)
  })
})

describe('installKey', () => {
  it('names the profile the package was installed into, not the package copy', () => {
    expect(installKey('/Users/x/.dsh/profiles/web/node_modules/@s/p/lib/index.js'))
      .toBe('/Users/x/.dsh/profiles/web')
    // pnpm's isolated layout resolves through a content-hashed directory whose
    // name changes on every release — the key must not move with it.
    expect(installKey('/Users/x/.dsh/profiles/web/node_modules/.pnpm/@s+p@0.2.35/node_modules/@s/p/lib/index.js'))
      .toBe('/Users/x/.dsh/profiles/web')
    expect(installKey('C:\\Users\\x\\.dsh\\profiles\\desktop\\node_modules\\@s\\p\\lib\\index.js'))
      .toBe('C:/Users/x/.dsh/profiles/desktop')
  })

  it('falls back to the checkout root for link: installs', () => {
    expect(installKey('/Users/x/code/dsh-mobile-plugin/lib/index.js')).toBe('/Users/x/code/dsh-mobile-plugin')
    expect(installKey('/somewhere/index.js')).toBe('/somewhere/index.js')
  })
})

describe('InstanceIdStore', () => {
  it('mints once per installation and keeps it afterwards', async () => {
    const file = await scratchFile()
    const store = new InstanceIdStore(file)

    const first = await store.load('/profiles/web')
    expect(first.created).toBe(true)
    expect(first.id).toMatch(INSTANCE_ID_PATTERN)

    const second = await new InstanceIdStore(file).load('/profiles/web')
    expect(second).toEqual({ id: first.id, created: false })

    // Restarting the plugin, upgrading the package and re-reading the profile
    // patch all boil down to this: the id came from a file, not from memory.
    const raw = JSON.parse(await readFile(file, 'utf8')) as { version: number, instances: Record<string, string> }
    expect(raw.version).toBe(1)
    expect(raw.instances['/profiles/web']).toBe(first.id)
  })

  it('gives each installation on one machine its own id', async () => {
    const file = await scratchFile()
    const store = new InstanceIdStore(file)
    const web = await store.load('/profiles/web')
    const desktop = await store.load('/profiles/desktop')
    // Two profiles share $DSH_HOME (and this file); sharing a namespace is the
    // bug that makes one host answer for the other, so the keys differ.
    expect(desktop.id).not.toBe(web.id)
    const again = await store.load('/profiles/web')
    expect(again.id).toBe(web.id)
  })

  it('survives concurrent callers without minting two ids', async () => {
    const file = await scratchFile()
    const store = new InstanceIdStore(file)
    const ids = await Promise.all(Array.from({ length: 8 }, () => store.load('/profiles/web')))
    expect(new Set(ids.map(entry => entry.id)).size).toBe(1)
  })

  it('rebuilds a damaged file instead of pretending it has an id', async () => {
    const file = await scratchFile()
    await writeFile(file, '{ not json', 'utf8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = new InstanceIdStore(file)
    const { id, created } = await store.load('/profiles/web')
    expect(created).toBe(true)
    expect(id).toMatch(INSTANCE_ID_PATTERN)
    expect(warn).toHaveBeenCalled()
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, instances: { '/profiles/web': id } })
  })
})
