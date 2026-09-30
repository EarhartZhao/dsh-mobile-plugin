/**
 * Local NATS launch helpers: where the bridge dials, and whether that port is
 * already answering.
 *
 * "The spawn call returned" is not the answer to "did NATS start": a port that
 * another nats-server already holds makes the fresh child exit a moment later,
 * and a config the server rejects never opens the port at all. Both are visible
 * as facts about the port and the child, so the caller checks those instead.
 */
import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** Default NATS client port, used when the configured URL names none. */
const DEFAULT_NATS_PORT = 4222

/** Windows keeps its own spelling; `join` would rewrite the separators. */
const WINDOWS_LEAF_CONFIG = 'C:\\nats\\leaf.conf'
const WINDOWS_NATS_SERVER = 'C:\\nats-server\\nats-server.exe'

/**
 * The host and port the bridge dials, derived from the configured NATS URL.
 * @param natsUrl - configuration `natsUrl`, e.g. `nats://127.0.0.1:4222`.
 * @returns the endpoint to probe; loopback:4222 for anything unparseable.
 */
export function natsEndpoint(natsUrl: string): { host: string, port: number } {
  try {
    const url = new URL(natsUrl)
    const port = url.port === '' ? DEFAULT_NATS_PORT : Number(url.port)
    return {
      host: url.hostname === '' ? '127.0.0.1' : url.hostname,
      port: Number.isInteger(port) && port > 0 ? port : DEFAULT_NATS_PORT,
    }
  } catch {
    return { host: '127.0.0.1', port: DEFAULT_NATS_PORT }
  }
}

/**
 * Whether one TCP connect to the port succeeds inside the budget.
 * @param host - target host.
 * @param port - target port.
 * @param timeoutMs - connect budget; a port that swallows the SYN counts as down.
 * @returns true only on a completed TCP handshake.
 */
export function probePort(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/** Where a resolved local-NATS path came from. */
export type LocalNatsSource = 'env' | 'config' | 'default'

/** One path the launch button needs, with the discovery trail behind it. */
export interface LocalNatsResolution {
  /** The chosen path; the recommended one when nothing exists yet. */
  path: string
  /** Whether {@link path} is readable right now. */
  exists: boolean
  /** Explicit settings fail loudly; a discovery default may simply be absent. */
  source: LocalNatsSource
  /** Every path consulted, in priority order. */
  candidates: string[]
}

/** Inputs for the resolvers; every field defaults to this process. */
export interface LocalNatsInput {
  /** The matching `natsConfigPath`/`natsServerPath` field; empty means "discover it". */
  configured?: string
  /** The matching `NATS_CONFIG_PATH`/`NATS_SERVER_PATH`; wins over the field. */
  env?: string | undefined
  platform?: NodeJS.Platform
  /** User home, for `~/.nats-leaf` and `~/.config`. */
  home?: string
  /** dsh home (`$DSH_HOME`), which owns this plugin's own files. */
  dshHome?: string
  /** Injected in tests; defaults to `fs.existsSync`. */
  exists?: (path: string) => boolean
  /** PATH searched for a bare executable name; defaults to `process.env.PATH`. */
  pathEnv?: string
}

/** The layout this project's own machines use: the binary and its config together. */
const LEAF_HOME_DIR = '.nats-leaf'

/** Common inputs, with the ambient process filling in whatever was omitted. */
function resolvedInput(input: LocalNatsInput): { platform: NodeJS.Platform, home: string, dshHome: string, exists: (path: string) => boolean, pathEnv: string } {
  const home = input.home ?? homedir()
  return {
    platform: input.platform ?? process.platform,
    home,
    dshHome: input.dshHome ?? join(home, '.dsh'),
    exists: input.exists ?? existsSync,
    pathEnv: input.pathEnv ?? process.env.PATH ?? '',
  }
}

/** The explicit setting that replaces discovery, or undefined for one to discover. */
function explicitPath(input: LocalNatsInput): { path: string, source: LocalNatsSource } | undefined {
  const env = input.env?.trim()
  if (env !== undefined && env !== '') return { path: env, source: 'env' }
  const configured = input.configured?.trim()
  if (configured !== undefined && configured !== '') return { path: configured, source: 'config' }
  return undefined
}

/** First PATH directory holding `name`; undefined when PATH has no such file. */
function onPath(name: string, pathEnv: string, exists: (path: string) => boolean): string | undefined {
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, name)
    if (exists(candidate)) return candidate
  }
  return undefined
}

