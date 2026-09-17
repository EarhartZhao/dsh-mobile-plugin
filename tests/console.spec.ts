import type { IncomingMessage, ServerResponse } from 'node:http'
import QRCode from 'qrcode'
import { describe, expect, it } from 'vitest'
import { missingHubCredentials, registerConsoleRoutes, type ConsoleBackend, type WebRouter } from '../src/console.js'
import type { Config } from '../src/config.js'

const baseConfig: Config = {
  natsUrl: 'nats://127.0.0.1:4222',
  hubWssUrl: 'wss://hub.test:8443',
  hubUser: 'c-end-dsh',
  hubPass: 'secret-pass',
  hubCaFingerprint: '',
  instanceId: 'home',
  tokenTtlDays: 90,
  pairCodeTtlSec: 120,
  maxDevices: 10,
  chunkCoalesceMs: 0,
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/** Register the console routes against a stub router so a spec can invoke one. */
function captureRoutes(
  config: Config,
  checkHub: () => Promise<{ ok: boolean, reason: string, message: string }> = () =>
    Promise.resolve({ ok: true, reason: 'ok', message: 'stubbed' }),
): Map<string, Handler> {
  const routes = new Map<string, Handler>()
  const router: WebRouter = {
    register: (route) => {
      routes.set(route.path, route.handler as Handler)
      return () => undefined
    },
  }
  const backend = {
    bridge: () => ({
      status: () => ({ connection: 'connected', pluginVersion: '0.0.0-test', mobileApi: 2, features: [] }),
      createPairingQr: () => ({
        code: 'ABCDEFGH',
        expiresAt: Date.now() + 120_000,
        payload: {
          hub: config.hubWssUrl,
          user: config.hubUser,
          pass: config.hubPass,
          instance: config.instanceId,
          caFp: '',
          code: 'ABCDEFGH',
        },
      }),
    }),
    currentConfig: () => config,
    updateConfig: () => Promise.resolve(),
    startNats: () => Promise.resolve({ ok: true, message: '' }),
    checkHub,
  } as unknown as ConsoleBackend
  registerConsoleRoutes(router, backend)
  return routes
}

/** Minimal request/response pair: only the members the console routes touch. */
function exchange(remoteAddress: string, method = 'GET'): {
  req: IncomingMessage
  res: ServerResponse
  json: () => Record<string, unknown>
  status: () => number
} {
  let text = ''
  let code = 0
  const res = {
    writeHead: (next: number) => { code = next; return res },
    end: (chunk?: unknown) => { text += typeof chunk === 'string' ? chunk : ''; return res },
  } as unknown as ServerResponse
  const req = {
    method,
    socket: { remoteAddress },
    [Symbol.asyncIterator]: async function* () { /* route bodies parse as empty */ },
  } as unknown as IncomingMessage
  return { req, res, json: () => JSON.parse(text) as Record<string, unknown>, status: () => code }
}

describe('missingHubCredentials', () => {
  it('passes only when every Hub credential is set', () => {
    expect(missingHubCredentials(baseConfig)).toBeNull()
  })

  it('names each unset credential, whitespace included', () => {
    expect(missingHubCredentials({ ...baseConfig, hubPass: '' })).toContain('密码')
    expect(missingHubCredentials({ ...baseConfig, hubUser: '  ' })).toContain('账号')
    expect(missingHubCredentials({ ...baseConfig, hubWssUrl: '', hubUser: '', hubPass: '' }))
      .toContain('Hub 地址、账号、密码')
  })
})

describe('console status route', () => {
  const configOf = (body: Record<string, unknown>): Record<string, unknown> =>
    body.config as Record<string, unknown>

  it('hands the saved password to a loopback caller so the field can show it', async () => {
    const route = captureRoutes(baseConfig).get('/mobile-bridge/api/status')!
    const call = exchange('127.0.0.1')
    await route(call.req, call.res)
    expect(configOf(call.json()).hubPass).toBe('secret-pass')
    expect(configOf(call.json()).hubPassConfigured).toBe(true)
  })

  it('withholds the password from any other peer', async () => {
    const route = captureRoutes(baseConfig).get('/mobile-bridge/api/status')!
    for (const peer of ['10.0.0.7', '::ffff:10.0.0.7']) {
      const call = exchange(peer)
      await route(call.req, call.res)
      expect(configOf(call.json()).hubPass).toBeUndefined()
      expect(configOf(call.json()).hubPassConfigured).toBe(true)
    }
  })
})

describe('console pairing route', () => {
  it('refuses to mint a QR before the Hub credentials exist', async () => {
    const route = captureRoutes({ ...baseConfig, hubPass: '' }).get('/mobile-bridge/api/pair')!
    const call = exchange('127.0.0.1', 'POST')
    await route(call.req, call.res)
    expect(call.status()).toBe(400)
    expect(String(call.json().error)).toContain('密码')
  })

  it('mints a QR once the credentials are complete', async () => {
    const route = captureRoutes(baseConfig).get('/mobile-bridge/api/pair')!
    const call = exchange('127.0.0.1', 'POST')
    await route(call.req, call.res)
    expect(call.status()).toBe(200)
    expect(String(call.json().qrSvg)).toContain('<svg')
  })

  it('leaves the spec 4-module quiet zone the camera needs to lock on', async () => {
    const route = captureRoutes(baseConfig).get('/mobile-bridge/api/pair')!
    const call = exchange('127.0.0.1', 'POST')
    await route(call.req, call.res)
    const svg = String(call.json().qrSvg)
    // The rendered viewBox is code + both quiet zones, so the margin is the
    // difference against the bare module count for the same payload.
    const side = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)![1])
    const modules = QRCode.create(JSON.stringify(call.json().payload), { errorCorrectionLevel: 'M' }).modules.size
    expect(side - modules).toBe(8)
  })

  it('refuses to mint when the Hub rejects the stored credentials', async () => {
    const route = captureRoutes(baseConfig, () =>
      Promise.resolve({ ok: false, reason: 'rejected', message: 'Hub 拒绝了这组密码' }))
      .get('/mobile-bridge/api/pair')!
    const call = exchange('127.0.0.1', 'POST')
    await route(call.req, call.res)
    expect(call.status()).toBe(400)
    expect(String(call.json().error)).toContain('拒绝了')
  })

  it('still mints, with a warning, when the Hub is merely unreachable', async () => {
    const route = captureRoutes(baseConfig, () =>
      Promise.resolve({ ok: false, reason: 'unreachable', message: '端口不通' }))
      .get('/mobile-bridge/api/pair')!
    const call = exchange('127.0.0.1', 'POST')
    await route(call.req, call.res)
    expect(call.status()).toBe(200)
    expect(String(call.json().hubWarning)).toContain('端口不通')
  })
})
