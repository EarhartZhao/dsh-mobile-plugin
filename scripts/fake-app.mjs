/**
 * Simulated dsh-mobile app for manual acceptance (build plan Phase 1 gate).
 *
 * Usage:
 *   pnpm run build
 *   node scripts/fake-app.mjs [natsUrl] [pairCode] [instanceId]
 *
 * Defaults: nats://127.0.0.1:4222, pairing code read from env PAIR_CODE, instance 'home'.
 * Runs: pair (if code given) -> host.describe -> session.list -> the current
 * Remote surface this bridge adapts (goal.get, file.list/read/stat/watch,
 * feedback.list, mobile.info) -> subscribe events 5s. Each probe prints
 * `ok`/`FAIL` with the host's own error, so one run covers the whole bridge.
 */
import { connect, headers } from 'nats'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

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

// 1. pair — reuse a previously issued token when one is on disk so repeated
// acceptance runs do not burn device slots against `maxDevices`.
const tokenFile = process.env.DSH_MOBILE_TOKEN_FILE
let token = process.env.DSH_MOBILE_TOKEN
  ?? (tokenFile !== undefined && existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : undefined)
if (!token && pairCode) {
  const paired = await call('pair', { code: pairCode, deviceName: 'fake-app' })
  if (paired.result?.ok) {
    token = paired.result.value.token
    console.log('paired OK, token:', token.slice(0, 8) + '...')
    if (tokenFile !== undefined) writeFileSync(tokenFile, token, { mode: 0o600 })
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
console.log('host.describe ok?', describe.result?.ok === true,
  describe.result?.ok === true ? `(host dsh ${describe.result.value?.version ?? 'unknown'})` : '')
const list = await call('session.list', {}, token)
console.log('session.list ok?', list.result?.ok === true,
  `(${Array.isArray(list.result?.value?.items) ? list.result.value.items.length : 0} sessions)`)

// 3. bridge self-description and the 0.1.5 Remote surfaces
const probe = async (label, method, payload) => {
  const reply = await call(method, payload, token)
  const ok = reply.result?.ok === true
  const detail = ok
    ? JSON.stringify(reply.result.value)?.slice(0, 120)
    : reply.result?.error?.message
  console.log(`${ok ? 'ok' : 'FAIL'} ${label}${detail === undefined ? '' : ` -> ${detail}`}`)
  return ok ? reply.result.value : undefined
}

const info = await probe('mobile.info', 'mobile.info', {})
const sessions = Array.isArray(list.result?.value?.items) ? list.result.value.items : []
const sessionId = sessions[0]?.sessionId
console.log('session for scoped probes:', sessionId ?? '(none)')

if (sessionId !== undefined) {
  await probe('goal.get', 'goal.get', { sessionId })
  await probe('feedback.list', 'feedback.list', { sessionId })
  const listing = await probe('file.list', 'file.list', { sessionId })
  const firstFile = Array.isArray(listing?.entries)
    ? listing.entries.find(entry => entry.type === 'file')
    : undefined
  if (firstFile !== undefined) {
    await probe('file.read', 'file.read',
      { sessionId, path: [listing.path, firstFile.name].filter(Boolean).join('/'), limit: 5 })
    await probe('file.stat', 'file.stat',
      { sessionId, path: [listing.path, firstFile.name].filter(Boolean).join('/') })
    // The watch arms a host stream; its `workspace-files/ready` arrives on the host subject.
    await probe('file.watch', 'file.watch', { sessionId })
    await probe('file.unwatch', 'file.unwatch', { sessionId })
  }
}

// 4. events for 5s
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
