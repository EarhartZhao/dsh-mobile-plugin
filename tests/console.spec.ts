import type { IncomingMessage, ServerResponse } from 'node:http'
import QRCode from 'qrcode'
import { describe, expect, it } from 'vitest'
import { missingHubCredentials, registerConsoleRoutes, type ConsoleBackend, type WebRouter } from '../src/console.js'
import type { Config } from '../src/config.js'

const baseConfig: Config = {
  natsUrl: 'nats://127.0.0.1:4222',
  hubWssUrl: 'wss://hub.test:8443',
  hubUser: 'c-end-test',
  hubPass: 'secret-pass',
  hubCaFingerprint: '',
  instanceId: 'home',
  tokenTtlDays: 90,
  pairCodeTtlSec: 120,
  maxDevices: 10,
  chunkCoalesceMs: 0,
  natsConfigPath: '',
  autoMigrateProfile: true,
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/** Register the console routes against a stub router so a spec can invoke one. */
function captureRoutes(
  config: Config,
  checkHub: () => Promise<{ ok: boolean, reason: string, message: string }> = () =>
    Promise.resolve({ ok: true, reason: 'ok', message: 'stubbed' }),
  overrides: Partial<ConsoleBackend> = {},
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
      status: () => ({
        connection: 'connected',
        pluginVersion: '0.0.0-test',
        mobileApi: 2,
        features: [],
        profile: {
          state: 'ok',
          shape: { bundleListed: true, legacyInsert: false, overrideRow: true },
          notes: ['安装形态正常'],
        },
      }),
      listDevices: () => [],
      revokeDevice: () => Promise.resolve(true),
      forgetDevice: () => Promise.resolve(true),
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
    repairProfile: () => Promise.resolve({
      state: 'ok',
      shape: { bundleListed: true, legacyInsert: false, overrideRow: true },
      notes: ['安装形态正常'],
    }),
    checkHub,
    ...overrides,
  } as unknown as ConsoleBackend
  registerConsoleRoutes(router, backend)
  return routes
}

/**
 * Minimal request/response pair: only the members the console routes touch.
 *
 * Defaults describe the real console page on this machine — loopback socket,
 * loopback `Host`, same origin, JSON body — and a state-changing call carries
 * the console header. Pass `undefined` for a header to drop it.
 */
function exchange(
  remoteAddress: string,
  method = 'GET',
  headers: Record<string, string | undefined> = {},
  body = '',
): {
  req: IncomingMessage
  res: ServerResponse
  json: () => Record<string, unknown>
  body: () => string
  status: () => number
} {
  let text = ''
  let code = 0
  const res = {
    writeHead: (next: number) => { code = next; return res },
    end: (chunk?: unknown) => { text += typeof chunk === 'string' ? chunk : ''; return res },
  } as unknown as ServerResponse
  const merged: Record<string, string | string[] | undefined> = method === 'POST'
    ? {
        host: '127.0.0.1:3080',
        origin: 'http://127.0.0.1:3080',
        'content-type': 'application/json',
        'x-dsh-mobile-console': '1',
      }
    : { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) delete merged[name]
    else merged[name] = value
  }
  const req = {
    method,
    headers: merged,
    socket: { remoteAddress },
    [Symbol.asyncIterator]: async function* () {
      if (body !== '') yield Buffer.from(body)
    },
  } as unknown as IncomingMessage
  return {
    req,
    res,
    json: () => JSON.parse(text) as Record<string, unknown>,
    body: () => text,
    status: () => code,
  }
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

describe('console config route', () => {
  const save = async (body: Record<string, unknown>) => {
    const writes: Array<Partial<Config>> = []
    const route = captureRoutes(baseConfig, undefined, {
      updateConfig: (patch) => { writes.push(patch); return Promise.resolve() },
    }).get('/mobile-bridge/api/config')!
    const call = exchange('127.0.0.1', 'POST', {}, JSON.stringify(body))
    await route(call.req, call.res)
    expect(call.status()).toBe(200)
    return writes[0]
  }

  it('turns a bare Hub address into the wss URL the QR needs', async () => {
    // What people paste is the address on its own; the phone dials what the QR
    // carries, so the stored value has to be a real URL.
    expect(await save({ hubWssUrl: '203.0.113.10' })).toMatchObject({ hubWssUrl: 'wss://203.0.113.10:8443' })
    expect(await save({ hubWssUrl: ' 203.0.113.10:9443 ' })).toMatchObject({ hubWssUrl: 'wss://203.0.113.10:9443' })
    expect(await save({ hubWssUrl: 'wss://hub.test:8443' })).toMatchObject({ hubWssUrl: 'wss://hub.test:8443' })
  })
})

