/**
 * Stable identity for one plugin installation.
 *
 * The gateway id must survive profile edits, address changes, restarts and
 * package upgrades. It is deliberately separate from device ids and tokens:
 * a phone can identify "the same dsh install" without treating a mutable
 * display name or Hub URL as identity. A damaged identity file is reported
 * instead of being replaced, because silently minting a new id would make an
 * existing phone reject the machine as a different gateway.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface GatewayIdentity {
  version: 1
  gatewayId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export class GatewayIdentityStore {
  private cached: GatewayIdentity | null = null
  private loading: Promise<GatewayIdentity> | null = null

  /** @param filePath - e.g. $DSH_HOME/mobile-bridge/identity.json */
  constructor(private readonly filePath: string) {}

  /**
   * Load the installation identity, creating it exactly once on first use.
   * Concurrent callers share the same in-flight load.
   */
  async load(): Promise<GatewayIdentity> {
    if (this.cached !== null) return this.cached
    if (this.loading !== null) return this.loading
    this.loading = this.readOrCreate().then((identity) => {
      this.cached = identity
      return identity
    }).finally(() => {
      this.loading = null
    })
    return this.loading
  }

  /** Last loaded identity, when one is already available to synchronous surfaces. */
  get(): GatewayIdentity | null {
    return this.cached
  }

  private async readOrCreate(): Promise<GatewayIdentity> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        throw new Error(`身份文件不是有效 JSON（${this.filePath}）：${String(error)}`)
      }
      if (!isRecord(parsed) || parsed.version !== 1 || !isUuid(parsed.gatewayId)) {
        throw new Error(`身份文件格式无效（${this.filePath}）：需要 { version: 1, gatewayId: "<uuid>" }。`
          + '为避免把已配对设备变成另一台机器，插件不会自动覆盖这个文件。')
      }
      return { version: 1, gatewayId: parsed.gatewayId }
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error
    }

    const identity: GatewayIdentity = { version: 1, gatewayId: randomUUID() }
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(identity, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, this.filePath)
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined)
      throw error
    }
    return identity
  }
}
