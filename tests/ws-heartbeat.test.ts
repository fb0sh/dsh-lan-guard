/**
 * Upstream heartbeat-answering tests.
 *
 * The whole point of this module is a *measured* upstream behaviour: DSH pings
 * every WebSocket client every 2 s and terminates the socket once two pings go
 * unanswered, so a phone that stops running its page loses the session socket
 * after 6 s. These tests pin the observer's parsing (fragmentation, masking,
 * garbage) and the behaviour that matters end to end: the tunnel survives a
 * client that never sends a Pong, but only when the answerer is on.
 */
import { connect, type Socket } from 'node:net'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { noopLogger } from '../src/log.ts'
import { startProxy, type RunningProxy } from '../src/proxy.ts'
import { UpstreamAuth } from '../src/upstream-auth.ts'
import {
  MAX_CONTROL_PAYLOAD,
  PING_OPCODE,
  PONG_OPCODE,
  createUpstreamPingAnswerer,
  maskedFrame,
} from '../src/ws-heartbeat.ts'

/** Build one server→client frame (unmasked unless asked otherwise). */
function serverFrame(
  opcode: number,
  payload: Buffer,
  options: { fin?: boolean; masked?: boolean } = {},
): Buffer {
  const fin = options.fin === false ? 0 : 0x80
  const masked = options.masked === true
  const header = payload.length <= 125
    ? Buffer.from([fin | (opcode & 0x0f), (masked ? 0x80 : 0) | payload.length])
    : Buffer.from([fin | (opcode & 0x0f), (masked ? 0x80 : 0) | 126, payload.length >> 8, payload.length & 0xff])
  if (!masked) return Buffer.concat([header, payload])
  const mask = Buffer.from([9, 8, 7, 6])
  const body = Buffer.from(payload)
  for (let index = 0; index < body.length; index += 1) {
    body[index] = (body[index] ?? 0) ^ (mask[index % 4] ?? 0)
  }
  return Buffer.concat([header, mask, body])
}

/** Decode one client→server (masked, short) frame. */
function decodeClientFrame(frame: Buffer): { opcode: number; payload: Buffer } {
  const opcode = (frame[0] ?? 0) & 0x0f
  const length = (frame[1] ?? 0) & 0x7f
  expect((frame[1] ?? 0) & 0x80).toBe(0x80)
  expect(length).toBeLessThan(126)
  const mask = frame.subarray(2, 6)
  const payload = Buffer.from(frame.subarray(6, 6 + length))
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0)
  }
  return { opcode, payload }
}

describe('createUpstreamPingAnswerer', () => {
  it('answers one Ping with a masked Pong carrying the same payload', () => {
    const sent: Buffer[] = []
    const answerer = createUpstreamPingAnswerer({ send: frame => sent.push(frame), logger: noopLogger })

    answerer.observe(serverFrame(PING_OPCODE, Buffer.from('hb')))

    expect(sent).toHaveLength(1)
    const pong = decodeClientFrame(sent[0] as Buffer)
    expect(pong.opcode).toBe(PONG_OPCODE)
    expect(pong.payload.toString()).toBe('hb')
    expect(answerer.stats()).toMatchObject({ frames: 1, pings: 1, answered: 1, payloadBytes: 2 })
  })

  it('answers a Ping whose bytes are split across arbitrary chunks', () => {
    const sent: Buffer[] = []
    const answerer = createUpstreamPingAnswerer({ send: frame => sent.push(frame), logger: noopLogger })
    const stream = Buffer.concat([
      serverFrame(0x1, Buffer.from('hello world')),
      serverFrame(PING_OPCODE, Buffer.from('xyz')),
    ])

    for (const byte of stream) answerer.observe(Buffer.from([byte]))

    expect(sent).toHaveLength(1)
    expect(decodeClientFrame(sent[0] as Buffer).payload.toString()).toBe('xyz')
    expect(answerer.stats()).toMatchObject({ frames: 2, pings: 1, answered: 1 })
  })

  it('never answers a data frame, and walks an extended-length frame', () => {
    const sent: Buffer[] = []
    const answerer = createUpstreamPingAnswerer({ send: frame => sent.push(frame), logger: noopLogger })

    answerer.observe(serverFrame(0x2, Buffer.alloc(200, 7)))
    expect(sent).toHaveLength(0)
    expect(answerer.active()).toBe(true)
    expect(answerer.stats().frames).toBe(1)
    expect(answerer.stats().pings).toBe(0)

    answerer.observe(serverFrame(PING_OPCODE, Buffer.alloc(0)))
    expect(sent).toHaveLength(1)
    expect(answerer.stats().pings).toBe(1)
  })

  it('unmasks a masked Ping before answering (defensive)', () => {
    const sent: Buffer[] = []
    const answerer = createUpstreamPingAnswerer({ send: frame => sent.push(frame), logger: noopLogger })
    answerer.observe(serverFrame(PING_OPCODE, Buffer.from('m'), { masked: true }))
    expect(decodeClientFrame(sent[0] as Buffer).payload.toString()).toBe('m')
  })

  it('disables itself on an absurd declared length instead of buffering', () => {
    const sent: Buffer[] = []
    const answerer = createUpstreamPingAnswerer({
      send: frame => sent.push(frame),
      logger: noopLogger,
      maxFrameBytes: 1024,
    })
    answerer.observe(Buffer.from([0x81, 127, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]))
    expect(answerer.active()).toBe(false)
    answerer.observe(serverFrame(PING_OPCODE, Buffer.from('nope')))
    expect(sent).toHaveLength(0)
  })

  it('keeps a legal 125-byte Ping intact', () => {
    const sent: Buffer[] = []
    const answerer = createUpstreamPingAnswerer({ send: frame => sent.push(frame), logger: noopLogger })
    const payload = Buffer.alloc(MAX_CONTROL_PAYLOAD, 42)
    answerer.observe(serverFrame(PING_OPCODE, payload))
    expect(decodeClientFrame(sent[0] as Buffer).payload.equals(payload)).toBe(true)
  })

  it('builds a masked control frame and refuses an oversized one', () => {
    const frame = maskedFrame(PONG_OPCODE, Buffer.from('ab'), Buffer.from([1, 2, 3, 4]))
    expect(decodeClientFrame(frame).payload.toString()).toBe('ab')
    expect(() => maskedFrame(PONG_OPCODE, Buffer.alloc(126), Buffer.from([1, 2, 3, 4]))).toThrow(RangeError)
  })
})

