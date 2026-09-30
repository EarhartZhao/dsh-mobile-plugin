/** Plugin configuration schema (schemastery), per docs/00-plugin-plan.md. */

import z from '@deepseek-ai/schemastery'

export interface Config {
  /** Local Leaf node address; the Leaf owns Hub reachability and retries. */
  natsUrl: string
  /** Public Hub wss address handed to phones via the pairing QR. */
  hubWssUrl: string
  /** Hub C-end account handed to phones via the pairing QR. */
  hubUser: string
  hubPass: string
  /** Hub CA fingerprint (display/verification aid in the app). */
  hubCaFingerprint: string
  /** Subject namespace: svc.dsh.{instanceId}.* / evt.dsh.{instanceId}.* */
  instanceId: string
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

export const Config: z<Config> = z.object({
  natsUrl: z.string().default('nats://127.0.0.1:4222'),
  hubWssUrl: z.string().default(''),
  hubUser: z.string().default(''),
  hubPass: z.string().role('secret').default(''),
  hubCaFingerprint: z.string().default(''),
  instanceId: z.string().pattern(/^[a-z0-9-]+$/).default('home'),
  tokenTtlDays: z.natural().default(90),
  pairCodeTtlSec: z.natural().default(120),
  maxDevices: z.natural().default(10),
  chunkCoalesceMs: z.natural().default(0),
  natsConfigPath: z.string().default(''),
  natsServerPath: z.string().default(''),
  autoMigrateProfile: z.boolean().default(true),
})
