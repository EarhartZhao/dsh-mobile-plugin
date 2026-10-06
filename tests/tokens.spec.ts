import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TokenStore } from '../src/tokens.js'

describe('TokenStore', () => {
  let dir: string
  let store: TokenStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-mobile-tokens-'))
    store = new TokenStore(join(dir, 'tokens.json'))
    await store.load()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('redeems a pairing code into a valid token', async () => {
    const { code } = store.createPairingCode(120)
    const result = await store.redeemPairingCode(code, 'Pixel 8', 90, 10)
    expect(result).not.toBeNull()
    expect(store.validate(result!.token)?.name).toBe('Pixel 8')
  })

  it('burns the code on use (one-time)', async () => {
    const { code } = store.createPairingCode(120)
    await store.redeemPairingCode(code, 'a', 90, 10)
    expect(await store.redeemPairingCode(code, 'b', 90, 10)).toBeNull()
  })

  it('rejects unknown codes', async () => {
    expect(await store.redeemPairingCode('NOPE1234', 'a', 90, 10)).toBeNull()
  })

  it('lets the wizard mint past the pending bound by retiring the oldest code', async () => {
    const first = store.createPairingCode(120)
    store.createPairingCode(120)
    store.createPairingCode(120)

    // The fourth mint is a regeneration, not an attack: it must succeed.
    const fourth = store.createPairingCode(120)

    // ...at the cost of the oldest code, leaving 3 simultaneously valid.
    expect(await store.redeemPairingCode(first.code, 'a', 90, 10)).toBeNull()
    expect(await store.redeemPairingCode(fourth.code, 'b', 90, 10)).not.toBeNull()
  })

  it('never keeps more than the pending bound valid at once', async () => {
    const codes = Array.from({ length: 6 }, () => store.createPairingCode(120).code)

    // Only the newest three survive; the earlier ones are gone.
    for (const stale of codes.slice(0, 3)) {
      expect(await store.redeemPairingCode(stale, 'a', 90, 100)).toBeNull()
    }
    for (const live of codes.slice(3)) {
      expect(await store.redeemPairingCode(live, 'a', 90, 100)).not.toBeNull()
    }
  })

  it('rejects expired codes', async () => {
    const { code } = store.createPairingCode(-1)
    expect(await store.redeemPairingCode(code, 'a', 90, 10)).toBeNull()
  })

  it('enforces maxDevices', async () => {
    const first = store.createPairingCode(120)
    await store.redeemPairingCode(first.code, 'a', 90, 1)
    const second = store.createPairingCode(120)
    expect(await store.redeemPairingCode(second.code, 'b', 90, 1)).toBeNull()
  })

  it('rotates the token for a re-paired installation instead of adding a twin', async () => {
    const installationId = 'd56a1098-8519-43a1-9dce-fb99863bf5bb'
    const first = store.createPairingCode(120)
    const firstDevice = await store.redeemPairingCode(first.code, 'Pixel 8', 90, 1, installationId)
    const second = store.createPairingCode(120)
    const secondDevice = await store.redeemPairingCode(second.code, 'Pixel 8', 90, 1, installationId)

    expect(secondDevice!.deviceId).toBe(firstDevice!.deviceId)
    expect(secondDevice!.token).not.toBe(firstDevice!.token)
    expect(store.list()).toHaveLength(1)
    expect(store.validate(firstDevice!.token)).toBeNull()
    expect(store.validate(secondDevice!.token)?.id).toBe(firstDevice!.deviceId)
  })

  it('keeps the shared event subject until every active device echoes its key', async () => {
    const first = store.createPairingCode(120)
    const firstDevice = await store.redeemPairingCode(first.code, 'Pixel 8', 90, 10)
    const second = store.createPairingCode(120)
    const secondDevice = await store.redeemPairingCode(second.code, 'Pixel 9', 90, 10)

    expect(store.hasLegacyActiveDevices()).toBe(true)
    expect(store.eventKeys()).toEqual([firstDevice!.eventKey, secondDevice!.eventKey])

    expect(await store.rememberEventCapability(firstDevice!.deviceId, 'wrong-key')).toBe(false)
    expect(store.hasLegacyActiveDevices()).toBe(true)
    expect(await store.rememberEventCapability(firstDevice!.deviceId, firstDevice!.eventKey)).toBe(true)
    expect(store.hasLegacyActiveDevices()).toBe(true)
    expect(await store.rememberEventCapability(secondDevice!.deviceId, secondDevice!.eventKey)).toBe(true)
    expect(store.hasLegacyActiveDevices()).toBe(false)

    const reloaded = new TokenStore(join(dir, 'tokens.json'))
    await reloaded.load()
    expect(reloaded.hasLegacyActiveDevices()).toBe(false)
    expect(reloaded.list().map(device => device.eventCapable)).toEqual([true, true])
  })

  it('keeps pre-event-key devices on the shared subject', async () => {
    const file = join(dir, 'tokens.json')
    await writeFile(file, JSON.stringify({
      version: 1,
      devices: [{
        id: 'legacy-device',
        name: 'legacy',
        tokenHash: 'sha256:legacy',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        revoked: false,
      }],
    }), 'utf8')

    const reloaded = new TokenStore(file)
    await reloaded.load()
    expect(reloaded.eventKeys()).toEqual([])
    expect(reloaded.hasLegacyActiveDevices()).toBe(true)
    expect(await reloaded.rememberEventCapability('legacy-device', 'anything')).toBe(false)
    expect(reloaded.hasLegacyActiveDevices()).toBe(true)
  })

  it('distinguishes an invalid code from the device limit', async () => {
    await expect(store.redeemPairingCodeResult('NOPE1234', 'a', 90, 1)).resolves.toEqual({
      ok: false,
      reason: 'invalid-code',
    })
    const first = store.createPairingCode(120)
    await store.redeemPairingCode(first.code, 'a', 90, 1)
    const second = store.createPairingCode(120)
    await expect(store.redeemPairingCodeResult(second.code, 'b', 90, 1)).resolves.toEqual({
      ok: false,
      reason: 'device-limit',
    })
  })

  it('revocation is immediate and persisted', async () => {
    const { code } = store.createPairingCode(120)
    const result = await store.redeemPairingCode(code, 'a', 90, 10)
    expect(await store.revoke(result!.deviceId)).toBe(true)
    expect(store.validate(result!.token)).toBeNull()

    const reloaded = new TokenStore(join(dir, 'tokens.json'))
    await reloaded.load()
    expect(reloaded.validate(result!.token)).toBeNull()
    expect(reloaded.list()).toHaveLength(1)
    expect(reloaded.list()[0].revoked).toBe(true)
    expect(reloaded.activeCount()).toBe(0)
  })

  it('renames a live device and persists it, so the roster stops showing bare platform names', async () => {
    const { code } = store.createPairingCode(120)
    const device = await store.redeemPairingCode(code, 'android', 90, 10)
    expect(await store.rename(device!.deviceId, '  Pixel 8 · Android 16  ')).toBe(true)
    expect(store.list()[0].name).toBe('Pixel 8 · Android 16')

    const reloaded = new TokenStore(join(dir, 'tokens.json'))
    await reloaded.load()
    expect(reloaded.list()[0].name).toBe('Pixel 8 · Android 16')
  })

  it('ignores renames that change nothing, and refuses revoked or unknown devices', async () => {
    const { code } = store.createPairingCode(120)
    const device = await store.redeemPairingCode(code, 'android', 90, 10)
    // The app states its name on every reconnect; the common case is "no news".
    expect(await store.rename(device!.deviceId, 'android')).toBe(false)
    expect(await store.rename(device!.deviceId, '   ')).toBe(false)
    expect(await store.rename('no-such-device', 'whatever')).toBe(false)

    await store.revoke(device!.deviceId)
    expect(await store.rename(device!.deviceId, 'after-revoke')).toBe(false)
    expect(store.list()[0].name).toBe('android')
  })

  it('forgets only revoked records, and does so for good', async () => {
    const { code } = store.createPairingCode(120)
    const live = await store.redeemPairingCode(code, 'a', 90, 10)
    const second = store.createPairingCode(120)
    const dead = await store.redeemPairingCode(second.code, 'b', 90, 10)

    // A live device is not forgettable: that would drop a working token's record.
    expect(await store.forget(live!.deviceId)).toBe(false)
    expect(store.list()).toHaveLength(2)

    expect(await store.revoke(dead!.deviceId)).toBe(true)
    expect(await store.forget(dead!.deviceId)).toBe(true)
    // The record leaves the history entirely, unlike a revocation.
    expect(store.list().map(device => device.id)).toEqual([live!.deviceId])
    expect(await store.forget(dead!.deviceId)).toBe(false)
    // The live device still authenticates; the deleted one never did.
    expect(store.validate(live!.token)).not.toBeNull()
    expect(store.validate(dead!.token)).toBeNull()

    const reloaded = new TokenStore(join(dir, 'tokens.json'))
    await reloaded.load()
    expect(reloaded.list().map(device => device.id)).toEqual([live!.deviceId])
  })

  it('persists tokens across reloads without storing plaintext', async () => {
    const { code } = store.createPairingCode(120)
    const result = await store.redeemPairingCode(code, 'a', 90, 10)

    const reloaded = new TokenStore(join(dir, 'tokens.json'))
    await reloaded.load()
    expect(reloaded.validate(result!.token)).not.toBeNull()

    const raw = await import('node:fs/promises').then(fs => fs.readFile(join(dir, 'tokens.json'), 'utf8'))
    expect(raw).not.toContain(result!.token)
  })

  it('serializes overlapping mutations without losing the final state', async () => {
    const devices = []
    for (let index = 0; index < 3; index++) {
      const { code } = store.createPairingCode(120)
      devices.push(await store.redeemPairingCode(code, `device-${index}`, 90, 10))
    }

    await Promise.all([
      store.rename(devices[0]!.deviceId, 'first-final'),
      store.rename(devices[1]!.deviceId, 'second-final'),
      store.revoke(devices[2]!.deviceId),
      store.forget('missing-device'),
    ])
    await Promise.all([
      store.rename(devices[0]!.deviceId, 'first-latest'),
      store.rename(devices[1]!.deviceId, 'second-latest'),
    ])

    const reloaded = new TokenStore(join(dir, 'tokens.json'))
    await reloaded.load()
    expect(reloaded.list().map(device => [device.name, device.revoked])).toEqual([
      ['first-latest', false],
      ['second-latest', false],
      ['device-2', true],
    ])
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('TokenStore deduplicated roster', () => {
  const HOUR = 3_600_000

  /** Write a ledger by hand so we control ids, names and timeline exactly. */
  async function seeded(
    devices: Array<Record<string, unknown>>,
  ): Promise<{ store: TokenStore, dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mobile-tokens-dedupe-'))
    const file = join(dir, 'tokens.json')
    // Relative to the wall clock, not a fixed date: `activeVisibleCount` and
    // the pruning both compare `expiresAt` against now.
    const now = Date.now()
    const rows = devices.map((device, index) => ({
      tokenHash: `sha256:seeded-${String(index)}`,
      createdAt: new Date(now - HOUR).toISOString(),
      expiresAt: new Date(now + 30 * 24 * HOUR).toISOString(),
      revoked: false,
      ...device,
    }))
    await writeFile(file, JSON.stringify({ version: 2, devices: rows }), 'utf8')
    const store = new TokenStore(file)
    await store.load()
    return { store, dir }
  }

  it('shows one row per installation id and prefers the freshest record', async () => {
    const installationId = 'd56a1098-8519-43a1-9dce-fb99863bf5bb'
    const { store, dir } = await seeded([
      { id: 'old', name: 'android', installationId, lastSeenAt: new Date(Date.parse('2026-01-31T20:00:00.000Z')).toISOString() },
      { id: 'new', name: 'Android 16 · vivo', installationId, lastSeenAt: new Date(Date.parse('2026-01-31T23:00:00.000Z')).toISOString() },
    ])
    try {
      expect(store.list()).toHaveLength(2)
      const visible = store.listDeduplicated()
      expect(visible).toHaveLength(1)
      expect(visible[0].id).toBe('new')
      expect(store.activeVisibleCount()).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the display name for legacy records without an installation id', async () => {
    const { store, dir } = await seeded([
      { id: 'a', name: 'android', lastSeenAt: new Date(Date.parse('2026-01-31T10:00:00.000Z')).toISOString() },
      { id: 'b', name: '  Android ', lastSeenAt: new Date(Date.parse('2026-01-31T11:00:00.000Z')).toISOString() },
      { id: 'c', name: 'Pixel 9' },
    ])
    try {
      const visible = store.listDeduplicated()
      // "android" and "  Android " collapse (case/whitespace-insensitive); the
      // distinct Pixel keeps its own row.
      expect(visible.map(device => device.id).sort()).toEqual(['b', 'c'])
      expect(store.activeVisibleCount()).toBe(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps a live record ahead of its revoked history', async () => {
    const { store, dir } = await seeded([
      { id: 'live', name: 'android', lastSeenAt: new Date(Date.parse('2026-01-31T09:00:00.000Z')).toISOString(), revoked: false },
      { id: 'dead', name: 'android', revoked: true },
    ])
    try {
      const visible = store.listDeduplicated()
      expect(visible).toHaveLength(1)
      expect(visible[0]).toMatchObject({ id: 'live', revoked: false })
      expect(store.activeVisibleCount()).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('revokeGroup revokes every live twin of one identity', async () => {
    const installationId = 'd56a1098-8519-43a1-9dce-fb99863bf5bb'
    const { store, dir } = await seeded([
      { id: 'one', name: 'android', installationId, revoked: false },
      { id: 'two', name: 'android', installationId, revoked: false },
      { id: 'other', name: 'Pixel 9', installationId: '11111111-1111-4111-8111-111111111111', revoked: false },
    ])
    try {
      expect(await store.revokeGroup('one')).toBe(true)
      expect(store.list().filter(device => device.revoked).map(device => device.id).sort()).toEqual(['one', 'two'])
      expect(store.list().find(device => device.id === 'other')?.revoked).toBe(false)
      expect(store.activeVisibleCount()).toBe(1)

      const reloaded = new TokenStore(join(dir, 'tokens.json'))
      await reloaded.load()
      expect(reloaded.list().filter(device => device.revoked)).toHaveLength(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('forgetGroup deletes every revoked twin behind one history row', async () => {
    const { store, dir } = await seeded([
      { id: 'dead-a', name: 'Codex scoped probe', revoked: true },
      { id: 'dead-b', name: 'codex scoped probe', revoked: true },
      { id: 'dead-c', name: 'Codex scoped probe', revoked: true },
      { id: 'keep', name: 'Pixel 9', revoked: false },
    ])
    try {
      // A live record is still not forgettable.
      expect(await store.forgetGroup('keep')).toBe(false)
      expect(await store.forgetGroup('dead-a')).toBe(true)
      expect(store.list().map(device => device.id)).toEqual(['keep'])

      const reloaded = new TokenStore(join(dir, 'tokens.json'))
      await reloaded.load()
      expect(reloaded.list().map(device => device.id)).toEqual(['keep'])
      // The group is gone; a repeat call has nothing left to delete.
      expect(await store.forgetGroup('dead-b')).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('TokenStore device history', () => {
  it('caps the ledger when it grows past the limit, dropping the oldest records first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mobile-tokens-cap-'))
    try {
      const file = join(dir, 'tokens.json')
      const base = Date.parse('2026-01-01T00:00:00.000Z')
      const devices = Array.from({ length: 250 }, (_, index) => ({
        id: `d${String(index).padStart(3, '0')}`,
        name: `device-${String(index)}`,
        tokenHash: `sha256:${String(index)}`,
        createdAt: new Date(base + index * 60_000).toISOString(),
        expiresAt: new Date(base + 365 * 86_400_000).toISOString(),
        revoked: false,
      }))
      await writeFile(file, JSON.stringify({ version: 1, devices }), 'utf8')

      const store = new TokenStore(file)
      await store.load()
      // Any write prunes: revoking the oldest record is the cheapest trigger.
      await store.revoke('d000')

      expect(store.list()).toHaveLength(200)
      const saved = JSON.parse(await readFile(file, 'utf8')) as { devices: { id: string }[] }
      expect(saved.devices).toHaveLength(200)
      expect(saved.devices.map(device => device.id)).toContain('d249')
      // Newest 200 win: d050 is the last kept record, d049 the first dropped.
      expect(saved.devices.map(device => device.id)).toContain('d050')
      expect(saved.devices.map(device => device.id)).not.toContain('d049')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