describe('console status route', () => {
  const configOf = (body: Record<string, unknown>): Record<string, unknown> =>
    body.config as Record<string, unknown>

  it('keeps the password out of the polled status response', async () => {
    const route = captureRoutes(baseConfig).get('/mobile-bridge/api/status')!
    const call = exchange('127.0.0.1')
    await route(call.req, call.res)
    expect(configOf(call.json()).hubPass).toBeUndefined()
    expect(configOf(call.json()).hubPassConfigured).toBe(true)
  })

  it('refuses a non-loopback caller outright, so the password cannot leak', async () => {
    const route = captureRoutes(baseConfig).get('/mobile-bridge/api/status')!
    for (const peer of ['10.0.0.7', '::ffff:10.0.0.7']) {
      const call = exchange(peer)
      await route(call.req, call.res)
      expect(call.status()).toBe(403)
      expect(JSON.stringify(call.json())).not.toContain('secret-pass')
    }
  })
})

describe('console reveal route', () => {
  it('hands over the stored password on demand', async () => {
    const route = captureRoutes(baseConfig).get('/mobile-bridge/api/reveal')!
    const call = exchange('127.0.0.1', 'POST')
    await route(call.req, call.res)
    expect(call.status()).toBe(200)
    expect(call.json().hubPass).toBe('secret-pass')
  })

  it('refuses a read that would hand the password out on a polled path', async () => {
    const route = captureRoutes(baseConfig).get('/mobile-bridge/api/reveal')!
    const call = exchange('127.0.0.1', 'GET')
    await route(call.req, call.res)
    expect(call.status()).toBe(405)
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

describe('console page', () => {
  it('shows the install shape and offers the repair beside the status line', async () => {
    const route = captureRoutes(baseConfig).get('/mobile-bridge')!
    const call = exchange('127.0.0.1', 'GET')
    await route(call.req, call.res)
    const html = call.body()

    expect(html).toContain('id="profileShape"')
    expect(html).toContain('id="repairBtn"')
    // The button is hidden until a status poll says a write would help.
    expect(html).toContain('id="repairBtn" class="secondary" type="button" style="margin-left:8px" hidden')
    expect(html).toContain("api('migrate', {})")
  })

  it('never writes a prefilled field straight from the status poll', async () => {
    const route = captureRoutes(baseConfig).get('/mobile-bridge')!
    const call = exchange('127.0.0.1', 'GET')
    await route(call.req, call.res)
    const html = call.body()

    // The poll fires every 5s. Assigning into these inputs erased whatever was
    // being typed — on a profile with nothing saved yet, the whole field.
    expect(html).toContain('function prefill(id, value)')
    for (const id of ['hubWssUrl', 'hubUser', 'hubCaCert', 'instanceId', 'natsConfigPath', 'natsServerPath']) {
      expect(html).toContain(`prefill('${id}'`)
      expect(html).not.toContain(`$('${id}').value =`)
    }
  })

  it('reports the install shape through the status poll', async () => {
    const route = captureRoutes(baseConfig).get('/mobile-bridge/api/status')!
    const call = exchange('127.0.0.1')
    await route(call.req, call.res)

    expect(call.json().profile).toEqual({
      state: 'ok',
      shape: { bundleListed: true, legacyInsert: false, overrideRow: true },
      notes: ['安装形态正常'],
    })
  })

  it('repairs the install shape through its own route', async () => {
    const route = captureRoutes(baseConfig).get('/mobile-bridge/api/migrate')!
    const call = exchange('127.0.0.1', 'POST')
    await route(call.req, call.res)

    expect(call.status()).toBe(200)
    expect(call.json().state).toBe('ok')
  })

  it('refuses the repair on anything but a POST', async () => {
    const route = captureRoutes(baseConfig).get('/mobile-bridge/api/migrate')!
    const call = exchange('127.0.0.1', 'GET')
    await route(call.req, call.res)
    expect(call.status()).toBe(405)
  })

  it('splits paired devices into two tabs inside a height-capped pane', async () => {
    const route = captureRoutes(baseConfig).get('/mobile-bridge')!
    const call = exchange('127.0.0.1', 'GET')
    await route(call.req, call.res)
    const html = call.body()

    // One list for live devices, one for revoked ones, with the count on each tab.
    expect(html).toContain('id="tabActive"')
    expect(html).toContain('id="tabRevoked"')
    expect(html).toContain("showDevices('revoked')")
    expect(html).toContain('id="countActive"')
    expect(html).toContain('id="countRevoked"')
    // The device list is the page's only unbounded section: it scrolls at 520px.
    expect(html).toContain('.devicePane { max-height: 520px; overflow: auto;')
    // A revoked row reports its state instead of offering the same action again.
    expect(html).toContain('没有已吊销的设备')
    // Deleting a revoked record is a one-click action: the row is already dead,
    // so there is nothing a confirmation would protect.
    expect(html).toContain('删除记录')
    expect(html).toContain('window.forgetDevice = async')
  })

  it('deletes a revoked record through its own route', async () => {
    const route = captureRoutes(baseConfig).get('/mobile-bridge/api/forget')!
    const call = exchange('127.0.0.1', 'POST')
    await route(call.req, call.res)

    expect(call.status()).toBe(200)
    expect(call.json()).toEqual({ ok: true })
  })
})

describe('console request gate', () => {
  const readPaths = [
    '/mobile-bridge/api/status',
    '/mobile-bridge/api/devices',
    '/mobile-bridge/api/hub-check',
  ]
  const writePaths = [
    '/mobile-bridge/api/config',
    '/mobile-bridge/api/pair',
    '/mobile-bridge/api/reveal',
    '/mobile-bridge/api/revoke',
    '/mobile-bridge/api/forget',
    '/mobile-bridge/api/nats/start',
    '/mobile-bridge/api/migrate',
  ]

  it('refuses every route for a peer that is not loopback', async () => {
    for (const path of [...readPaths, ...writePaths]) {
      const route = captureRoutes(baseConfig).get(path)!
      const call = exchange('10.0.0.7', path === '/mobile-bridge/api/status' ? 'GET' : 'POST')
      await route(call.req, call.res)
      expect([path, call.status()]).toEqual([path, 403])
      expect(String(call.json().error)).toBe('loopback only')
    }
  })

  it('refuses a rebinding attempt: loopback socket carrying a foreign Host', async () => {
    const route = captureRoutes(baseConfig).get('/mobile-bridge/api/status')!
    const call = exchange('127.0.0.1', 'GET', {
      host: 'evil.example:3080',
      origin: 'http://evil.example:3080',
    })
    await route(call.req, call.res)
    expect(call.status()).toBe(403)
    expect(String(call.json().error)).toBe('loopback host required')
  })

  it('refuses a cross-origin caller even from this machine', async () => {
    const route = captureRoutes(baseConfig).get('/mobile-bridge/api/status')!
    const call = exchange('127.0.0.1', 'GET', { origin: 'http://evil.example' })
    await route(call.req, call.res)
    expect(call.status()).toBe(403)
    expect(String(call.json().error)).toBe('same-origin required')
  })

  it('refuses a state change without the console header', async () => {
    for (const path of writePaths) {
      const route = captureRoutes(baseConfig).get(path)!
      const call = exchange('127.0.0.1', 'POST', { 'x-dsh-mobile-console': undefined })
      await route(call.req, call.res)
      expect([path, call.status()]).toEqual([path, 403])
      expect(String(call.json().error)).toBe('console header required')
    }
  })

  it('refuses a state change whose body is not JSON', async () => {
    const route = captureRoutes(baseConfig).get('/mobile-bridge/api/config')!
    const call = exchange('127.0.0.1', 'POST', { 'content-type': 'text/plain' })
    await route(call.req, call.res)
    expect(call.status()).toBe(415)
    expect(String(call.json().error)).toBe('application/json required')
  })
})
