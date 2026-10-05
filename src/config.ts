/** Plugin configuration schema (schemastery), per docs/00-plugin-plan.md. */

import type { Volatile } from '@deepseek-ai/cordis'
import { isVolatile } from '@deepseek-ai/cosmokit'
import z from '@deepseek-ai/schemastery'

export interface Config {
  /** Local Leaf node address; the Leaf owns Hub reachability and retries. */
  natsUrl: string
  /** Public Hub wss address handed to phones via the pairing QR. */
  hubWssUrl: string
  /** Hub C-end account handed to phones via the pairing QR. */
  hubUser: string
  hubPass: string
  /**
   * Hub CA certificate (PEM or base64 DER). Rides the pairing QR so phones
   * install it as the trust anchor for {@link hubWssUrl}, which is what lets
   * one App build talk to any self-hosted Hub. See src/hub-ca.ts.
   */
  hubCaCert: string
  /** Hub CA fingerprint; when set it must match {@link hubCaCert}. */
  hubCaFingerprint: string
  /** Subject namespace: svc.dsh.{instanceId}.* / evt.dsh.{instanceId}.* */
  instanceId: string
  /**
   * What this machine calls itself on the phone. Empty falls back to
   * {@link instanceId}, so an install that never sets it still shows something
   * readable in the app's connection list.
   */
  instanceName: string
  /** Long-lived device token validity. */
  tokenTtlDays: number
  /** One-time pairing code validity. */
  pairCodeTtlSec: number
  /** Max paired terminals. */
  maxDevices: number
  /** >0 coalesces high-frequency frames (e.g. assistant/chunk) per window; 0 disables. */
  chunkCoalesceMs: number
  /**
   * Leaf config the console's 「启动本地 NATS」 runs `nats-server -c <path>` with.
   * Empty means discover it: `$DSH_HOME/mobile-bridge/leaf.conf`, then the
   * conventions of this platform. `NATS_CONFIG_PATH` overrides both. See
   * src/nats-launch.ts for the candidate order.
   */
  natsConfigPath: string
  /**
   * `nats-server` the console's 「启动本地 NATS」 runs. Empty means discover it:
   * the plugin home, `~/.nats-leaf`, then `PATH`. `NATS_SERVER_PATH` overrides
   * both. See src/nats-launch.ts for the candidate order.
   */
  natsServerPath: string
  /**
   * Repair the profile's install shape when this profile mounts the row with a
   * bare `insert` instead of the bundle layer. The host cannot manage that
   * shape — its row toggle only renders while the bundle is enabled, and
   * uninstall fails with `bundle-in-use` — so the plugin registers itself in
   * `dsh.profile.bundles` and, once that bundle is live at a later start,
   * turns the insert row into a plain id-targeted override. See
   * src/profile-migration.ts. Turn off to keep the profile files untouched.
   */
  autoMigrateProfile: boolean
}

/**
 * Loader-facing view of {@link Config}: every editable field is declared
 * `.volatile()`, so the loader hands it over as a live reference it updates in
 * place — the settings page saving the namespace commits into these references
 * and emits `loader/volatile-update` instead of remounting the plugin.
 * {@link configValues} flattens them back into the plain values the bridge
 * reads, and src/index.ts re-reads them on that event.
 */
export type ConfigInput = { [K in keyof Config]: Volatile<Config[K]> }

export const Config = z.object({
  natsUrl: z.string().default('nats://127.0.0.1:4222').volatile(),
  hubWssUrl: z.string().default('').volatile(),
  hubUser: z.string().default('').volatile(),
  hubPass: z.string().role('secret').default('').volatile(),
  hubCaCert: z.string().default('').volatile(),
  hubCaFingerprint: z.string().default('').volatile(),
  instanceId: z.string().pattern(/^[a-z0-9-]+$/).default('home').volatile(),
  /**
   * Display name for this machine, as the phone shows it in its connection
   * list. Empty means "use instanceId": an existing install gets a readable
   * name only when its owner types one, and the phone always has something.
   */
  instanceName: z.string().default('').volatile(),
  tokenTtlDays: z.natural().default(90).volatile(),
  pairCodeTtlSec: z.natural().default(120).volatile(),
  maxDevices: z.natural().default(10).volatile(),
  chunkCoalesceMs: z.natural().default(0).volatile(),
  natsConfigPath: z.string().default('').volatile(),
  natsServerPath: z.string().default('').volatile(),
  autoMigrateProfile: z.boolean().default(true).volatile(),
})

/** Read one resolved field; a `.volatile()` field arrives as a reference. */
function field<T>(value: Volatile<T> | T): T {
  return isVolatile(value) ? value.get() as T : value as T
}

/**
 * Flatten the loader's live references into the plain values the rest of the
 * plugin reads. A plain object resolves to itself, so headless compositions and
 * tests can hand over an already-resolved config.
 * @param input Resolved loader config, or plain values.
 * @returns Detached plain configuration.
 */
export function configValues(input: ConfigInput | Config): Config {
  return {
    natsUrl: field(input.natsUrl),
    hubWssUrl: field(input.hubWssUrl),
    hubUser: field(input.hubUser),
    hubPass: field(input.hubPass),
    hubCaCert: field(input.hubCaCert),
    hubCaFingerprint: field(input.hubCaFingerprint),
    instanceId: field(input.instanceId),
    instanceName: field(input.instanceName),
    tokenTtlDays: field(input.tokenTtlDays),
    pairCodeTtlSec: field(input.pairCodeTtlSec),
    maxDevices: field(input.maxDevices),
    chunkCoalesceMs: field(input.chunkCoalesceMs),
    natsConfigPath: field(input.natsConfigPath),
    natsServerPath: field(input.natsServerPath),
    autoMigrateProfile: field(input.autoMigrateProfile),
  }
}
