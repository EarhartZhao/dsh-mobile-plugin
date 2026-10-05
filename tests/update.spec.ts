import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  fetchLatestTag,
  isNewerVersion,
  latestTag,
  parseUpdateSource,
  versionParts,
} from '../src/update.js'

describe('parseUpdateSource', () => {
  it('reads the repository out of every GitHub spec shape', () => {
    for (const spec of [
      'github:owner/repo',
      'git+github:owner/repo',
      'github:owner/repo#v0.2.0',
      'git+https://github.com/owner/repo.git',
      'https://github.com/owner/repo',
      'git@github.com:owner/repo.git',
      'owner/repo',
      'owner/repo#main',
    ]) {
      expect([spec, parseUpdateSource(spec)?.repo]).toEqual([spec, 'owner/repo'])
    }
  })

  it('keeps the spec verbatim, so an update re-installs exactly what the profile declared', () => {
    expect(parseUpdateSource('  github:owner/repo#v0.2.0  ')?.spec).toBe('github:owner/repo#v0.2.0')
  })

  it('flags a local path as local instead of guessing a repository', () => {
    for (const spec of ['link:../dsh-mobile-plugin', 'file:/srv/plugin', './plugin', '/srv/plugin', 'C:\\plugin']) {
      expect([spec, parseUpdateSource(spec)?.local]).toEqual([spec, true])
    }
    expect(parseUpdateSource('link:../x')?.repo).toBeNull()
  })

  it('returns null when there is no spec at all', () => {
    expect(parseUpdateSource(undefined)).toBeNull()
    expect(parseUpdateSource(null)).toBeNull()
    expect(parseUpdateSource('   ')).toBeNull()
  })
})

describe('version comparison', () => {
  it('compares numeric parts, with or without a leading v', () => {
    expect(compareVersions('v0.2.10', '0.2.9')).toBeGreaterThan(0)
    expect(compareVersions('0.2.24', '0.2.24')).toBe(0)
    expect(compareVersions('1', '0')).toBeGreaterThan(0)
    // A missing minor/patch reads as zero rather than failing to parse.
    expect(versionParts('0.3')?.parts).toEqual([0, 3, 0])
  })

  it('puts a pre-release before its own stable tag', () => {
    expect(compareVersions('0.3.0-rc.1', '0.3.0')).toBeLessThan(0)
    expect(compareVersions('0.3.0', '0.3.0-rc.1')).toBeGreaterThan(0)
  })

  it('never calls an unparseable version newer', () => {
    expect(compareVersions('latest', '0.2.24')).toBe(0)
    expect(isNewerVersion('nightly', '0.2.24')).toBe(false)
  })

  it('offers only a strictly newer version', () => {
    expect(isNewerVersion('0.2.25', '0.2.24')).toBe(true)
    expect(isNewerVersion('0.2.24', '0.2.24')).toBe(false)
    expect(isNewerVersion('0.2.23', '0.2.24')).toBe(false)
  })
})

describe('latestTag', () => {
  it('picks the newest version tag and skips non-version ones', () => {
    expect(latestTag([
      { name: 'latest' },
      { name: 'v0.2.9' },
      { name: 'nightly' },
      { name: 'v0.2.10' },
      { name: 'v0.2.10-rc.1' },
    ])).toBe('v0.2.10')
  })

  it('answers null when there is no version tag to trust', () => {
    expect(latestTag([{ name: 'release' }, { name: 7 }, null, 'oops'])).toBeNull()
  })
})

describe('fetchLatestTag', () => {
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('reads the newest tag off GitHub tags', async () => {
    const seen: string[] = []
    const tag = await fetchLatestTag('owner/repo', {
      fetch: (async (url: string | URL | Request) => {
        seen.push(String(url))
        return jsonResponse([{ name: 'v0.2.9' }, { name: 'v0.2.24' }])
      }) as typeof fetch,
    })
    expect(tag).toBe('v0.2.24')
    expect(seen[0]).toContain('/repos/owner/repo/tags')
    expect(seen[0]).toContain('per_page=100')
  })

  it('names a missing repository instead of reporting "up to date"', async () => {
    await expect(fetchLatestTag('owner/missing', {
      fetch: (async () => jsonResponse({ message: 'Not Found' }, 404)) as typeof fetch,
    })).rejects.toThrow(/找不到 owner\/missing/)
  })

  it('reports a non-404 status rather than pretending there is no update', async () => {
    await expect(fetchLatestTag('owner/repo', {
      fetch: (async () => jsonResponse({}, 403)) as typeof fetch,
    })).rejects.toThrow(/HTTP 403/)
  })

  it('gives up on a hung request instead of blocking the page forever', async () => {
    const fetchImpl = ((_url: unknown, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })) as unknown as typeof fetch
    await expect(fetchLatestTag('owner/repo', { fetch: fetchImpl, timeoutMs: 10 })).rejects.toThrow()
  })
})
