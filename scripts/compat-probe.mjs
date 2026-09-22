/**
 * Live compatibility probe for the dsh surfaces the App consumes after
 * 0.1.6-alpha.2. It runs against a host with this plugin loaded and reports the
 * three facts a release check needs:
 *
 *   1. `mobile.info` announces the version and features the App requires;
 *   2. `mobile.inventory` carries `managementAvailable` (alpha.2 added it);
 *   3. `reference.sessions` carries `displayTitle` (alpha.2 added it).
 *
 * Usage:
 *   node scripts/compat-probe.mjs [natsUrl] [instanceId]
 *
 * Token: DSH_MOBILE_TOKEN or DSH_MOBILE_TOKEN_FILE (same as scripts/fake-app.mjs).
 * A session is required for the reference check; pass one as the third argument
 * when the host has none.
 */
import { connect, headers } from 'nats'
import { existsSync, readFileSync } from 'node:fs'

const natsUrl = process.argv[2] ?? 'nats://127.0.0.1:4222'
const instance = process.argv[3] ?? 'home'
const requestedSession = process.argv[4]
const query = process.argv[5] ?? ''

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
    JSON.stringify({ type: 'client-request', rpcId: `compat-probe-${Date.now()}`, method, payload }),
    { timeout: 8000, headers: h },
  )
  return JSON.parse(reply.string())
}

function report(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`)
  return ok
}

const results = []

const info = (await call('mobile.info', {})).result?.value
results.push(report(
  'mobile.info',
  typeof info?.pluginVersion === 'string' && Array.isArray(info?.features) && info.features.includes('plugin-inventory'),
  `${info?.pluginVersion} mobileApi=${info?.mobileApi} features=${info?.features?.length ?? 0}`,
))

const inventory = (await call('mobile.inventory', {})).result?.value
results.push(report(
  'mobile.inventory',
  typeof inventory?.managementAvailable === 'boolean',
  `managementAvailable=${inventory?.managementAvailable} entries=${inventory?.entries?.length ?? 0}`,
))

const listed = (await call('session.list', {})).result?.value
const sessionId = requestedSession
  ?? listed?.items?.find(item => typeof item?.sessionId === 'string')?.sessionId
if (sessionId === undefined) {
  report('reference.sessions', false, 'host has no session to query')
} else {
  const candidates = (await call('reference.sessions', { sessionId, query })).result?.value
  const rows = Array.isArray(candidates) ? candidates : []
  results.push(report(
    'reference.sessions',
    rows.length > 0 && rows.every(row => typeof row.displayTitle === 'string'),
    `${rows.length} candidate(s) for ${sessionId}, displayTitle=${JSON.stringify(rows[0]?.displayTitle ?? null)}`,
  ))
  // A subagent Session's display title is its own label, so the row reads as
  // the delegated task instead of as the session title.
  for (const row of rows.filter(row => row.displayTitle !== row.label)) {
    console.log(`     subagent row: displayTitle=${JSON.stringify(row.displayTitle)} label=${JSON.stringify(row.label)}`)
  }
}

await nc.drain()
process.exit(results.every(Boolean) ? 0 : 1)
