/**
 * Repair the profile's install shape so the host's own bundle and row controls
 * can manage this plugin.
 *
 * A profile can mount this plugin's row in two ways, and only one of them is
 * the shape the Plugins page manages:
 *
 * - **bundle shape** (what the host writes): the package is listed in the
 *   profile manifest's `dsh.profile.bundles`, so the package's own
 *   `cordis.patch.yml` supplies the row, and the profile patch carries one
 *   id-targeted override with this deployment's values.
 * - **legacy insert** (what a hand-written profile ends up with): the profile
 *   patch declares the row itself, inside a bare `- insert:` list. The row then
 *   exists whether or not the bundle is enabled, so the host refuses to manage
 *   it: no row toggle is rendered while the bundle is off, and removing the
 *   bundle fails with `bundle-in-use`, because the row the removal just
 *   disabled is still mounted from the profile layer.
 *
 * The repair keeps every configured value: the insert row's `config` moves to
 * the override verbatim. It runs in two passes, because the bundle layer is
 * only composed when dsh starts:
 *
 * 1. Register the package in `dsh.profile.bundles`. Nothing about the running
 *    composition changes — a `bundles` edit is read at launch.
 * 2. On the next start the bundle layer is live, so lifting the row out of the
 *    profile patch cannot take the row away: the bundle keeps declaring it,
 *    with the same effective config. Pass 2 only runs once the launcher
 *    reports the bundle as started; see `migrateProfile`.
 */
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isMap, isSeq, parseDocument, type Document, type YAMLMap, type YAMLSeq } from 'yaml'

/** Profile files the repair reads and rewrites (the host's `profileContext`). */
export interface ProfileLocation {
  /** Profile directory holding `package.json` and the patch file. */
  readonly dir: string
  /** The profile's own patch layer. */
  readonly patchPath: string
}

/** Names the repair matches inside the profile. */
export interface ProfileIdentifiers {
  /** Dependency and bundle name in the profile manifest. */
  readonly packageName: string
  /** Composition entry id this plugin's row uses. */
  readonly rowId: string
  /** Module the row loads; also the `name:` qualifier on its overrides. */
  readonly rowName: string
}

/** How the profile currently mounts this plugin's row. */
export interface ProfileShape {
  /** `dsh.profile.bundles` lists the package, so the bundle layer declares the row. */
  readonly bundleListed: boolean
  /** The profile patch still declares the row inside a bare `insert` list. */
  readonly legacyInsert: boolean
  /** A bare (non-insert) override row for this id exists in the profile patch. */
  readonly overrideRow: boolean
}

/** Outcome of one repair pass. */
export interface MigrationResult {
  /** Files rewritten, in write order. */
  readonly changed: readonly string[]
  /** Shape of the profile after the pass. */
  readonly shape: ProfileShape
  /** The bundle list was updated but the insert row stays until the next start. */
  readonly pendingRestart: boolean
  /** Operator-facing lines for the console page and the log. */
  readonly notes: readonly string[]
}

/** A patch row that declares this plugin's composition entry. */
interface InsertMatch {
  /** Index of the patch item inside the top-level sequence. */
  readonly itemIndex: number
  /** The patch item itself (`- insert: [...]`, optionally with an `id`). */
  readonly item: YAMLMap
  /** The `insert:` list inside that item. */
  readonly insert: YAMLSeq
  /** Index of this plugin's row inside the insert list. */
  readonly rowIndex: number
}

/** Non-`insert` patch rows are applied to an entry that must already exist. */
function isBareRow(node: unknown, ids: ProfileIdentifiers): node is YAMLMap {
  if (!isMap(node) || node.has('insert')) return false
  if (node.get('id') !== ids.rowId) return false
  const name = node.get('name')
  return name === undefined || name === ids.rowName
}

function parsePatch(text: string, source: string): Document {
  const document = parseDocument(text, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  })
  const error = document.errors[0]
  if (error !== undefined) throw new Error(`${source}: ${error.message}`)
  if (!isSeq(document.contents)) throw new Error(`${source}: profile patch must be a YAML sequence`)
  return document
}

/** Every bare insert list that declares this plugin's row, in file order. */
function findInserts(document: Document, ids: ProfileIdentifiers): InsertMatch[] {
  const matches: InsertMatch[] = []
  const contents = document.contents as YAMLSeq
  contents.items.forEach((item, itemIndex) => {
    if (!isMap(item)) return
    const insert = item.get('insert')
    if (!isSeq(insert)) return
    insert.items.forEach((row, rowIndex) => {
      if (!isMap(row)) return
      if (row.get('id') !== ids.rowId) return
      const name = row.get('name')
      if (name !== undefined && name !== ids.rowName) return
      matches.push({ itemIndex, item, insert, rowIndex })
    })
  })
  return matches
}

