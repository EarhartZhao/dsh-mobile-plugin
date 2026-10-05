import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  LEGACY_NAME,
  SCOPED_NAME,
  migrateProfile,
  rewriteBundles,
  rewritePatchText,
} from '../scripts/migrate-to-scoped.mjs'

const run = promisify(execFile)
const script = fileURLToPath(new URL('../scripts/migrate-to-scoped.mjs', import.meta.url))

/** A profile as the bare-name install left it: dependency, bundle list, patch. */
const legacyProfile = {
  manifest: {
    name: 'dsh-profile-web',
    private: true,
    dependencies: { [LEGACY_NAME]: 'github:EarhartZhao/dsh-mobile-plugin' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', LEGACY_NAME, '@deepseek-ai/dsh-web-app'] } },
  },
  patch: `# Your patch layer for this dsh profile.
- id: ui-settings-general
  name: '@deepseek-ai/dsh-client-ui-settings-general'
  config:
    welcomeNoticeVersion: 2026-09-28.1
- insert:
    - id: mobile-bridge
      name: '${LEGACY_NAME}'
      config:
        natsUrl: 'nats://127.0.0.1:4222'
- id: mobile-bridge
  name: ${LEGACY_NAME}   # the deployment's own override
  config:
    hubWssUrl: 'wss://hub.test:8443'
    hubPass: 'secret'
`,
}

/** One profile directory holding both files. */
async function fixture(): Promise<{ dir: string; manifest: () => Promise<any>; patch: () => Promise<string> }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-migrate-scoped-'))
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(legacyProfile.manifest, undefined, 2)}\n`)
  await writeFile(join(dir, 'cordis.patch.yml'), legacyProfile.patch)
  return {
    dir,
    manifest: async () => JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')),
    patch: async () => readFile(join(dir, 'cordis.patch.yml'), 'utf8'),
  }
}

describe('rewriteBundles', () => {
  it('swaps the bare name in place, because the list order is precedence', () => {
    const manifest = { dsh: { profile: { bundles: ['a', LEGACY_NAME, 'b'] } } }
    expect(rewriteBundles(manifest)).toBe(true)
    expect(manifest.dsh.profile.bundles).toEqual(['a', SCOPED_NAME, 'b'])
  })

  it('leaves an already-scoped list and an unrelated one alone', () => {
    const scoped = { dsh: { profile: { bundles: ['a', SCOPED_NAME] } } }
    const other = { dsh: { profile: { bundles: ['a', 'b'] } } }
    expect(rewriteBundles(scoped)).toBe(false)
    expect(rewriteBundles(other)).toBe(false)
    expect(rewriteBundles({})).toBe(false)
    expect(other.dsh.profile.bundles).toEqual(['a', 'b'])
  })
})

describe('rewritePatchText', () => {
  it('rewrites every id-keyed row, top level and inside insert, keeping comments', () => {
    const { text, changed } = rewritePatchText(legacyProfile.patch)
    expect(changed).toBe(2)
    expect(text).not.toContain(`name: '${LEGACY_NAME}'`)
    expect(text).not.toContain(`name: ${LEGACY_NAME}   #`)
    expect(text).toContain(`name: '${SCOPED_NAME}'`)
    // The plain row is re-emitted quoted: a leading `@` is a YAML indicator.
    expect(text).toMatch(new RegExp(`name: ['"]${SCOPED_NAME}['"] +# the deployment's own override`))
    expect(text).toContain('# Your patch layer for this dsh profile.')
    expect(text).toContain("hubPass: 'secret'")
    // Untouched neighbours stay byte for byte.
    expect(text.split('\n').filter(line => line.includes('welcomeNoticeVersion'))).toEqual(['    welcomeNoticeVersion: 2026-09-28.1'])
  })

  it('reports no change for a document that names neither id nor legacy name', () => {
    const text = `- id: mobile-bridge\n  name: '@other/plugin'\n`
    const { text: same, changed } = rewritePatchText(text)
    expect(changed).toBe(0)
    expect(same).toBe(text)
  })

  it('leaves a grouped row alone: the group carries the id, not the plugin', () => {
    const text = `- id: some-group\n  insert:\n    - id: mobile-bridge\n      name: '${LEGACY_NAME}'\n`
    const { text: rewritten, changed } = rewritePatchText(text)
    expect(changed).toBe(1)
    expect(rewritten).toContain(`name: '${SCOPED_NAME}'`)
  })
})

describe('migrateProfile', () => {
  it('rewrites the bundle list, the rows and nothing else, and backs the patch up', async () => {
    const { dir, manifest, patch } = await fixture()
    const steps = await migrateProfile(dir, { install: false })

    expect(steps).toEqual({ installed: false, bundles: true, rows: 2, removed: false, backup: join(dir, 'cordis.patch.yml.bak') })
    const after = await manifest()
    expect(after.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', SCOPED_NAME, '@deepseek-ai/dsh-web-app'])
    // Editing files only: no install ran, so the old dependency is still there.
    expect(after.dependencies).toEqual({ [LEGACY_NAME]: 'github:EarhartZhao/dsh-mobile-plugin' })
    expect(await readFile(join(dir, 'cordis.patch.yml.bak'), 'utf8')).toBe(legacyProfile.patch)
    expect(await patch()).toContain(`name: '${SCOPED_NAME}'`)
  })

  it('is idempotent: a second pass finds nothing to rewrite', async () => {
    const { dir } = await fixture()
    await migrateProfile(dir, { install: false })
    const settled = await readFile(join(dir, 'cordis.patch.yml'), 'utf8')
    const second = await migrateProfile(dir, { install: false })

    expect(second).toEqual({ installed: false, bundles: false, rows: 0, removed: false, backup: null })
    expect(await readFile(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(settled)
  })

  it('leaves a profile that never selected the bundle alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-migrate-scoped-'))
    const manifest = { name: 'dsh-profile-web', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }
    await writeFile(join(dir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
    await writeFile(join(dir, 'cordis.patch.yml'), '# nothing about this plugin\n')

    // The patch has no matching row, so even `install: false` changes nothing.
    expect(await migrateProfile(dir, { install: false })).toEqual({ installed: false, bundles: false, rows: 0, removed: false, backup: null })
  })
})

describe('command line', () => {
  it('runs the migration for a directory and prints what it did', async () => {
    const { dir, manifest, patch } = await fixture()
    const { stdout } = await run(process.execPath, [script, dir, '--no-install'])

    expect(stdout).toContain('dsh.profile.bundles 改写：已改')
    expect(stdout).toContain('cordis.patch.yml 行名改写：2 处')
    expect((await manifest()).dsh.profile.bundles).toContain(SCOPED_NAME)
    expect(await patch()).toContain(SCOPED_NAME)
  })

  it('explains itself instead of guessing when no directory is given', async () => {
    const failure = await run(process.execPath, [script]).then(() => null, (error: { code?: number; stderr?: string }) => error)
    expect(failure?.code).toBe(2)
    expect(failure?.stderr).toContain('用法')
  })
})