/**
 * End-to-end against a fake upstream that pings and reaps exactly like the real
 * host. The client below never answers a Ping — what a suspended phone does.
 */
describe('proxy heartbeat answering (end-to-end)', () => {
  let server: Server | undefined
  let proxies: RunningProxy[] = []

  afterEach(async () => {
    for (const running of proxies) await running.close()
    proxies = []
    await new Promise<void>((resolve) => {
      if (server === undefined) return resolve()
      server.closeAllConnections?.()
      server.close(() => resolve())
    })
    server = undefined
  })

  /** Start an upstream that pings like DSH and destroys silent sockets like DSH. */
  async function heartbeatingUpstream(options: { intervalMs: number; maxMissed: number }): Promise<{
    origin: string
    authenticatedUrl: (baseUrl: string) => string
    reaped: () => number
  }> {
    let reaped = 0
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://fake.invalid')
      if (url.searchParams.getAll('token').length > 0) {
        res.writeHead(303, {
          location: './',
          'set-cookie': 'dsh-auth-fake=v1.payload.sig; Max-Age=3600; Path=/; HttpOnly',
        })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><head></head><body>upstream</body></html>')
    })
    server.on('upgrade', (req, socket: Socket) => {
      const key = String(req.headers['sec-websocket-key'] ?? '')
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n'
        + `sec-websocket-accept: ${key}\r\n\r\n`,
      )
      let missed = 0
      const timer = setInterval(() => {
        if (missed >= options.maxMissed) {
          reaped += 1
          clearInterval(timer)
          socket.destroy()
          return
        }
        missed += 1
        socket.write(serverFrame(PING_OPCODE, Buffer.alloc(0)))
      }, options.intervalMs)
      socket.on('data', (chunk: Buffer) => {
        // A masked Pong is what resets the real host's missed counter.
        let cursor = 0
        while (cursor + 6 <= chunk.length) {
          const opcode = (chunk[cursor] ?? 0) & 0x0f
          const masked = ((chunk[cursor + 1] ?? 0) & 0x80) !== 0
          const length = (chunk[cursor + 1] ?? 0) & 0x7f
          if (opcode === PONG_OPCODE && masked) missed = 0
          cursor += 2 + (masked ? 4 : 0) + length
        }
      })
      socket.on('close', () => clearInterval(timer))
      socket.on('error', () => socket.destroy())
    })
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject)
      server?.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const authority = `127.0.0.1:${String(address.port)}`
    return {
      origin: `http://${authority}`,
      authenticatedUrl: (baseUrl: string) => `${baseUrl}?token=fake-launch-token`,
      reaped: () => reaped,
    }
  }

  /** Open a raw upgrade against the proxy and resolve once the 101 arrived. */
  async function rawUpgrade(port: number): Promise<Socket> {
    const socket = connect(port, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    socket.write(
      'GET /api/remote.mux HTTP/1.1\r\nhost: 127.0.0.1\r\nupgrade: websocket\r\nconnection: Upgrade\r\n'
      + 'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\n\r\n',
    )
    await new Promise<void>((resolve) => socket.once('data', () => resolve()))
    return socket
  }

  it('reaps a silent client without the answerer, and keeps it alive with it', async () => {
    const upstream = await heartbeatingUpstream({ intervalMs: 40, maxMissed: 2 })

    const bare = await startProxy({
      listenHost: '127.0.0.1',
      listenPort: 0,
      upstreamOrigin: upstream.origin,
      auth: new UpstreamAuth({ origin: upstream.origin, authenticatedUrl: upstream.authenticatedUrl }),
      logger: noopLogger,
    })
    proxies.push(bare)
    const silentOff = await rawUpgrade(bare.port)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the upstream never reaped the silent client')), 2_000)
      silentOff.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    expect(upstream.reaped()).toBeGreaterThan(0)
    await bare.close()
    proxies = []

    const guarded = await startProxy({
      listenHost: '127.0.0.1',
      listenPort: 0,
      upstreamOrigin: upstream.origin,
      auth: new UpstreamAuth({ origin: upstream.origin, authenticatedUrl: upstream.authenticatedUrl }),
      answerHeartbeat: true,
      logger: noopLogger,
    })
    proxies.push(guarded)
    const reapedBefore = upstream.reaped()
    const silentOn = await rawUpgrade(guarded.port)
    let closed = false
    silentOn.once('close', () => { closed = true })

    await new Promise(resolve => setTimeout(resolve, 600))

    expect(closed).toBe(false)
    expect(upstream.reaped()).toBe(reapedBefore)
    expect(guarded.stats().heartbeatAnswered).toBeGreaterThanOrEqual(5)
    silentOn.destroy()
  })
})
