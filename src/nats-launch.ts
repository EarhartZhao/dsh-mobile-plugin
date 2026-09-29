/**
 * Local NATS launch helpers: where the bridge dials, and whether that port is
 * already answering.
 *
 * "The spawn call returned" is not the answer to "did NATS start": a port that
 * another nats-server already holds makes the fresh child exit a moment later,
 * and a config the server rejects never opens the port at all. Both are visible
 * as facts about the port and the child, so the caller checks those instead.
 */
import { createConnection } from 'node:net'

/** Default NATS client port, used when the configured URL names none. */
const DEFAULT_NATS_PORT = 4222

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
