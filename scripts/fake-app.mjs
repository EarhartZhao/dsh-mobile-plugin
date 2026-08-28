/**
 * Simulated dsh-mobile app for manual acceptance (build plan Phase 1 gate).
 *
 * Usage:
 *   pnpm run build
 *   node scripts/fake-app.mjs [natsUrl] [pairCode] [instanceId]
 *
 * Defaults: nats://127.0.0.1:4222, pairing code read from env PAIR_CODE, instance 'home'.
 * Runs: pair (if code given) -> session.list -> host.describe -> subscribe events 5s.
 */
import { connect, headers } from 'nats'

const natsUrl = process.argv[2] ?? 'nats://127.0.0.1:4222'
const pairCode = process.argv[3] ?? process.env.PAIR_CODE
const instance = process.argv[4] ?? 'home'

const nc = await connect({ servers: natsUrl })
console.log('connected to', natsUrl)

async function call(method, payload, token) {
  const h = headers()
  if (token) h.set('x-dsh-token', token)
  const reply = await nc.request(
    `svc.dsh.${instance}.${method}`,
    JSON.stringify({ type: 'client-request', rpcId: `fake-${Date.now()}`, method, payload }),
    { timeout: 8000, headers: h },
  )
  return JSON.parse(reply.string())
}

// 0. unauthenticated call must be rejected
const denied = await call('host.describe', {})
console.log('unauthenticated ->', denied.result?.error?.message ?? 'UNEXPECTED OK')

// 1. pair
let token = process.env.DSH_MOBILE_TOKEN
if (!token && pairCode) {
  const paired = await call('pair', { code: pairCode, deviceName: 'fake-app' })
  if (paired.result?.ok) {
    token = paired.result.value.token
    console.log('paired OK, token:', token.slice(0, 8) + '...')
  } else {
    console.log('pair failed:', paired.result?.error?.message)
  }
}
if (!token) {
  console.log('no token; provide PAIR_CODE or DSH_MOBILE_TOKEN')
  await nc.drain()
  process.exit(1)
}

// 2. gated RPCs
const describe = await call('host.describe', {}, token)
console.log('host.describe ok?', describe.result?.ok === true)
const list = await call('session.list', {}, token)
console.log('session.list ok?', list.result?.ok === true)

// 3. events for 5s
const sub = nc.subscribe(`evt.dsh.${instance}.>`)
const timer = setTimeout(async () => {
  console.log('event watch done')
  await nc.drain()
  process.exit(0)
}, 5000)
for await (const msg of sub) {
  const frame = JSON.parse(msg.string())
  console.log('[event]', msg.subject, frame.method)
}
clearTimeout(timer)
