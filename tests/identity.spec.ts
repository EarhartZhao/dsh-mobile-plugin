import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GatewayIdentityStore } from '../src/identity.js'

const dirs: string[] = []

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mobile-identity-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('GatewayIdentityStore', () => {
  it('creates one stable id and reuses it across instances', async () => {
    const file = join(await scratch(), 'identity.json')
    const first = await new GatewayIdentityStore(file).load()
    const second = await new GatewayIdentityStore(file).load()

    expect(first.gatewayId).toMatch(/^[0-9a-f-]{36}$/)
    expect(second).toEqual(first)
  })

  it('shares one load across concurrent callers', async () => {
    const file = join(await scratch(), 'identity.json')
    const store = new GatewayIdentityStore(file)
    const loaded = await Promise.all([store.load(), store.load(), store.load()])
    expect(new Set(loaded.map(item => item.gatewayId)).size).toBe(1)
  })

  it('reports a damaged file instead of silently replacing the gateway', async () => {
    const file = join(await scratch(), 'identity.json')
    await writeFile(file, '{not-json', 'utf8')

    await expect(new GatewayIdentityStore(file).load()).rejects.toThrow(/有效 JSON/)
    expect(await readFile(file, 'utf8')).toBe('{not-json')
  })
})
