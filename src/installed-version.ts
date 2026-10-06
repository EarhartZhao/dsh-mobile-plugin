/**
 * The version of this package as it sits on disk, beside the running process.
 *
 * A plugin upgrade is never live: the host keeps the JavaScript generation it
 * booted with, and its plugin manager answers `restart-required` for any
 * package the profile already depends on. Nothing on the way in says so —
 * `pnpm add` in a terminal says nothing at all, and the Plugins page's notice
 * ("更改将在下次启动生效") is a line of small print — so the console compares
 * the manifest on disk with the running `PLUGIN_VERSION` and names the gap.
 *
 * Best-effort by design: a manifest that is missing, unreadable, half-written
 * by an install in flight, or simply not ours reports null, and the console
 * shows nothing rather than crying wolf.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * How far up from the loaded module its manifest may sit. The published layout
 * is `lib/index.js` next to the package root, so one level is the real answer
 * and the rest is headroom for a bundler that adds a directory.
 */
const MAX_DEPTH = 4

interface Manifest {
  name?: unknown
  version?: unknown
}

function readManifest(path: string): Manifest | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Manifest : null
  } catch {
    return null
  }
}

/**
 * Walk up from the loaded module to the nearest manifest and report its
 * version when that manifest is this package.
 * @param loadedFrom Absolute path of the module the host loaded (`import.meta.url`).
 * @param packageName The package's own name; a nearer manifest for anything else ends the walk.
 * @returns The on-disk version, or null when it cannot be established.
 */
export function readInstalledVersion(loadedFrom: string, packageName: string): string | null {
  let dir = dirname(resolve(loadedFrom))
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const manifest = readManifest(join(dir, 'package.json'))
    if (manifest !== null) {
      if (manifest.name !== packageName) return null
      const version = typeof manifest.version === 'string' ? manifest.version.trim() : ''
      return version === '' ? null : version
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}
