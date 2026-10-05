/**
 * The settings page can only persist a namespace whose schema declares the
 * edited fields `.volatile()`, and a volatile field reaches the plugin as a live
 * reference the loader updates in place. Both halves are contract, so pin them.
 */
import { describe, expect, it } from 'vitest'
import { createVolatile, isVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { Config, configValues, type Config as PlainConfig } from '../src/config.js'
import { sameConfig } from '../src/index.js'

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
    instanceName: '',
    tokenTtlDays: 90,
    pairCodeTtlSec: 120,
    maxDevices: 10,
    chunkCoalesceMs: 0,
    natsConfigPath: '',
    natsServerPath: '',
    autoMigrateProfile: true,
  }
}

/** A different, still well-typed value for one field. */
function altered(value: unknown): unknown {
  if (typeof value === 'string') return `${value}-changed`
  if (typeof value === 'number') return value + 1
  if (typeof value === 'boolean') return !value
  return value
}

describe('sameConfig', () => {
  /**
   * The bridge only rebuilds when this comparison says the config moved, so a
   * field that is missing here is a field whose saves silently never reach the
   * running plugin. Both directions are pinned: every schema field must be in
   * the fixture, and editing any of them must make the comparison fail.
   */
  it('notices a change to every field the schema declares', () => {
    const dict = (Config as unknown as { dict: Record<string, unknown> }).dict
    const base = plain()

    for (const key of Object.keys(dict)) expect(base, `${key} must be in the fixture`).toHaveProperty(key)
    for (const key of Object.keys(base)) {
      expect(dict[key], `${key} must be in the schema`).toBeDefined()
      const changed = { ...base, [key]: altered(base[key as keyof PlainConfig]) }
      expect(sameConfig(base, changed as PlainConfig), `${key} must be compared`).toBe(false)
    }
  })

  it('is true for equal values', () => {
    expect(sameConfig(plain(), plain())).toBe(true)
  })
})
