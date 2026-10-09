import type { IncomingMessage, ServerResponse } from 'node:http'
import QRCode from 'qrcode'
import { describe, expect, it } from 'vitest'
import { missingHubCredentials, registerConsoleRoutes, versionDrift, type ConsoleBackend, type WebRouter } from '../src/console.js'
import type { Config } from '../src/config.js'

const baseConfig: Config = {
  enabled: true,
  natsUrl: 'nats://127.0.0.1:4222',
  hubWssUrl: 'wss://hub.test:8443',
  hubUser: 'c-end-test',
  hubPass: 'secret-pass',
  hubCaCert: '',
  hubCaFingerprint: '',
  instanceId: 'home',
  instanceName: '',
  tokenTtlDays: 90,
  pairCodeTtlSec: 120,
  maxDevices: 10,
  chunkCoalesceMs: 0,
  natsConfigPath: '',
  natsServerPath: '',
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

describe('versionDrift', () => {
  it('names both versions when the disk is ahead of the running process', () => {
    const line = versionDrift('0.2.28', '0.2.31')!
    expect(line).toContain('0.2.31')
    expect(line).toContain('0.2.28')
  })

  it('is silent when the process already runs what is on disk', () => {
    expect(versionDrift('0.2.31', '0.2.31')).toBeNull()
  })

  it('is silent when the disk version is unknown, absent or blank', () => {
    expect(versionDrift('0.2.31', null)).toBeNull()
    expect(versionDrift('0.2.31', undefined)).toBeNull()
    expect(versionDrift('0.2.31', '   ')).toBeNull()
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

  it('accepts the runtime switch as a boolean config field', async () => {
    expect(await save({ enabled: false })).toEqual({ enabled: false })
    expect(await save({ enabled: 'false' })).toEqual({})
  })
})

describe('console status route', () => {
  const configOf = (body: Record<string, unknown>): Record<string, unknown> =>
    body.config as Record<string, unknown>

  /** A bridge whose reported versions the caller picks. */
  const reporting = (versions: Record<string, unknown>): Partial<ConsoleBackend> => ({
    bridge: () => ({
      status: () => ({
        connection: 'connected',
        mobileApi: 2,
        features: [],
        profile: { state: 'ok', shape: { bundleListed: true, legacyInsert: false, overrideRow: true }, notes: [] },
        ...versions,
      }),
    }),
  }) as unknown as Partial<ConsoleBackend>

  it('says when the installed version is not the running one, and how to close the gap', async () => {
    // The upgrade landed on disk while the process kept its boot-time module
    // generation: nothing else on any surface says a restart is outstanding.
    const route = captureRoutes(baseConfig, undefined, reporting({ pluginVersion: '0.2.28', installedVersion: '0.2.31' })).get('/mobile-bridge/api/status')!
    const call = exchange('127.0.0.1')
    await route(call.req, call.res)

    const drift = call.json().versionDrift as string
    expect(drift).toContain('0.2.31')
    expect(drift).toContain('0.2.28')
    expect(drift).toContain('重启 dsh')
  })

  it('stays quiet when the versions agree', async () => {
    const route = captureRoutes(baseConfig, undefined, reporting({ pluginVersion: '0.2.31', installedVersion: '0.2.31' })).get('/mobile-bridge/api/status')!
    const call = exchange('127.0.0.1')
    await route(call.req, call.res)
    expect(call.json().versionDrift).toBeNull()
  })

  it('stays quiet when the disk version is unknown', async () => {
    // A profile that cannot be read is not evidence of a stale process.
    const route = captureRoutes(baseConfig, undefined, reporting({ pluginVersion: '0.2.31', installedVersion: null })).get('/mobile-bridge/api/status')!
    const call = exchange('127.0.0.1')
    await route(call.req, call.res)
    expect(call.json().versionDrift).toBeNull()
  })

  it('keeps the password out of the polled status response', async () => {
    const route = captureRoutes(baseConfig).get('/mobile-bridge/api/status')!
    const call = exchange('127.0.0.1')
    await route(call.req, call.res)
    expect(configOf(call.json()).hubPass).toBeUndefined()
    expect(configOf(call.json()).hubPassConfigured).toBe(true)
    expect(configOf(call.json()).enabled).toBe(true)
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

  it('reports local NATS runtime state alongside the path readout', async () => {
    const route = captureRoutes(baseConfig, undefined, {
      localNatsStatus: () => Promise.resolve({
        running: true,
        managed: true,
        endpoint: '127.0.0.1:4222',
        message: '本机 NATS 正在运行（由本插件启动，127.0.0.1:4222）',
      }),
    }).get('/mobile-bridge/api/status')!
    const call = exchange('127.0.0.1')
    await route(call.req, call.res)
    expect(call.json().localNatsRuntime).toEqual({
      running: true,
      managed: true,
      endpoint: '127.0.0.1:4222',
      message: '本机 NATS 正在运行（由本插件启动，127.0.0.1:4222）',
    })
  })

  it('leaves local NATS runtime null when the backend cannot probe', async () => {
    const route = captureRoutes(baseConfig).get('/mobile-bridge/api/status')!
    const call = exchange('127.0.0.1')
    await route(call.req, call.res)
    expect(call.json().localNatsRuntime).toBeNull()
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
  const report = {
    current: '0.2.24',
    spec: 'github:EarhartZhao/dsh-mobile-plugin',
    repo: 'EarhartZhao/dsh-mobile-plugin',
    latest: '0.2.25',
    newer: true,
    updatable: true,
    reason: null,
    checkedAt: '2026-10-05T00:00:00.000Z',
    phase: 'idle',
    message: '发现新版本 0.2.25。',
  }

  it('shows only the refresh button until a check finds a newer version', async () => {
    const route = captureRoutes(baseConfig).get('/mobile-bridge')!
    const call = exchange('127.0.0.1', 'GET')
    await route(call.req, call.res)
    const html = call.body()

    expect(html).toContain('id="updateCheckBtn"')
    // The update button is hidden in the markup and only revealed by a check,
    // so a fresh page never offers an update it has not found.
    expect(html).toContain('id="updateApplyBtn" hidden')
    expect(html).toContain("api('update/check')")
    expect(html).toContain("api('update/apply', {})")
  })

  it('checks the newest version through its own route', async () => {
    const route = captureRoutes(baseConfig, undefined, { checkUpdate: () => Promise.resolve(report) })
      .get('/mobile-bridge/api/update/check')!
    const call = exchange('127.0.0.1', 'GET')
    await route(call.req, call.res)

    expect(call.status()).toBe(200)
    expect(call.json()).toMatchObject({ latest: '0.2.25', updatable: true })
  })

  it('installs the newest version through its own route', async () => {
    const route = captureRoutes(baseConfig, undefined, {
      applyUpdate: () => Promise.resolve({ ...report, newer: false, updatable: false, phase: 'restart-required', message: '重启 dsh 后生效' }),
    }).get('/mobile-bridge/api/update/apply')!
    const call = exchange('127.0.0.1', 'POST')
    await route(call.req, call.res)

    expect(call.status()).toBe(200)
    expect(call.json().phase).toBe('restart-required')
  })

  it('answers a failed update with a 400 and the reason', async () => {
    const route = captureRoutes(baseConfig, undefined, {
      applyUpdate: () => Promise.resolve({ ...report, phase: 'failed', message: '更新失败：pnpm 退出 1' }),
    }).get('/mobile-bridge/api/update/apply')!
    const call = exchange('127.0.0.1', 'POST')
    await route(call.req, call.res)

    expect(call.status()).toBe(400)
    expect(String(call.json().message)).toContain('pnpm')
  })

  it('keeps the install shape and repair in the advanced section', async () => {
    const route = captureRoutes(baseConfig).get('/mobile-bridge')!
    const call = exchange('127.0.0.1', 'GET')
    await route(call.req, call.res)
    const html = call.body()

    expect(html).toContain('<details class="advanced">')
    expect(html).toContain('id="profileShape"')
    expect(html).toContain('id="repairBtn"')
    // The button is hidden until a status poll says a write would help.
    expect(html).toContain('id="repairBtn" class="secondary" type="button" hidden')
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
    for (const id of ['hubWssUrl', 'hubUser', 'hubCaCert', 'instanceName', 'natsConfigPath', 'natsServerPath']) {
      expect(html).toContain(`prefill('${id}'`)
    }
    for (const id of ['hubWssUrl', 'hubUser', 'instanceName', 'natsConfigPath', 'natsServerPath']) {
      expect(html).not.toContain(`$('${id}').value =`)
    }
    // The CA field has exactly one deliberate writer — the fetch button — and
    // it marks the field edited first, so the poll that follows leaves what the
    // Hub handed over alone instead of pasting the stored (empty) value back.
    expect(html).toContain("editedFields.add('hubCaCert')")
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
    // The device list is the page's only unbounded section: it scrolls inside
    // a fixed pane so a long token ledger cannot push maintenance out of reach.
    expect(html).toContain('.devicePane { max-height: 420px; overflow: auto;')
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

  it('offers the Hub CA fetch beside the certificate field', async () => {
    const route = captureRoutes(baseConfig).get('/mobile-bridge')!
    const call = exchange('127.0.0.1', 'GET')
    await route(call.req, call.res)
    const html = call.body()

    expect(html).toContain('id="fetchCaBtn"')
    expect(html).toContain("api('hub-ca/fetch', {})")
    // Pasting ca.crt on every machine is the step this exists to remove, so
    // the empty-field hint has to point at the button rather than only at the
    // file an owner may not have on that machine.
    expect(html).toContain('从 Hub 获取 CA')
  })

  it('makes room for the version gap beside the running version', async () => {
    // The warning is worthless if the poll has nowhere to put it, so the slot
    // and the line that fills it are part of the page's contract.
    const route = captureRoutes(baseConfig).get('/mobile-bridge')!
    const call = exchange('127.0.0.1', 'GET')
    await route(call.req, call.res)
    const html = call.body()

    expect(html).toContain('id="versionDrift"')
    expect(html).toContain("$('versionDrift').textContent = s.versionDrift || ''")
  })

  it('answers "where does ca.crt come from" for a brand-new owner', async () => {
    // Every other hint here assumes a Hub and a ca.crt already exist. Someone
    // standing up their own Hub needs to be told that the CA is theirs to
    // create, that its private half never leaves the admin machine, and where
    // the from-zero steps are.
    const route = captureRoutes(baseConfig).get('/mobile-bridge')!
    const call = exchange('127.0.0.1', 'GET')
    await route(call.req, call.res)
    const html = call.body()

    expect(html).toContain('还不知道 ca.crt 该从哪来？')
    expect(html).toContain('ca.key 留在管理机、绝不进服务器')
    expect(html).toContain('docs/03-nats-self-host.md')
    expect(html).toContain('href="https://github.com/EarhartZhao/dsh-mobile-plugin/blob/master/docs/03-nats-self-host.md"')
    // The empty-field hint has to hand the reader over to that line.
    expect(html).toContain('连 ca.crt 都还没有？看下面那一行')
  })

  it('points a machine with no local NATS at the install checklist', async () => {
    // The button only launches what is already installed; a machine that has
    // neither the binary nor the config needs a way out of that state, and the
    // one written for an AI assistant to execute is docs/04.
    const route = captureRoutes(baseConfig).get('/mobile-bridge')!
    const call = exchange('127.0.0.1', 'GET')
    await route(call.req, call.res)
    const html = call.body()

    expect(html).toContain('id="natsHelpLine"')
    expect(html).toContain('href="https://github.com/EarhartZhao/dsh-mobile-plugin/blob/master/docs/04-ai-onboarding.md"')
    expect(html).toContain('这个按钮只启动<b>已经装好</b>的本机 NATS')
    // Naming what is missing is only useful if it also hands over to that line.
    expect(html).toContain("lines.push('缺 ' + missing.join(' 和 ')")
  })

  it('orders the first run: Hub credential and CA, then the local NATS, then the QR', async () => {
    // The two things first-run owners kept failing to find — the Hub's CA
    // certificate and the button that starts the local NATS — now sit before
    // the QR that cannot work without them, and neither is behind a disclosure
    // whose name says something else.
    const route = captureRoutes(baseConfig).get('/mobile-bridge')!
    const call = exchange('127.0.0.1', 'GET')
    await route(call.req, call.res)
    const html = call.body()
    const at = (needle: string): number => html.indexOf(needle)

    expect(at('id="setupChecklist"')).toBeGreaterThan(-1)
    expect(at('id="setupChecklist"')).toBeLessThan(at('id="hubWssUrl"'))
    expect(at('id="hubCaCert"')).toBeLessThan(at('id="saveBtn"'))
    expect(at('id="startNatsBtn"')).toBeLessThan(at('id="pairBtn"'))
    // The certificate is a labelled field of the Hub form, not a footnote in
    // the instance block it used to live in.
    expect(html).toContain('<label for="hubCaCert">Hub CA 证书</label>')
    expect(html).not.toContain('<summary>实例与证书</summary>')
    // The launch button left the advanced block, and the copy that explains a
    // machine without a local NATS travelled with it.
    expect(html).toContain('<h2 id="natsTitle">2. 本机 NATS（Leaf）</h2>')
    expect(at('id="natsTitle"')).toBeLessThan(at('id="startNatsBtn"'))
    expect(at('id="startNatsBtn"')).toBeLessThan(at('id="pairTitle"'))
  })

  it('ticks the checklist off as each first-run step lands', async () => {
    const route = captureRoutes(baseConfig).get('/mobile-bridge')!
    const call = exchange('127.0.0.1', 'GET')
    await route(call.req, call.res)
    const html = call.body()

    expect(html).toContain('function renderSetup(s)')
    expect(html).toContain("item.dataset.state = ready ? 'done' : (optional ? 'optional' : 'todo')")
    expect(html).toContain("mark('setupHub', hubReady, false, 'Hub 凭证', '去填写')")
    expect(html).toContain("mark('setupNats', natsReady, false, '本机 NATS', '去启动')")
    expect(html).toContain("summary.textContent = pending.length === 0")
    expect(html).toContain('renderSetup(s)')
    // A Hub with a publicly signed certificate has no ca.crt to find, so that
    // row is the one that must not hold the checklist back.
    expect(html).toContain("mark('setupCa', caReady, true, 'CA 证书', '去获取')")
    // Once a row is done its link stops offering the action it already got.
    expect(html).toContain("if (jump) jump.textContent = ready ? '查看' : action")
  })

  it('shows the generated instance id as a value, with no way to type over it', async () => {
    const route = captureRoutes(baseConfig).get('/mobile-bridge')!
    const call = exchange('127.0.0.1', 'GET')
    await route(call.req, call.res)
    const html = call.body()

    // The id is generated per install and is what the phone dials, so the page
    // reports it instead of offering a field: a typo here silently moves the
    // machine to another namespace and every paired phone stops answering.
    expect(html).toContain('<p class="readOnly" id="instanceIdValue">')
    expect(html).not.toContain('<input id="instanceId"')
    expect(html).not.toContain("$('instanceId').value")
    expect(html).toContain("$('instanceIdValue').textContent = (s.instanceId || '—')")
    expect(html).toContain("'（本次安装自动生成）'")
    expect(html).toContain("'（profile 里手写覆盖）'")
    expect(html).toContain('$DSH_HOME/mobile-bridge/instances.json')
    // Saving must not carry the field either: the route merges, so leaving it
    // out is what keeps an older hand-written id in place.
    expect(html).not.toContain("instanceId: $('instanceId')")
  })

  it('dials the resolved namespace when the config field is empty', async () => {
    // `instanceId: ''` means "auto": the generated value lives in the plugin's
    // own store, so a check that fell back to the empty config would dial
    // `svc.dsh..pair` and report the Hub as broken.
    const seen: string[] = []
    const route = captureRoutes(
      { ...baseConfig, instanceId: '' },
      (config: Config) => {
        seen.push(config.instanceId)
        return Promise.resolve({ ok: true, reason: 'ok', message: 'stubbed', steps: [] })
      },
      { instanceId: () => 'n4q7x82b' },
    ).get('/mobile-bridge/api/hub-check')!
    const call = exchange('127.0.0.1', 'GET')
    await route(call.req, call.res)

    expect(seen).toEqual(['n4q7x82b'])
  })

  it('hands the certificate it fetched to the page, unmodified', async () => {
    const pem = '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n'
    const route = captureRoutes(baseConfig, undefined, {
      fetchHubCa: () => Promise.resolve({
        ok: true,
        reason: 'ok' as const,
        ca: {
          pem,
          base64: 'AA==',
          fingerprint: 'AB:CD',
          subject: 'CN=hub.test',
          validTo: '2036-09-27',
          isCa: true,
        },
        message: '已从 hub.test:8443 取到 CA',
      }),
    }).get('/mobile-bridge/api/hub-ca/fetch')!
    const call = exchange('127.0.0.1', 'GET')
    await route(call.req, call.res)

    expect(call.status()).toBe(200)
    expect(call.json()).toMatchObject({ ok: true, ca: { pem, fingerprint: 'AB:CD' } })
  })
})

describe('console request gate', () => {
  const readPaths = [
    '/mobile-bridge/api/status',
    '/mobile-bridge/api/devices',
    '/mobile-bridge/api/hub-check',
    '/mobile-bridge/api/hub-ca/fetch',
    '/mobile-bridge/api/update/check',
  ]
  const writePaths = [
    '/mobile-bridge/api/config',
    '/mobile-bridge/api/pair',
    '/mobile-bridge/api/reveal',
    '/mobile-bridge/api/revoke',
    '/mobile-bridge/api/forget',
    '/mobile-bridge/api/nats/start',
    '/mobile-bridge/api/migrate',
    '/mobile-bridge/api/update/apply',
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