/** Attach a replaced node's block comment to the row that takes its place. */
function inheritComment(from: YAMLMap, to: YAMLMap): void {
  if (typeof from.commentBefore !== 'string' || from.commentBefore === '') return
  to.commentBefore = typeof to.commentBefore === 'string' && to.commentBefore !== ''
    ? `${from.commentBefore}\n${to.commentBefore}`
    : from.commentBefore
}

/**
 * Lift this plugin's row out of every bare `insert` list and into a plain
 * override row, which is the only shape the host can address by id.
 *
 * An insert list holding nothing but this row is converted in place, so the
 * row keeps its position and the block comment above it. A list with other
 * rows keeps them and gives up only this one. Inserts that target a group
 * (`insert` next to an `id`) are left alone: hoisting a group's child to the
 * top level would change the composition, and no documented install writes it.
 * @param document - parsed profile patch, mutated in place.
 * @param ids - names identifying this plugin's row.
 * @returns whether the document changed, and what was skipped.
 */
function hoistInsertRows(document: Document, ids: ProfileIdentifiers): { changed: boolean, notes: string[] } {
  const notes: string[] = []
  let changed = false
  const contents = document.contents as YAMLSeq
  // Back to front: a list with more than one copy of this row shrinks as it is
  // processed, which would move the row indexes still queued behind it.
  const matches = findInserts(document, ids).reverse()
  for (const match of matches) {
    if (match.item.has('id')) {
      notes.push(`profile patch 里 \`insert\` 挂在分组 "${String(match.item.get('id'))}" 下，`
        + '自动迁移不处理分组内的行，请手工把这一行移到顶层覆盖。')
      continue
    }
    const row = match.insert.items[match.rowIndex]
    if (!isMap(row)) continue
    changed = true
    if (match.insert.items.length === 1) {
      inheritComment(match.item, row)
      contents.items[match.itemIndex] = row
    } else {
      match.insert.items.splice(match.rowIndex, 1)
      contents.items.push(document.createNode(row.toJSON() as Record<string, unknown>))
    }
  }
  return { changed, notes }
}

/**
 * Fold every bare override for this id into one row. Two rows with the same id
 * are legal YAML and legal patches, but the host writes its later edits into
 * the last match, so leaving a duplicate behind makes the file lie about where
 * the configuration lives.
 * @param document - parsed profile patch, mutated in place.
 * @param ids - names identifying this plugin's row.
 * @returns whether the document changed.
 */
function mergeOverrideRows(document: Document, ids: ProfileIdentifiers): boolean {
  const contents = document.contents as YAMLSeq
  const indexes = contents.items
    .map((item, index) => (isBareRow(item, ids) ? index : -1))
    .filter(index => index >= 0)
  if (indexes.length < 2) return false
  const [targetIndex, ...duplicateIndexes] = indexes
  const target = contents.items[targetIndex] as YAMLMap
  for (const index of duplicateIndexes) {
    const duplicate = contents.items[index] as YAMLMap
    for (const pair of duplicate.items) {
      const key = String(pair.key)
      if (!target.has(key)) target.set(key, pair.value)
    }
  }
  for (const index of duplicateIndexes.reverse()) {
    contents.items.splice(index, 1)
  }
  return true
}

function configOf(document: Document, ids: ProfileIdentifiers): Record<string, unknown> | undefined {
  const contents = document.contents as YAMLSeq
  for (let index = contents.items.length - 1; index >= 0; index--) {
    const item = contents.items[index]
    if (!isMap(item)) continue
    const insert = item.get('insert')
    if (isSeq(insert)) {
      for (let row = insert.items.length - 1; row >= 0; row--) {
        const candidate = insert.items[row]
        if (!isMap(candidate) || candidate.get('id') !== ids.rowId) continue
        const config = candidate.get('config')
        if (config !== undefined && config !== null) return config as Record<string, unknown>
      }
      continue
    }
    if (!isBareRow(item, ids)) continue
    const config = item.get('config')
    if (config !== undefined && config !== null) return config as Record<string, unknown>
  }
  return undefined
}

async function readPatch(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return '[]\n'
  }
}

