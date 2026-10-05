/**
 * Self-update: where this install can come from, and which tag is newer.
 *
 * The console can only *ask* for an update. Installing is the host's job — the
 * same pnpm path the Plugins page uses (`pluginManager.installBundle`) — so
 * this module holds just the two things that have to be right before that
 * call: which repository the profile's dependency actually names, and whether
 * a tag on it is newer than what is running.
 *
 * Repository identity comes from the installed spec, not from a constant, so a
 * fork (or a pinned tag) updates from its own source. Tags stay the version
 * source even when the install came from a prebuilt release asset: the asset
 * only decides *where bytes come from*, never which version is newest.
 */

/** Where this install came from, as the profile's manifest declares it. */
export interface UpdateSource {
  /** The spec exactly as the profile declares it; what an update re-installs. */
  readonly spec: string
  /** `owner/repo` on GitHub, or null when the spec names no repository. */
  readonly repo: string | null
  /** A local path install (`link:` / `file:` / a plain path): updated from git, not from here. */
  readonly local: boolean
  /**
   * Prebuilt release asset this install came from (`dsh-mobile-plugin-0.2.24.tgz`),
   * or null for a source install. Release assets carry `lib/`, so installing one
   * runs no build script and needs no `allowBuilds` approval — see
   * {@link releaseAssetSpec}.
   */
  readonly asset: string | null
  /**
   * Tag named in that asset's URL, or null when the URL went through
   * `releases/latest` and so names no version of its own.
   */
  readonly tag: string | null
}

