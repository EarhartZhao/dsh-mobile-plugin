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
})
