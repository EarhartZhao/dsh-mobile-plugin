/**
 * Move one profile from the bare package name to the scoped npm package.
 *
 * The package was renamed to `@dsh-earhartzhao/dsh-mobile-plugin` when it went
 * to npm. A profile that installed the bare name cannot simply reinstall: the
 * loader resolves a patch row by its module name, and the profile's own
 * override row asserts the old one — `name: 'dsh-mobile-plugin'` — so the row
 * would no longer match and every deployment value under it (Hub address,
 * account, password, CA) would be silently ignored. The plugin cannot repair
 * that itself: a run where the override does not match is a run the plugin
 * never sees.
 *
 * So the switch is a script, run with dsh stopped:
 *
 *   1. install the scoped package (pnpm add, in the profile)
 *   2. rewrite `dsh.profile.bundles`: bare name → scoped name, same position,
 *      because the list's order is configuration precedence
 *   3. rewrite the module name in every `id: mobile-bridge` row of the
 *      profile's `cordis.patch.yml`, comments and all
 *   4. remove the now-unused bare dependency
 *
 * Usage: node scripts/migrate-to-scoped.mjs <profile dir> [--spec <spec>] [--no-install]
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { isMap, isScalar, parseDocument } from 'yaml'

const run = promisify(execFile)

/** Name every install before this one used. */
export const LEGACY_NAME = 'dsh-mobile-plugin'
/** Name this version installs as. */
export const SCOPED_NAME = '@dsh-earhartzhao/dsh-mobile-plugin'
/** Row id both names declare; the profile's override is keyed by it. */
export const ROW_ID = 'mobile-bridge'

/**
 * Replace the legacy name in `dsh.profile.bundles`, keeping its position.
 *
 * Order is precedence, so the scoped name takes the slot the bare name held
 * rather than being appended. A list that already names the scoped package is
 * left alone, and one that names neither is not silently edited: a profile that
 * never selected the bundle is not this script's business.
 * @param manifest Parsed profile package.json.
 * @returns Whether the list changed.
 */
export function rewriteBundles(manifest) {
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return false
  const at = bundles.indexOf(LEGACY_NAME)
  if (at === -1) return false
  bundles[at] = SCOPED_NAME
  return true
}

/**
 * Rewrite the module name in every `id: mobile-bridge` row of a patch document.
 *
 * Rows sit either at the top level (an id-targeted override) or inside an
 * `insert:` list (both this package's own bundle patch and hand-written legacy
 * profiles), so the whole document is walked rather than one known shape.
 * Comments survive: the document is edited, never re-serialized from scratch.
 * @param text Raw `cordis.patch.yml` contents.
 * @returns Rewritten text, and how many rows changed.
 */
export function rewritePatchText(text) {
  const document = parseDocument(text)
  if (document.errors.length > 0) throw document.errors[0]
  let changed = 0
  // `YAMLMap.get` resolves to a plain value; the *node* has to be reached
  // through its pair, because the edit is a node edit — that is what keeps the
  // file's comments, quoting and key order instead of re-emitting from JSON.
  const valueNode = (map, key) => map.items.find(pair => isScalar(pair.key) && pair.key.value === key)?.value
  const visit = node => {
    if (isMap(node)) {
      const id = valueNode(node, 'id')
      const name = valueNode(node, 'name')
      if (isScalar(id) && id.value === ROW_ID && isScalar(name) && name.value === LEGACY_NAME) {
        name.value = SCOPED_NAME
        changed += 1
      }
      for (const pair of node.items) visit(pair.value)
      return
    }
    if (Array.isArray(node?.items)) for (const item of node.items) visit(item)
  }
  visit(document.contents)
  return { text: changed === 0 ? text : String(document), changed }
}

/** Whether the manifest still carries the bare dependency at all. */
function hasLegacyDependency(manifest) {
  return typeof manifest?.dependencies?.[LEGACY_NAME] === 'string'
}

/**
 * Migrate one profile directory.
 * @param dir Profile directory holding `package.json` and `cordis.patch.yml`.
 * @param options `spec` to install (default the scoped package name), and
 *   `install: false` to edit files only (tests, or a hand-managed install).
 * @returns What each step did, for the caller to report.
 */
export async function migrateProfile(dir, options = {}) {
  const spec = options.spec ?? SCOPED_NAME
  const install = options.install !== false
  const manifestPath = join(dir, 'package.json')
  const patchPath = join(dir, 'cordis.patch.yml')
  const before = JSON.parse(await readFile(manifestPath, 'utf8'))
  const patch = await readFile(patchPath, 'utf8').catch(() => null)
  const steps = { installed: false, bundles: false, rows: 0, removed: false, backup: null }

  if (install && !isInstalled(before, spec)) {
    await run('pnpm', ['add', spec], { cwd: dir })
    steps.installed = true
  }

  // `pnpm add` rewrites this file, so the copy being edited has to be the one
  // on disk now — writing the pre-install copy back would drop the dependency
  // the install just added.
  const manifest = steps.installed ? JSON.parse(await readFile(manifestPath, 'utf8')) : before
  const touched = rewriteBundles(manifest)
  if (touched) {
    steps.bundles = true
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }

  if (patch !== null) {
    const rewritten = rewritePatchText(patch)
    steps.rows = rewritten.changed
    if (rewritten.text !== patch) {
      // The file holds the deployment's only copy of the Hub password, so the
      // edit leaves the previous bytes next to it instead of replacing them.
      steps.backup = `${patchPath}.bak`
      await writeFile(steps.backup, patch)
      await writeFile(patchPath, rewritten.text)
    }
  }

  if (install && hasLegacyDependency(manifest)) {
    await run('pnpm', ['remove', LEGACY_NAME], { cwd: dir })
    steps.removed = true
  }

  return steps
}

/**
 * Whether the profile already depends on this spec. A spec may carry a version
 * or a git address, so the name in front of it is what is compared.
 */
function isInstalled(manifest, spec) {
  const name = spec.startsWith('@')
    ? spec.split('/').slice(0, 2).join('/')
    : spec.split('@')[0]
  return typeof manifest?.dependencies?.[name] === 'string'
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const args = process.argv.slice(2)
  const dir = args.find(arg => !arg.startsWith('--'))
  const specAt = args.indexOf('--spec')
  const spec = specAt === -1 ? undefined : args[specAt + 1]
  const install = !args.includes('--no-install')
  if (dir === undefined) {
    console.error('用法: node scripts/migrate-to-scoped.mjs <profile 目录> [--spec <安装源>] [--no-install]')
    process.exit(2)
  }
  const steps = await migrateProfile(dir, { spec, install })
  console.log(`已迁移 ${dir}：`)
  console.log(`  安装 scoped 包：${steps.installed ? '已装' : '已在依赖里，跳过'}`)
  console.log(`  dsh.profile.bundles 改写：${steps.bundles ? '已改' : '无需改'}`)
  console.log(`  cordis.patch.yml 行名改写：${steps.rows} 处`)
  console.log(`  移除旧依赖：${steps.removed ? '已移除' : '无需移除'}`)
  if (steps.backup !== null) console.log(`  旧文件备份：${steps.backup}`)
  console.log('现在重启 dsh（重启前它会一直跑着旧代码）。')
}
