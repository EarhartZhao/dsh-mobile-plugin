import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isMap, isSeq, parseDocument } from 'yaml'
import {
  migrateProfile,
  needsRepair,
  readProfileShape,
  type ProfileIdentifiers,
  type ProfileLocation,
} from '../src/profile-migration.js'

const ids: ProfileIdentifiers = {
  packageName: 'dsh-mobile-plugin',
  rowId: 'mobile-bridge',
  rowName: 'dsh-mobile-plugin',
}

/** The shape a hand-written profile ends up with: the row lives in the patch. */
const legacyPatch = `# Your patch layer for this dsh profile.
- insert:
    - id: mobile-bridge
      name: 'dsh-mobile-plugin'
      config:
        natsUrl: 'nats://127.0.0.1:4222'
        hubUser: 'c-end-dsh'
        hubPass: 'secret'
        instanceId: 'home-mac'
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1
- id: mobile-bridge
  disabled: false
`

/** The shape the host's own Plugins page writes. */
const migratedPatch = `- id: mobile-bridge
  name: 'dsh-mobile-plugin'
  config:
    natsUrl: 'nats://127.0.0.1:4222'
  disabled: false
`

async function fixture(patch: string, bundles: readonly string[] = ['@deepseek-ai/dsh-base']): Promise<{
  location: ProfileLocation
  manifest: () => Promise<Record<string, unknown>>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mobile-profile-'))
  const patchPath = join(dir, 'cordis.patch.yml')
  await writeFile(patchPath, patch)
  await writeFile(join(dir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'dsh-mobile-plugin': 'github:EarhartZhao/dsh-mobile-plugin' },
    dsh: { profile: { bundles: [...bundles], patchReload: 'live' } },
  }, undefined, 2)}\n`)
  return {
    location: { dir, patchPath },
    manifest: async () => JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>,
  }
}

function bundles(listed: Record<string, unknown>): string[] {
  const dsh = listed.dsh as { profile?: { bundles?: string[] } } | undefined
  return dsh?.profile?.bundles ?? []
}

describe('readProfileShape', () => {
  it('names the legacy insert and the missing bundle list entry', async () => {
    const { location } = await fixture(legacyPatch)
    const shape = await readProfileShape(location, ids)
    expect(shape).toEqual({ bundleListed: false, legacyInsert: true, overrideRow: true })
    expect(needsRepair(shape)).toBe(true)
  })

  it('accepts the shape the host writes, with nothing left to repair', async () => {
    const { location } = await fixture(migratedPatch, ['@deepseek-ai/dsh-base', 'dsh-mobile-plugin'])
    const shape = await readProfileShape(location, ids)
    expect(shape).toEqual({ bundleListed: true, legacyInsert: false, overrideRow: true })
    expect(needsRepair(shape)).toBe(false)
  })

  it('treats a missing patch file as an empty one', async () => {
    const { location } = await fixture('[]\n')
    const shape = await readProfileShape({ ...location, patchPath: join(location.dir, 'absent.yml') }, ids)
    expect(shape).toEqual({ bundleListed: false, legacyInsert: false, overrideRow: false })
  })
})

describe('migrateProfile', () => {
  it('registers the bundle first and leaves the row alone until the next start', async () => {
    const { location, manifest } = await fixture(legacyPatch)
    const before = await readFile(location.patchPath, 'utf8')
    const result = await migrateProfile(location, ids, { removeInsert: false })

    // The insert row still mounts the plugin in this process: taking it away
    // before the bundle layer is composed would unmount the running one.
    expect(result.changed).toEqual([join(location.dir, 'package.json')])
    expect(await readFile(location.patchPath, 'utf8')).toBe(before)
    expect(bundles(await manifest())).toEqual(['@deepseek-ai/dsh-base', 'dsh-mobile-plugin'])
    expect(result.pendingRestart).toBe(true)
    expect(result.shape).toEqual({ bundleListed: true, legacyInsert: true, overrideRow: true })
    expect(result.notes.join('\n')).toContain('重启 dsh')
  })

  it('lifts the row into an override once the bundle is live, keeping its config', async () => {
    const { location, manifest } = await fixture(legacyPatch, ['@deepseek-ai/dsh-base', 'dsh-mobile-plugin'])
    const result = await migrateProfile(location, ids, { removeInsert: true })
    const text = await readFile(location.patchPath, 'utf8')

    expect(result.changed).toEqual([location.patchPath])
    expect(result.shape).toEqual({ bundleListed: true, legacyInsert: false, overrideRow: true })
    expect(result.pendingRestart).toBe(false)
    // The file's own comment stays on the row that replaced the insert.
    expect(text.indexOf('# Your patch layer')).toBeLessThan(text.indexOf('- id: mobile-bridge'))
    expect(text).not.toContain('insert:')
    expect(text).toContain("hubPass: 'secret'")
    expect(bundles(await manifest())).toEqual(['@deepseek-ai/dsh-base', 'dsh-mobile-plugin'])

    // One row per id: the host files its later edits into the last match, so a
    // duplicate left behind would make the file lie about where config lives.
    const document = parseDocument(text)
    const rows = (document.contents as { items: unknown[] }).items
      .filter(item => isMap(item) && item.get('id') === 'mobile-bridge')
    expect(rows).toHaveLength(1)
    expect(text).toContain('disabled: false')
    expect(text).toContain('welcomeNoticeVersion')
  })

  it('is idempotent: a second pass rewrites nothing', async () => {
    const { location } = await fixture(legacyPatch, ['dsh-mobile-plugin'])
    await migrateProfile(location, ids, { removeInsert: true })
    const settled = await readFile(location.patchPath, 'utf8')
    const second = await migrateProfile(location, ids, { removeInsert: true })

    expect(second.changed).toEqual([])
    expect(second.shape).toEqual({ bundleListed: true, legacyInsert: false, overrideRow: true })
    expect(second.notes.join('\n')).toContain('安装形态正常')
    expect(await readFile(location.patchPath, 'utf8')).toBe(settled)
  })

  it('keeps the other rows an insert list is carrying, and adds them to the override', async () => {
    const patch = `- insert:
    - id: telemetry
      name: '@deepseek-ai/dsh-telemetry'
    - id: mobile-bridge
      name: dsh-mobile-plugin
      config:
        instanceId: 'home-mac'
`
    const { location } = await fixture(patch, ['dsh-mobile-plugin'])
    await migrateProfile(location, ids, { removeInsert: true })
    const text = await readFile(location.patchPath, 'utf8')

    expect(text).toContain('id: telemetry')
    expect(text).toContain('insert:')
    expect(text).toContain('instanceId: home-mac')
    const document = parseDocument(text)
    expect(isSeq(document.contents)).toBe(true)
  })

  it('leaves a group insert alone instead of hoisting a group child to the top level', async () => {
    const patch = `- id: some-group
  insert:
    - id: mobile-bridge
      name: dsh-mobile-plugin
`
    const { location } = await fixture(patch, ['dsh-mobile-plugin'])
    const result = await migrateProfile(location, ids, { removeInsert: true })

    expect(await readFile(location.patchPath, 'utf8')).toBe(patch)
    expect(result.shape.legacyInsert).toBe(true)
    expect(result.notes.join('\n')).toContain('分组')
  })
})