/** First existing candidate, or `recommended` when the machine has none yet. */
function resolve(input: LocalNatsInput, candidates: string[], recommended: string): LocalNatsResolution {
  const exists = input.exists ?? existsSync
  const found = candidates.find(candidate => exists(candidate))
  return {
    path: found ?? recommended,
    exists: found !== undefined,
    source: explicitPath(input)?.source ?? 'default',
    candidates,
  }
}

/**
 * Paths the launch button may read for the Leaf config, in priority order.
 *
 * Explicit settings (env, then the console's `natsConfigPath`) replace the list
 * instead of joining it, so a wrong path fails with the path the owner chose
 * rather than silently falling back. Without one, discovery starts at the
 * plugin's own home — `$DSH_HOME/mobile-bridge/leaf.conf`, beside `tokens.json`,
 * writable without sudo on every platform — then the layout this project's
 * machines already use (`~/.nats-leaf/leaf.conf`, beside the binary), then the
 * conventions a deployment may have: `~/.config/nats`, Homebrew's two prefixes
 * on macOS, `/etc/nats` (or `/etc/nats-server.conf`) on Linux, `C:\nats` on
 * Windows.
 * @param input - overrides for the ambient process; tests pass all of them.
 * @returns candidate paths, first match wins; never empty.
 */
export function leafConfigCandidates(input: LocalNatsInput = {}): string[] {
  const explicit = explicitPath(input)
  if (explicit !== undefined) return [explicit.path]
  const { platform, home, dshHome } = resolvedInput(input)
  const candidates = [
    join(dshHome, 'mobile-bridge', 'leaf.conf'),
    join(home, LEAF_HOME_DIR, 'leaf.conf'),
    ...(platform === 'win32'
      ? [WINDOWS_LEAF_CONFIG]
      : [join(home, '.config', 'nats', 'leaf.conf')]),
  ]
  if (platform === 'darwin') candidates.push('/opt/homebrew/etc/nats/leaf.conf', '/usr/local/etc/nats/leaf.conf')
  else if (platform !== 'win32') candidates.push('/etc/nats/leaf.conf', '/etc/nats-server.conf')
  return candidates
}

/**
 * Pick the Leaf config to launch, and say where it came from.
 * @param input - overrides for the ambient process.
 * @returns the chosen path (the recommended one when nothing exists yet), its
 * existence, which input chose it, and the full candidate list for the message.
 */
export function resolveLeafConfig(input: LocalNatsInput = {}): LocalNatsResolution {
  const candidates = leafConfigCandidates(input)
  return resolve(input, candidates, candidates[0] ?? WINDOWS_LEAF_CONFIG)
}

/**
 * Paths the launch button may run, in priority order: the two directories the
 * plugin and this project already use, Windows' conventional install, and
 * finally whatever `PATH` resolves the bare name to (the absolute hit is shown,
 * so the console never prints a name the owner cannot `ls`).
 * @param input - overrides for the ambient process.
 * @returns candidate paths, first match wins; never empty.
 */
export function natsServerCandidates(input: LocalNatsInput = {}): string[] {
  const explicit = explicitPath(input)
  if (explicit !== undefined) return [explicit.path]
  const { platform, home, dshHome, exists, pathEnv } = resolvedInput(input)
  const name = platform === 'win32' ? 'nats-server.exe' : 'nats-server'
  return [
    join(dshHome, 'mobile-bridge', name),
    join(home, LEAF_HOME_DIR, name),
    ...(platform === 'win32' ? [WINDOWS_NATS_SERVER] : []),
    onPath(name, pathEnv, exists) ?? name,
  ]
}

/**
 * Pick the executable to launch.
 * @param input - overrides for the ambient process.
 * @returns the chosen path; the bare name (meaning "put it on PATH") when none
 * of the candidates exists.
 */
export function resolveNatsServer(input: LocalNatsInput = {}): LocalNatsResolution {
  const { platform } = resolvedInput(input)
  return resolve(input, natsServerCandidates(input), platform === 'win32' ? 'nats-server.exe' : 'nats-server')
}
