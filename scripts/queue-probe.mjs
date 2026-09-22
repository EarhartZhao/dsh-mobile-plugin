/**
 * Queue-frame probe: verifies the App's `session/queue` frames still arrive
 * after dsh 0.1.6-alpha.2 removed the dedicated `queue` control frames.
 *
 * The host now publishes pending input only as the Session's `inbox` projection
 * (what the Web client reads), so the bridge derives the legacy queue frame from
 * it. This probe watches the mux subject while a control generation starts and
 * reports every queue frame plus the inbox projections that produced them.
 *
 * Usage:
 *   pnpm run build
 *   node scripts/queue-probe.mjs [natsUrl] [instanceId] [--activate]
 *
 * The `inbox` projection only exists while a Session holds a live agent — the
 * same gate the alpha.1 `queues` table had (`agent?.session === session`). Pass
 * `--activate` to create a throwaway Session, run one real turn through the
 * configured model, and queue a second message behind it, which is the only
 * state that produces the projection on an idle host.
 *
 * Token: DSH_MOBILE_TOKEN or DSH_MOBILE_TOKEN_FILE (same as scripts/fake-app.mjs).
 */
import { connect, headers } from 'nats'
import { existsSync, readFileSync } from 'node:fs'

const natsUrl = process.argv[2] ?? 'nats://127.0.0.1:4222'
const instance = process.argv[3] ?? 'home'
const activate = process.argv.includes('--activate')

const tokenFile = process.env.DSH_MOBILE_TOKEN_FILE
const token = process.env.DSH_MOBILE_TOKEN
  ?? (tokenFile !== undefined && existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : undefined)
if (token === undefined) {
  console.error('no token: set DSH_MOBILE_TOKEN or DSH_MOBILE_TOKEN_FILE')
  process.exit(1)
}

const nc = await connect({ servers: natsUrl })

async function call(method, payload) {
  const h = headers()
  h.set('x-dsh-token', token)
  const reply = await nc.request(
    `svc.dsh.${instance}.${method}`,
    JSON.stringify({ type: 'client-request', rpcId: `queue-probe-${Date.now()}`, method, payload }),
    { timeout: 8000, headers: h },
  )
  return JSON.parse(reply.string())
}

const queueFrames = []
const inboxProjections = []
const sub = nc.subscribe(`evt.dsh.${instance}.mux`)
;(async () => {
  for await (const msg of sub) {
    const payload = JSON.parse(msg.string())?.payload
    if (payload?.type === 'session/queue') queueFrames.push(payload)
    else if (payload?.type === 'session/projection' && payload.key === 'inbox') inboxProjections.push(payload)
  }
})()

// Opening the control generation publishes the baseline; the bridge translates
// each session's inbox projection into one queue frame.
const list = await call('session.list', {})
let sessionId = list.result?.value?.items?.[0]?.sessionId
console.log('session.list ->', sessionId ?? '(none)')
if (sessionId !== undefined) {
  await call('session.history', { sessionId, maxMessages: 1 })
}
if (activate) {
  // The first prompt runs a real turn, which attaches the agent that owns the
  // `inbox` projection; the second is queued behind it.
  const first = await call('session.prompt', {
    sessionId, mode: 'queue', content: [{ type: 'text', text: 'Reply with the single word ok.' }],
  })
  console.log('prompt#1 ->', JSON.stringify(first.result?.value ?? first.result ?? first).slice(0, 160))
  const second = await call('session.prompt', {
    sessionId, mode: 'queue', content: [{ type: 'text', text: 'queued behind the first turn' }],
  })
  console.log('prompt#2 ->', JSON.stringify(second.result?.value ?? second.result ?? second).slice(0, 160))
}
await new Promise(r => setTimeout(r, activate ? 12_000 : 2_500))

console.log(`queue frames: ${queueFrames.length}, inbox projections: ${inboxProjections.length}`)
for (const frame of queueFrames.slice(0, 3)) {
  const placements = frame.items.map(item => item.placement).join(',')
  console.log(`  queue ${frame.sessionId}: ${frame.items.length} item(s) [${placements}]`)
}
for (const projection of inboxProjections.slice(0, 3)) {
  const counts = projection.value
  console.log(
    `  inbox ${projection.sessionId}: next-turn=${Array.isArray(counts?.['next-turn']) ? counts['next-turn'].length : '?'}` +
    ` next-step=${Array.isArray(counts?.['next-step']) ? counts['next-step'].length : '?'}`,
  )
}

sub.unsubscribe()
await nc.drain()
process.exit(queueFrames.some(frame => frame.items.length > 0) && inboxProjections.length > 0 ? 0 : 1)
