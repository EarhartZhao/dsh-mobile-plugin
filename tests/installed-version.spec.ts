import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readInstalledVersion } from '../src/installed-version.js'

const NAME = '@dsh-earhartzhao/dsh-mobile-plugin'

/** A package directory holding one manifest and a module at the given depth. */
async function packageDir(options: { manifest?: string | null, modulePath: string }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-installed-version-'))
  await mkdir(join(root, options.modulePath.slice(0, options.modulePath.lastIndexOf('/'))), { recursive: true })
  await writeFile(join(root, options.modulePath), '// module\n')
  if (options.manifest !== null) {
    await writeFile(join(root, 'package.json'), options.manifest ?? JSON.stringify({ name: NAME, version: '0.2.31' }))
  }
  return root
}

describe('readInstalledVersion', () => {
  it('reads the manifest one level above the published lib/ module', async () => {
    const root = await packageDir({ modulePath: 'lib/index.js' })
    expect(readInstalledVersion(join(root, 'lib/index.js'), NAME)).toBe('0.2.31')
  })

  it('walks up through nested build output', async () => {
    const root = await packageDir({ modulePath: 'dist/esm/lib/index.js' })
    expect(readInstalledVersion(join(root, 'dist/esm/lib/index.js'), NAME)).toBe('0.2.31')
  })

  it('reports nothing when the nearest manifest belongs to another package', async () => {
    // Vendored under someone else's tree: their version is not ours to report.
    const root = await packageDir({ modulePath: 'lib/index.js', manifest: JSON.stringify({ name: 'other-pkg', version: '9.9.9' }) })
    expect(readInstalledVersion(join(root, 'lib/index.js'), NAME)).toBeNull()
  })

  it('reports nothing when there is no manifest to read', async () => {
    const root = await packageDir({ modulePath: 'lib/index.js', manifest: null })
    expect(readInstalledVersion(join(root, 'lib/index.js'), NAME)).toBeNull()
  })

  it('reports nothing for a manifest caught mid-write', async () => {
    // An install in flight truncates then rewrites the file; the console must
    // not invent a version out of the wreckage.
    const root = await packageDir({ modulePath: 'lib/index.js', manifest: '{"name": "@dsh-earhartzhao/dsh-mobile-pl' })
    expect(readInstalledVersion(join(root, 'lib/index.js'), NAME)).toBeNull()
  })

  it('reports nothing for a manifest without a usable version', async () => {
    const root = await packageDir({ modulePath: 'lib/index.js', manifest: JSON.stringify({ name: NAME, version: '  ' }) })
    expect(readInstalledVersion(join(root, 'lib/index.js'), NAME)).toBeNull()
  })

  it('stops walking rather than reporting a manifest from far above', async () => {
    // A module dropped into a deep tree must not silently inherit the version
    // of whatever package happens to sit at the top.
    const root = await packageDir({ modulePath: 'a/b/c/d/e/index.js' })
    expect(readInstalledVersion(join(root, 'a/b/c/d/e/index.js'), NAME)).toBeNull()
  })
})
