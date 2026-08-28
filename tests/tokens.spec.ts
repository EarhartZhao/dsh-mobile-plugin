import { mkdtemp, rm } from 'node:fs/promises'
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
})
