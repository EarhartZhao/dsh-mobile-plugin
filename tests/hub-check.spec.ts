import { describe, expect, it, vi } from 'vitest'
import { checkHubPath, hubProbeAddress } from '../src/hub-check.js'
import type { Config } from '../src/config.js'

const config: Config = {
  natsUrl: 'nats://127.0.0.1:4222',
  hubWssUrl: 'wss://115.159.57.137:8443',
  hubUser: 'c-end-dsh',
  hubPass: 'real-password',
  hubCaFingerprint: '',
  instanceId: 'home-mac',
  tokenTtlDays: 90,
  pairCodeTtlSec: 120,
  maxDevices: 10,
  chunkCoalesceMs: 0,
}

/** A connect stub that fails with a NATS-shaped error code. */
function failingConnect(code: string): typeof import('nats').connect {
  return (() => Promise.reject(Object.assign(new Error('nope'), { code }))) as unknown as typeof import('nats').connect
}

/** A connect stub that reaches the Hub; `request` answers or rejects as told. */
function connectedConnect(answer: { data: Uint8Array } | Error): typeof import('nats').connect {
  return (() => Promise.resolve({
    close: () => Promise.resolve(),
    request: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)),
  })) as unknown as typeof import('nats').connect
}

const answered = { data: new TextEncoder().encode('{"result":{"ok":false}}') }
const noResponders = () => Object.assign(new Error('503'), { code: '503' })

describe('hubProbeAddress', () => {
  it('targets the Hub client port on the same host', () => {
    expect(hubProbeAddress('wss://115.159.57.137:8443')).toBe('nats://115.159.57.137:4222')
  })

  it('returns null for an address it cannot parse', () => {
    expect(hubProbeAddress('not a url')).toBeNull()
    expect(hubProbeAddress('')).toBeNull()
  })
})

describe('checkHubPath', () => {
  it('reports an incomplete configuration without touching the network', async () => {
    const connectImpl = vi.fn()
    const result = await checkHubPath({ ...config, hubPass: '' }, {
      connectImpl: connectImpl as unknown as typeof import('nats').connect,
    })
    expect(result.reason).toBe('unconfigured')
    expect(connectImpl).not.toHaveBeenCalled()
  })

  it('treats a Hub rejection as definitive', async () => {
    const result = await checkHubPath(config, { connectImpl: failingConnect('AUTHORIZATION_VIOLATION') })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('rejected')
    expect(result.message).toContain('c-end-dsh')
  })

  it('does not blame the password when the port is simply unreachable', async () => {
    const result = await checkHubPath(config, { connectImpl: failingConnect('TIMEOUT') })
    expect(result.reason).toBe('unreachable')
    expect(result.message).toContain('不代表密码有错')
  })

  it('passes only when the Hub can also reach this instance', async () => {
    const result = await checkHubPath(config, { connectImpl: connectedConnect(answered) })
    expect(result).toMatchObject({ ok: true, reason: 'ok' })
    expect(result.steps.map(step => step.key)).toEqual(['credentials', 'hub-path'])
    expect(result.steps.every(step => step.ok)).toBe(true)
  })

  it('names the Leaf link when the Hub has no responder for this instance', async () => {
    // The exact shape the phone sees: NATS answers a request nobody serves
    // with code AND message "503" — valid credentials, missing host.
    const result = await checkHubPath(config, { connectImpl: connectedConnect(noResponders()) })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('bridge-offline')
    expect(result.message).toContain('Leaf')
    expect(result.steps.find(step => step.key === 'hub-path')?.ok).toBe(false)
    // Credentials are still reported as fine, so the user fixes the right link.
    expect(result.steps.find(step => step.key === 'credentials')?.ok).toBe(true)
  })

  it('separates a local bridge that is down from a Leaf that is down', async () => {
    const local = await checkHubPath(config, { connectImpl: connectedConnect(noResponders()), localConnected: false })
    const leaf = await checkHubPath(config, { connectImpl: connectedConnect(noResponders()), localConnected: true })

    expect(local.steps.find(step => step.key === 'local')?.ok).toBe(false)
    expect(leaf.steps.find(step => step.key === 'local')?.ok).toBe(true)
    expect(local.message).toContain('本地 NATS')
    expect(leaf.message).toContain('Leaf')
  })
})
