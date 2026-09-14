/**
 * Change-stream probe: arms `file.watch` for one Session against a live host and
 * reports the `workspace-files/*` frames the bridge forwards onto the host
 * subject.
 *
 * The host feeds this stream from its own instrumented filesystem operations
 * (`fs/observed`); it does not watch the operating system. A write made by this
 * probe's plain `writeFileSync` therefore produces no frame — only harness-side
 * writes (agent file tools) do. What the probe proves is the half the bridge
 * owns: the stream opens, `ready` is forwarded, and closing it is clean.
 *
 * Usage:
 *   pnpm run build
 *   node scripts/watch-probe.mjs [natsUrl] [instanceId] [scratchPath]
 *
 * Token: DSH_MOBILE_TOKEN or DSH_MOBILE_TOKEN_FILE (same as scripts/fake-app.mjs).
 * Defaults: nats://127.0.0.1:4222, instance 'home', scratch '<cwd>/watch-probe.tmp'.
 */
import { connect, headers } from 'nats'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const natsUrl = process.argv[2] ?? 'nats://127.0.0.1:4222'
const instance = process.argv[3] ?? 'home'
const scratchPath = resolve(process.argv[4] ?? 'watch-probe.tmp')

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
    JSON.stringify({ type: 'client-request', rpcId: `probe-${Date.now()}`, method, payload }),
    { timeout: 8000, headers: h },
  )
  return JSON.parse(reply.string())
}

const sessions = await call('session.list', {})
const sessionId = sessions.result?.value?.items?.[0]?.sessionId
if (sessionId === undefined) {
  console.error('no session to scope the watch; run the app once or create a session')
  await nc.drain()
  process.exit(1)
}

const frames = []
const sub = nc.subscribe(`evt.dsh.${instance}.host`)
;(async () => {
  for await (const msg of sub) {
    const frame = JSON.parse(msg.string())?.payload
    if (frame?.type !== 'host/remote-event') continue
    if (typeof frame.event !== 'string' || !frame.event.startsWith('workspace-files/')) continue
    frames.push(frame)
    console.log('[frame]', frame.event, JSON.stringify(frame.args))
  }
})()

const watching = await call('file.watch', { sessionId })
console.log('file.watch ->', JSON.stringify(watching.result?.value ?? watching.result?.error))

// Touch one scratch file inside the Session workspace so the host observes a write.
console.log('touching', scratchPath)
writeFileSync(scratchPath, 'watch probe\n', 'utf8')
await new Promise(r => setTimeout(r, 1500))
rmSync(scratchPath, { force: true })
await new Promise(r => setTimeout(r, 1500))

const released = await call('file.unwatch', { sessionId })
console.log('file.unwatch ->', JSON.stringify(released.result?.value ?? released.result?.error))

const ready = frames.filter(frame => frame.event === 'workspace-files/ready')
const changes = frames.filter(frame => frame.event === 'workspace-files/change')
const errors = frames.filter(frame => frame.event === 'workspace-files/watch-error')
console.log(`summary: ready=${ready.length} change=${changes.length} error=${errors.length}`)
if (changes.length === 0) {
  console.log('note: no change frame; the host reports only instrumented writes, not this plain file write')
}
console.log(ready.length === 1 && errors.length === 0
  ? 'change-stream OK (armed, ready forwarded, released)'
  : 'change-stream FAILED')

sub.unsubscribe()
await nc.drain()
process.exit(ready.length === 1 && errors.length === 0 ? 0 : 1)
