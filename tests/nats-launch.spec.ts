import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { natsEndpoint, probePort } from '../src/nats-launch.js'

describe('natsEndpoint', () => {
  it('reads host and port from the configured URL', () => {
    expect(natsEndpoint('nats://127.0.0.1:4222')).toEqual({ host: '127.0.0.1', port: 4222 })
    expect(natsEndpoint('nats://leaf.internal:7422')).toEqual({ host: 'leaf.internal', port: 7422 })
  })

  it('defaults the port, and falls back to loopback for anything unparseable', () => {
    expect(natsEndpoint('nats://127.0.0.1')).toEqual({ host: '127.0.0.1', port: 4222 })
    expect(natsEndpoint('nats://127.0.0.1:not-a-port')).toEqual({ host: '127.0.0.1', port: 4222 })
    expect(natsEndpoint('not a url')).toEqual({ host: '127.0.0.1', port: 4222 })
  })
})

describe('probePort', () => {
  it('reports a listening port', async () => {
    const server = createServer(() => undefined)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    try {
      await expect(probePort('127.0.0.1', port, 1000)).resolves.toBe(true)
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()) })
    }
  })

  it('reports a closed port instead of waiting out the budget', async () => {
    await expect(probePort('127.0.0.1', 1, 1000)).resolves.toBe(false)
  })
})
