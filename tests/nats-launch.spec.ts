import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  leafConfigCandidates,
  missingLeafConfigMessage,
  missingNatsServerMessage,
  natsEndpoint,
  natsServerCandidates,
  probePort,
  resolveLeafConfig,
  resolveNatsServer,
} from '../src/nats-launch.js'

describe('natsEndpoint', () => {
  it('reads host and port from the configured URL', () => {
    expect(natsEndpoint('nats://127.0.0.1:4222')).toEqual({ host: '127.0.0.1', port: 4222 })
    expect(natsEndpoint('nats://leaf.internal:7422')).toEqual({ host: 'leaf.internal', port: 7422 })
  })

  it('defaults the port, and falls back to loopback for anything unparseable', () => {
    expect(natsEndpoint('nats://127.0.0.1')).toEqual({ host: '127.0.0.1', port: 4222 })
    expect(natsEndpoint('nats://127.0.0.1:not-a-port')).toEqual({ host: '127.0.0.1', port: 4222 })
    expect(natsEndpoint('not a url')).toEqual({ host: '127.0.0.1', port: 4222 })
  })
})

describe('probePort', () => {
  it('reports a listening port', async () => {
    const server = createServer(() => undefined)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    try {
      await expect(probePort('127.0.0.1', port, 1000)).resolves.toBe(true)
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()) })
    }
  })

  it('reports a closed port instead of waiting out the budget', async () => {
    await expect(probePort('127.0.0.1', 1, 1000)).resolves.toBe(false)
  })
})

describe('leafConfigCandidates', () => {
  it('lets an explicit setting replace discovery, env first', () => {
    expect(leafConfigCandidates({ env: '/mnt/nats/leaf.conf', configured: '/tmp/other.conf' }))
      .toEqual(['/mnt/nats/leaf.conf'])
    expect(leafConfigCandidates({ configured: '/tmp/other.conf', platform: 'linux' }))
      .toEqual(['/tmp/other.conf'])
    // Whitespace is how an unset field arrives from a form; it still discovers.
    expect(leafConfigCandidates({ env: '  ', configured: '  ', platform: 'linux', home: '/home/x' }))
      .toEqual([
        '/home/x/.dsh/mobile-bridge/leaf.conf',
        '/home/x/.nats-leaf/leaf.conf',
        '/home/x/.config/nats/leaf.conf',
        '/etc/nats/leaf.conf',
        '/etc/nats-server.conf',
      ])
  })

  it('starts discovery at the plugin home, then the conventions of this platform', () => {
    expect(leafConfigCandidates({ platform: 'darwin', home: '/Users/x' })).toEqual([
      '/Users/x/.dsh/mobile-bridge/leaf.conf',
      '/Users/x/.nats-leaf/leaf.conf',
      '/Users/x/.config/nats/leaf.conf',
      '/opt/homebrew/etc/nats/leaf.conf',
      '/usr/local/etc/nats/leaf.conf',
    ])
    // Windows never sees the POSIX candidates, and keeps its own separators.
    // The home entry is spelled by this host's `join`, so only its tail and the
    // literal Windows convention are asserted.
    const windows = leafConfigCandidates({ platform: 'win32', home: 'C:\\Users\\x' })
    expect(windows).toHaveLength(3)
    expect(windows[0]).toMatch(/\.dsh[\\/]mobile-bridge[\\/]leaf\.conf$/)
    expect(windows[1]).toMatch(/\.nats-leaf[\\/]leaf\.conf$/)
    expect(windows[2]).toBe('C:\\nats\\leaf.conf')
    expect(windows).not.toContain('/etc/nats/leaf.conf')
  })
})

describe('natsServerCandidates', () => {
  it('prefers a local copy before whatever PATH resolves', () => {
    const candidates = natsServerCandidates({
      platform: 'linux',
      home: '/home/x',
      pathEnv: '/usr/bin:/opt/nats/bin',
      exists: path => path === '/opt/nats/bin/nats-server',
    })
    expect(candidates).toEqual([
      '/home/x/.dsh/mobile-bridge/nats-server',
      '/home/x/.nats-leaf/nats-server',
      '/opt/nats/bin/nats-server',
    ])
    // Nothing found: the bare name is what "install it on PATH" means.
    expect(natsServerCandidates({ platform: 'linux', home: '/home/x', pathEnv: '', exists: () => false }))
      .toEqual([
        '/home/x/.dsh/mobile-bridge/nats-server',
        '/home/x/.nats-leaf/nats-server',
        'nats-server',
      ])
  })

  it('keeps the Windows install location and executable suffix', () => {
    const candidates = natsServerCandidates({ platform: 'win32', home: 'C:\\Users\\x', pathEnv: '', exists: () => false })
    expect(candidates).toHaveLength(4)
    expect(candidates[2]).toBe('C:\\nats-server\\nats-server.exe')
    expect(candidates[3]).toBe('nats-server.exe')
  })
})

