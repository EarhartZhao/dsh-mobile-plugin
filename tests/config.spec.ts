/**
 * The settings page can only persist a namespace whose schema declares the
 * edited fields `.volatile()`, and a volatile field reaches the plugin as a live
 * reference the loader updates in place. Both halves are contract, so pin them.
 */
import { describe, expect, it } from 'vitest'
import { createVolatile, isVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { Config, configValues, type Config as PlainConfig } from '../src/config.js'

describe('plugin config schema', () => {
  it('declares every field volatile so the settings page may write it', () => {
    const dict = (Config as unknown as { dict: Record<string, { meta?: { volatile?: boolean } }> }).dict
    const fields = Object.keys(dict)
    expect(fields.length).toBeGreaterThan(0)
    for (const key of fields) expect(dict[key]?.meta?.volatile, `${key} must be volatile`).toBe(true)
  })

  it('resolves volatile fields to live references, not plain values', () => {
    const parsed = Config({})
    expect(isVolatile(parsed.natsUrl)).toBe(true)
    expect(isVolatile(parsed.hubPass)).toBe(true)
  })
})

describe('configValues', () => {
  it('flattens live references into plain values', () => {
    const values = configValues(Config({ hubUser: 'c-end-test', instanceId: 'home-test' }))
    expect(values.hubUser).toBe('c-end-test')
    expect(values.instanceId).toBe('home-test')
    expect(values.natsUrl).toBe('nats://127.0.0.1:4222')
    expect(isVolatile(values.hubPass)).toBe(false)
  })

  it('picks up a value the loader commits into a reference', () => {
    const raw = Config({ hubWssUrl: '' })
    updateVolatile(raw.hubWssUrl, createVolatile('wss://hub.test:8443'))
    expect(configValues(raw).hubWssUrl).toBe('wss://hub.test:8443')
  })

  it('passes an already-plain config through', () => {
    expect(configValues(plain())).toEqual(plain())
  })
})

/** Plain config: what a headless composition or a test hands over. */
function plain(): PlainConfig {
  return {
    natsUrl: 'nats://127.0.0.1:4222',
    hubWssUrl: '',
    hubUser: '',
    hubPass: '',
    hubCaCert: '',
    hubCaFingerprint: '',
    instanceId: 'home-test',
    tokenTtlDays: 90,
    pairCodeTtlSec: 120,
    maxDevices: 10,
    chunkCoalesceMs: 0,
    natsConfigPath: '',
    natsServerPath: '',
    autoMigrateProfile: true,
  }
}