const LOCAL_SPEC = /^(?:link:|file:|portal:|\.{1,2}\/|\/|[A-Za-z]:[\\/])/u
const GITHUB_SHORT = /^(?:github|git\+github):([^/\s#]+)\/([^/\s#]+?)(?:\.git)?(?:#.*)?$/u
const GITHUB_URL = /^(?:git\+)?(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?github\.com\/([^/\s#]+)\/([^/\s#]+?)(?:\.git)?(?:#.*)?$/u
const GITHUB_SSH = /^git@github\.com:([^/\s#]+)\/([^/\s#]+?)(?:\.git)?(?:#.*)?$/u
const BARE_REPO = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#.*)?$/u
/** `…/releases/download/<tag>/<asset>`: a release-bound asset URL. */
const GITHUB_ASSET_TAG = /^(?:git\+)?https?:\/\/github\.com\/([^/\s#]+)\/([^/\s#]+?)\/releases\/download\/([^/\s#]+)\/([^/\s#]+)$/u
/** `…/releases/latest/download/<asset>`: the same asset, always the newest release. */
const GITHUB_ASSET_LATEST = /^(?:git\+)?https?:\/\/github\.com\/([^/\s#]+)\/([^/\s#]+?)\/releases\/latest\/download\/([^/\s#]+)$/u

/** Narrows a spec to a repository; null when it names none this code can read. */
function repoOf(spec: string): string | null {
  for (const pattern of [GITHUB_SHORT, GITHUB_URL, GITHUB_SSH, BARE_REPO]) {
    const match = pattern.exec(spec)
    if (match !== null) return `${match[1]}/${match[2]}`
  }
  return null
}

/**
 * Reads a GitHub release-asset spec. Tried before {@link repoOf}, whose
 * patterns reject these URLs outright: the extra `releases/…` segments used to
 * make the console answer "看不出 GitHub 仓库" for a perfectly good install.
 * @param spec Trimmed dependency spec.
 * @returns The source when the spec is a release-asset URL, else null.
 */
function assetSource(spec: string): UpdateSource | null {
  const tagged = GITHUB_ASSET_TAG.exec(spec)
  if (tagged !== null) return { spec, repo: `${tagged[1]}/${tagged[2]}`, local: false, asset: tagged[4], tag: tagged[3] }
  const latest = GITHUB_ASSET_LATEST.exec(spec)
  if (latest !== null) return { spec, repo: `${latest[1]}/${latest[2]}`, local: false, asset: latest[3], tag: null }
  return null
}

/**
 * Reads one profile dependency spec. A package name with no repository
 * (`dsh-mobile-plugin@0.2.23`) has nothing to check against, and a local path
 * belongs to whoever is editing the checkout — both report why instead of
 * offering a button that cannot work.
 */
export function parseUpdateSource(spec: string | undefined | null): UpdateSource | null {
  const trimmed = typeof spec === 'string' ? spec.trim() : ''
  if (trimmed === '') return null
  if (LOCAL_SPEC.test(trimmed)) return { spec: trimmed, repo: null, local: true, asset: null, tag: null }
  return assetSource(trimmed) ?? { spec: trimmed, repo: repoOf(trimmed), local: false, asset: null, tag: null }
}

/** The numbers a tag names, without the leading `v` (`v0.2.24` → `0.2.24`). */
function tagVersion(tag: string): string {
  return tag.startsWith('v') ? tag.slice(1) : tag
}

/**
 * The spec an update should install for `tag`.
 *
 * A release-asset install is pinned by its path, so re-installing the same URL
 * would fetch the same bytes and call that an update. Rewriting the tag in that
 * path gives pnpm a new URL — and therefore a new integrity — instead of a cache
 * hit. The file name moves with it: releases carry both
 * `dsh-mobile-plugin-<version>.tgz` and a version-free `dsh-mobile-plugin.tgz`,
 * so an asset that embeds the old version has to have that version swapped for
 * the new one, and one that does not only needs the tag in the path changed.
 * Every other install re-installs exactly what the profile declared.
 * @param source Where this install came from.
 * @param tag Version tag to install, as GitHub names it (`v0.2.25`).
 * @returns The spec to hand to the host's plugin manager.
 */
export function releaseAssetSpec(source: UpdateSource, tag: string): string {
  if (source.asset === null || source.repo === null) return source.spec
  const was = source.tag === null ? null : tagVersion(source.tag)
  const now = tagVersion(tag)
  const asset = was === null || was === now || !source.asset.includes(was)
    ? source.asset
    : source.asset.split(was).join(now)
  return `https://github.com/${source.repo}/releases/download/${tag}/${asset}`
}

/**
 * `v0.2.23` / `0.2` / `1` compare by their numeric parts, so a tag and the
 * version the plugin reports line up. Anything carrying a pre-release suffix
 * (`0.3.0-rc.1`) keeps its numbers and is treated as a pre-release by
 * {@link compareVersions}'s callers through {@link isPrerelease}. Null for
 * something that is not a version at all, which callers read as "no opinion".
 */
export function versionParts(value: string): { parts: readonly [number, number, number], prerelease: boolean } | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.*))?$/u.exec(value.trim())
  if (match === null) return null
  return {
    parts: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    prerelease: match[4] !== undefined && match[4] !== '',
  }
}

/**
 * Negative when `left` is older, positive when newer, 0 when equal. Two
 * versions that cannot be parsed are never "newer" than each other: a console
 * with no opinion must not offer an update.
 */
export function compareVersions(left: string, right: string): number {
  const a = versionParts(left)
  const b = versionParts(right)
  if (a === null || b === null) return 0
  for (let index = 0; index < 3; index += 1) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] > b.parts[index] ? 1 : -1
  }
  // `0.3.0-rc.1` sits before `0.3.0`: both are reported by `mobile.info`, and
  // offering the stable tag over its own pre-release is the right direction.
  if (a.prerelease !== b.prerelease) return a.prerelease ? -1 : 1
  return 0
}

/** Whether `candidate` is a version the owner should be offered. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

/**
 * The tag a GitHub tags response names as the newest version. Non-version tags
 * (`latest`, `nightly`) are skipped rather than rejected: a repository may
 * carry both and only one of them is a version.
 */
export function latestTag(tags: readonly unknown[]): string | null {
  let newest: string | null = null
  for (const entry of tags) {
    if (entry === null || typeof entry !== 'object') continue
    const name = (entry as { name?: unknown }).name
    if (typeof name !== 'string' || versionParts(name) === null) continue
    if (newest === null || compareVersions(name, newest) > 0) newest = name
  }
  return newest
}

/** Tags of one repository, newest first, as GitHub's API returns them. */
export const TAGS_PAGE_SIZE = 100

export interface LatestTagOptions {
  /** Injected so tests and headless callers stay off the network. */
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

/**
 * Reads the newest version tag of `owner/repo`. Fails loudly: the console shows
 * the reason (no network, rate limit, private repository) instead of claiming
 * "已是最新", which is the one answer that must never be invented.
 */
export async function fetchLatestTag(repo: string, options: LatestTagOptions = {}): Promise<string | null> {
  const doFetch = options.fetch ?? fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000)
  const signal = options.signal === undefined
    ? controller.signal
    : AbortSignal.any([options.signal, controller.signal])
  try {
    const response = await doFetch(`https://api.github.com/repos/${repo}/tags?per_page=${TAGS_PAGE_SIZE}`, {
      headers: { accept: 'application/vnd.github+json' },
      signal,
    })
    if (!response.ok) {
      throw new Error(response.status === 404
        ? `GitHub 上找不到 ${repo}（私有仓库或名字不对）。`
        : `GitHub 返回 HTTP ${response.status}，稍后再试。`)
    }
    return latestTag(await response.json() as readonly unknown[])
  } finally {
    clearTimeout(timeout)
  }
}
