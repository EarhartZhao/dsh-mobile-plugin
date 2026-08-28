/** Minimal control: does nats request-reply work at all under vitest? */
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, headers, type NatsConnection } from 'nats'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { RpcBridge, TOKEN_HEADER } from '../src/bridge.js'
import { TokenStore } from '../src/tokens.js'

const PORT = 15500 + Math.floor(Math.random() * 500)
const URL = `nats://127.0.0.1:${PORT}`

let server: ChildProcess
let a: NatsConnection
let b: NatsConnection

beforeAll(async () => {
  server = spawn('nats-server', ['-p', String(PORT)], { stdio: 'ignore' })
  await new Promise(r => setTimeout(r, 1200))
  a = await connect({ servers: URL })
  b = await connect({ servers: URL })
}, 15000)

afterAll(async () => {
  await b?.drain()
  await a?.drain()
  server?.kill()
})

it('echo works', async () => {
  const sub = a.subscribe('smoke.echo')
  void (async () => {
    for await (const msg of sub) msg.respond(new TextEncoder().encode('pong'))
  })()
  await a.flush() // make the SUB reach the server before the requester publishes
  const reply = await b.request('smoke.echo', 'ping', { timeout: 3000 })
  expect(reply.string()).toBe('pong')
})

it('echo works when the request carries an (empty) headers object', async () => {
  const sub = a.subscribe('smoke.echo2')
  void (async () => {
    for await (const msg of sub) msg.respond(new TextEncoder().encode('pong2'))
  })()
  await a.flush()
  const reply = await b.request('smoke.echo2', 'ping', { timeout: 3000, headers: headers() })
  expect(reply.string()).toBe('pong2')
})

it('echo works with an explicit per-request inbox', async () => {
  const sub = a.subscribe('smoke.echo3')
  void (async () => {
    for await (const msg of sub) msg.respond(new TextEncoder().encode('pong3'))
  })()
  await a.flush()
  const inbox = `_INBOX.smoke.${crypto.randomUUID()}`
  const replySub = b.subscribe(inbox, { max: 1 })
  await b.flush()
  b.publish('smoke.echo3', 'ping', { reply: inbox })
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('reply timeout')), 3000))
  const reply = await Promise.race([(async () => {
    for await (const msg of replySub) return msg
    throw new Error('closed')
  })(), timeout])
  expect(reply.string()).toBe('pong3')
})

it('RpcBridge replies resolve on an explicit inbox', async () => {
  const tokens = new TokenStore(join(tmpdir(), `smoke-tokens-${crypto.randomUUID()}.json`))
  await tokens.load()
  const carrier = {
    fetch: (async () => new Response(JSON.stringify({ type: 'server-response', rpcId: 'x', result: { ok: true, value: {} } }))) as typeof fetch,
  }
  const bridge = new RpcBridge(a, {
    instanceId: 'smoke', carrier, tokens, tokenTtlDays: 90, maxDevices: 10, onHello: () => {},
  })
  bridge.start()
  await a.flush()

  const inbox = `_INBOX.smoke.${crypto.randomUUID()}`
  const replySub = b.subscribe(inbox, { max: 1 })
  await b.flush()
  const h = headers()
  b.publish('svc.dsh.smoke.session.list', JSON.stringify({ type: 'client-request', rpcId: 'x1', method: 'session.list', payload: {} }), { reply: inbox, headers: h })
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('reply timeout')), 3000))
  const reply = await Promise.race([(async () => {
    for await (const msg of replySub) return msg
    throw new Error('closed')
  })(), timeout])
  expect(JSON.parse(reply.string()).result.error.message).toBe('mobile-unauthenticated')
})