describe('resolveLeafConfig', () => {
  const input = { platform: 'linux' as NodeJS.Platform, home: '/home/x', dshHome: '/home/x/.dsh' }

  it('takes the first existing candidate and reports where it came from', () => {
    const resolution = resolveLeafConfig({
      ...input,
      exists: path => path === '/etc/nats/leaf.conf',
    })
    expect(resolution).toMatchObject({
      path: '/etc/nats/leaf.conf',
      exists: true,
      source: 'default',
    })
    expect(resolution.candidates).toContain('/home/x/.dsh/mobile-bridge/leaf.conf')
  })

  it('recommends the plugin home when nothing exists, without claiming it does', () => {
    const resolution = resolveLeafConfig({ ...input, exists: () => false })
    expect(resolution.path).toBe('/home/x/.dsh/mobile-bridge/leaf.conf')
    expect(resolution.exists).toBe(false)
  })

  it('does not fall back past a path the owner set', () => {
    const resolution = resolveLeafConfig({
      ...input,
      configured: '/srv/leaf.conf',
      exists: path => path === '/etc/nats/leaf.conf',
    })
    expect(resolution).toMatchObject({ path: '/srv/leaf.conf', exists: false, source: 'config' })
    expect(resolution.candidates).toEqual(['/srv/leaf.conf'])
    const fromEnv = resolveLeafConfig({ ...input, env: '/opt/leaf.conf', configured: '/srv/leaf.conf', exists: () => true })
    expect(fromEnv).toMatchObject({ path: '/opt/leaf.conf', source: 'env' })
  })
})

describe('resolveNatsServer', () => {
  it('answers with the found binary, or the bare name to put on PATH', () => {
    const found = resolveNatsServer({
      platform: 'linux',
      home: '/home/x',
      pathEnv: '',
      exists: path => path === '/home/x/.nats-leaf/nats-server',
    })
    expect(found).toMatchObject({ path: '/home/x/.nats-leaf/nats-server', exists: true, source: 'default' })
    const missing = resolveNatsServer({ platform: 'linux', home: '/home/x', pathEnv: '', exists: () => false })
    expect(missing).toMatchObject({ path: 'nats-server', exists: false })
    const fromField = resolveNatsServer({ platform: 'linux', home: '/home/x', configured: '/opt/nats', exists: () => true })
    expect(fromField).toMatchObject({ path: '/opt/nats', exists: true, source: 'config', candidates: ['/opt/nats'] })
  })
})

describe('missing-file messages', () => {
  // A machine with no local NATS is the one case the launch button cannot fix
  // itself, so the message has to do two things: name every path it looked at
  // (the owner may keep the file somewhere else) and hand over to the install
  // checklist that an AI assistant can execute.
  const input = { platform: 'linux' as const, home: '/home/x', pathEnv: '', exists: () => false }

  it('lists the guessed executable paths and points at the install checklist', () => {
    const server = resolveNatsServer(input)
    const message = missingNatsServerMessage(server)
    expect(message).toContain('找不到 nats-server 可执行文件')
    for (const candidate of server.candidates) expect(message).toContain(candidate)
    expect(message).toContain('docs/04-ai-onboarding.md')
    // The last candidate is the bare name (its meaning is "put it on PATH"),
    // so the message has to keep telling the owner about the field too.
    expect(message).toContain('NATS_SERVER_PATH')
  })

  it('lists the guessed config paths and points at the install checklist', () => {
    const leaf = resolveLeafConfig(input)
    const message = missingLeafConfigMessage(leaf)
    expect(message).toContain('找不到 NATS 配置文件')
    for (const candidate of leaf.candidates) expect(message).toContain(candidate)
    expect(message).toContain('docs/04-ai-onboarding.md')
  })
})