interface ProfileManifest {
  dependencies?: Record<string, unknown>
  dsh?: { profile?: { bundles?: string[] } }
}

function bundlesOf(manifest: ProfileManifest): string[] {
  const bundles = manifest.dsh?.profile?.bundles
  return Array.isArray(bundles) ? bundles : []
}

async function readManifest(dir: string): Promise<ProfileManifest> {
  try {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as ProfileManifest
  } catch (error) {
    throw new Error(`${join(dir, 'package.json')}: ${String(error)}`)
  }
}

/** Replace a file in one step: a reader either sees the old or the new bytes. */
async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, content, { mode: 0o600 })
  await rename(temporary, path)
}

/** Read how the profile mounts this plugin's row right now. */
export async function readProfileShape(
  location: ProfileLocation,
  ids: ProfileIdentifiers,
): Promise<ProfileShape> {
  const document = parsePatch(await readPatch(location.patchPath), location.patchPath)
  const manifest = await readManifest(location.dir)
  return {
    bundleListed: bundlesOf(manifest).includes(ids.packageName),
    legacyInsert: findInserts(document, ids).length > 0,
    overrideRow: (document.contents as YAMLSeq).items.some(item => isBareRow(item, ids)),
  }
}

/** Whether this shape needs the repair at all. */
export function needsRepair(shape: ProfileShape): boolean {
  return shape.legacyInsert || !shape.bundleListed
}

/**
 * One repair pass. Files are written only when their content would change, the
 * manifest before the patch (a bundle entry with the insert still present is
 * harmless — both layers declare the same id and the Loader keeps one entry —
 * while removing the insert first would take the row out of the composition).
 * @param location - profile directory and patch file.
 * @param ids - names identifying this plugin's package and row.
 * @param options - `removeInsert` lifts the row into an override row. The
 *   caller passes true only when the bundle layer is live in this process;
 *   otherwise the row would vanish from the running composition.
 * @returns what changed, how the profile looks now, and operator-facing notes.
 */
export async function migrateProfile(
  location: ProfileLocation,
  ids: ProfileIdentifiers,
  options: { removeInsert: boolean },
): Promise<MigrationResult> {
  const notes: string[] = []
  const changed: string[] = []
  const manifestText = await readFile(join(location.dir, 'package.json'), 'utf8')
  const manifest = JSON.parse(manifestText) as ProfileManifest
  const patchText = await readPatch(location.patchPath)
  const document = parsePatch(patchText, location.patchPath)

  const hadInsert = findInserts(document, ids).length > 0
  let nextPatch = patchText
  if (options.removeInsert) {
    const hoisted = hoistInsertRows(document, ids)
    notes.push(...hoisted.notes)
    if (hoisted.changed) {
      mergeOverrideRows(document, ids)
      nextPatch = String(document)
    }
  } else if (hadInsert) {
    notes.push('profile patch 里的 `insert` 行还在：组合包要先在 dsh 启动时生效，本次先登记组合包，重启后自动完成迁移。')
  }
  const stillInserting = findInserts(document, ids).length > 0

  const listed = bundlesOf(manifest).includes(ids.packageName)
  if (!listed) {
    const bundles = [...bundlesOf(manifest), ids.packageName]
    const next: ProfileManifest = {
      ...manifest,
      dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } },
    }
    await writeFileAtomic(join(location.dir, 'package.json'), `${JSON.stringify(next, undefined, 2)}\n`)
    changed.push(join(location.dir, 'package.json'))
    notes.push(`已把 ${ids.packageName} 加进 profile 的 dsh.profile.bundles`
      + `${stillInserting ? '（重启 dsh 后这一行改由组合包提供）' : ''}。`)
  }

  if (nextPatch !== patchText) {
    await writeFileAtomic(location.patchPath, nextPatch)
    changed.push(location.patchPath)
    const config = configOf(parsePatch(nextPatch, location.patchPath), ids)
    notes.push(config === undefined
      ? '已把 profile patch 里的 `insert` 行改成按 id 的覆盖行（这一行没有配置）。'
      : '已把 profile patch 里的 `insert` 行改成按 id 的覆盖行，配置原样保留；行现在由组合包提供，宿主的启用/停用与卸载可以正常管理它。')
  }

  const shape = await readProfileShape(location, ids)
  const pendingRestart = shape.bundleListed && shape.legacyInsert
  if (notes.length === 0) notes.push('安装形态正常：行由组合包提供，profile patch 只保留按 id 的配置覆盖。')
  return { changed, shape, pendingRestart, notes }
}
