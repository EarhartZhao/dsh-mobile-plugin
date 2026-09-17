import { describe, expect, it, vi } from 'vitest'
import { checkHubCredentials, hubProbeAddress } from '../src/hub-check.js'
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

describe('hubProbeAddress', () => {
  it('targets the Hub client port on the same host', () => {
    expect(hubProbeAddress('wss://115.159.57.137:8443')).toBe('nats://115.159.57.137:4222')
  })

  it('returns null for an address it cannot parse', () => {
    expect(hubProbeAddress('not a url')).toBeNull()
    expect(hubProbeAddress('')).toBeNull()
  })
})

describe('checkHubCredentials', () => {
  it('reports an incomplete configuration without touching the network', async () => {
    const connectImpl = vi.fn()
    const result = await checkHubCredentials({ ...config, hubPass: '' }, {
      connectImpl: connectImpl as unknown as typeof import('nats').connect,
    })
    expect(result.reason).toBe('unconfigured')
    expect(connectImpl).not.toHaveBeenCalled()
  })

  it('treats a Hub rejection as definitive', async () => {
    const result = await checkHubCredentials(config, { connectImpl: failingConnect('AUTHORIZATION_VIOLATION') })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('rejected')
    expect(result.message).toContain('c-end-dsh')
  })

  it('does not blame the password when the port is simply unreachable', async () => {
    const result = await checkHubCredentials(config, { connectImpl: failingConnect('TIMEOUT') })
    expect(result.reason).toBe('unreachable')
    expect(result.message).toContain('不代表密码有错')
  })

  it('passes when the Hub accepts the credentials', async () => {
    const close = vi.fn(() => Promise.resolve())
    const connectImpl = (() => Promise.resolve({ close })) as unknown as typeof import('nats').connect
    const result = await checkHubCredentials(config, { connectImpl })
    expect(result).toMatchObject({ ok: true, reason: 'ok' })
    expect(close).toHaveBeenCalled()
  })
})
