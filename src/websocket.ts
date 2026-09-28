/**
 * dsh-lan-guard — WebSocket upgrade forwarding.
 *
 * DSH serves its Remote stream on `/api/remote.mux` over a WebSocket upgrade, and the shipped UI keeps that socket open for the
 * whole session. The proxy therefore has to relay the upgrade itself rather
 * than treat it as an ordinary HTTP response.
 *
 * Two rules from the researched reference implementations are applied here:
 *
 * - The visitor's socket gets an `error` handler IMMEDIATELY, before any
 *   asynchronous work. A phone reconnecting drops
 *   upgrade sockets constantly; an unhandled `error` during an await would
 *   take the whole process down. This is also why the gate in P2 can await
 *   safely.
 * - The upstream 101 passes only the handshake headers a browser needs— never the upstream's arbitrary header set.
 *
 * A third rule was measured on 2026-09-28: the host pings every 2 s and
 * destroys a socket after two unanswered pings, so a phone that is suspended
 * loses the session socket after 6 s. With `answerHeartbeat` on,
 * {@link createUpstreamPingAnswerer} answers those pings from this hop; the
 * relay itself stays a byte-for-byte pipe in both directions.
 */
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http'
import type { Duplex } from 'node:stream'
import { buildUpgradeResponseHead } from './headers.ts'
import type { LanGuardLogger } from './log.ts'
import { noopLogger } from './log.ts'
import { createUpstreamPingAnswerer, type UpstreamPingAnswerer } from './ws-heartbeat.ts'

/** Where an upstream request goes. */
export interface UpstreamTarget {
  /** Upstream hostname (a loopback literal in this project). */
  hostname: string
  /** Upstream port. */
  port: number
}

/** What one relayed socket did, for the management console's health panel (P5). */
export interface RelayOutcome {
  /** Whether the upstream accepted the upgrade. */
  upgraded: boolean
  /** Upstream status when it refused to upgrade. */
  status?: number
  /** How long the tunnel lived, in milliseconds. */
  durationMs: number
  /** Bytes relayed upstream → visitor. */
  bytesToVisitor: number
  /** Bytes relayed visitor → upstream. */
  bytesToUpstream: number
  /** Whether a WebSocket Close frame was seen coming from the upstream. */
  sawCloseFrame: boolean
}

/** Sink for {@link RelayOutcome}. */
export type RelayOutcomeSink = (target: string, outcome: RelayOutcome) => void

/** Attach the mandatory `error` handler to a socket we now own. */
export function guardUpgradeSocket(socket: Duplex, logger: LanGuardLogger = noopLogger): void {
  socket.on('error', (error: Error) => {
    // A phone that walks out of Wi-Fi range produces ECONNRESET/EPIPE here; it
    // is routine, not an incident, and must never surface as an unhandled error.
    logger.debug?.('upgrade socket error name=%s', error.name)
    socket.destroy()
  })
}

/** Options for {@link forwardUpgrade}. */
export interface UpgradeForwardOptions {
  /** The visitor's upgrade request. */
  req: IncomingMessage
  /** The visitor's socket. */
  socket: Duplex
  /** Bytes the HTTP parser already read past the request head. */
  head: Buffer
  /** Upstream destination. */
  upstream: UpstreamTarget
  /** Already-rewritten request headers (host/origin/cookie). */
  headers: OutgoingHttpHeaders
  /** Normalized upstream request target. */
  target: string
  /** Logger. */
  logger?: LanGuardLogger
  /**
   * Answer the upstream's Ping frames from this hop, so a visitor that cannot
   * run its page for a few seconds is not reaped by DSH's 2 s / 2 missed
   * heartbeat. See `ws-heartbeat.ts` for the measurement behind it.
   */
  answerHeartbeat?: boolean
  /** Where the outcome is reported, for the management console (P5). */
  onOutcome?: RelayOutcomeSink
  /** Called once the upstream 101 has been relayed to the visitor (P5). */
  onUpgraded?: (target: string) => void
}

/** A live upgrade relay. */
export interface UpgradeTunnel {
  /** Tear the tunnel down. */
  destroy(): void
  /** Pongs written to the upstream on the visitor's behalf so far. */
  heartbeatAnswered(): number
}

/**
 * Relay one WebSocket upgrade to the upstream and pipe both directions.
 *
 * @param options - the upgrade request, its socket, and the prepared headers.
 * @returns a handle whose `destroy()` tears the tunnel down.
 */
export function forwardUpgrade(options: UpgradeForwardOptions): UpgradeTunnel {
  const { req, socket, head, upstream, headers, target } = options
  const logger = options.logger ?? noopLogger
  guardUpgradeSocket(socket, logger)

  const startedAtMs = Date.now()
  let answerer: UpstreamPingAnswerer | undefined
  let bytesToVisitor = 0
  let bytesToUpstream = 0
  let sawCloseFrame = false
  let reported = false

  const report = (outcome: { upgraded: boolean; status?: number }): void => {
    if (reported) return
    reported = true
    options.onOutcome?.(target, {
      upgraded: outcome.upgraded,
      ...(outcome.status === undefined ? {} : { status: outcome.status }),
      durationMs: Date.now() - startedAtMs,
      bytesToVisitor,
      bytesToUpstream,
      sawCloseFrame,
    })
  }

  const upstreamReq = httpRequest({
    hostname: upstream.hostname,
    port: upstream.port,
    method: req.method ?? 'GET',
    path: target,
    headers,
  })

  let upstreamSocket: Duplex | undefined

  upstreamReq.on('upgrade', (upstreamRes, upstreamDuplex, upstreamHead) => {
    upstreamSocket = upstreamDuplex
    guardUpgradeSocket(upstreamDuplex, logger)
    upstreamDuplex.on('close', () => socket.destroy())
    socket.on('close', () => upstreamDuplex.destroy())

    socket.write(buildUpgradeResponseHead(
      upstreamRes.headers,
      upstreamRes.statusCode ?? 101,
      upstreamRes.statusMessage === '' ? 'Switching Protocols' : upstreamRes.statusMessage ?? 'Switching Protocols',
    ))
    if (upstreamHead.length > 0) socket.write(upstreamHead)
    options.onUpgraded?.(target)

    // Observers only READ this stream: the `pipe` below still forwards every
    // byte unchanged. They feed the health panel and the ping answerer.
    upstreamDuplex.on('data', (chunk: Buffer) => {
      bytesToVisitor += chunk.length
      if (((chunk[0] ?? 0) & 0x0f) === 0x8) sawCloseFrame = true
    })
    if (options.answerHeartbeat === true) {
      answerer = createUpstreamPingAnswerer({
        send: frame => {
          if (!upstreamDuplex.destroyed) upstreamDuplex.write(frame)
        },
        logger,
      })
      const observer = answerer
      upstreamDuplex.on('data', (chunk: Buffer) => { observer.observe(chunk) })
    }
    socket.on('data', (chunk: Buffer) => { bytesToUpstream += chunk.length })
    socket.on('close', () => { report({ upgraded: true }) })

    upstreamDuplex.pipe(socket)
    socket.pipe(upstreamDuplex)
  })

  upstreamReq.on('response', (upstreamRes) => {
    // The upstream answered with a normal HTTP response instead of upgrading
    // (for example a 401 from the fence). Relay the status and close: there is
    // no tunnel to keep.
    logger.debug?.('upgrade refused by upstream status=%d', upstreamRes.statusCode ?? 0)
    upstreamRes.resume()
    const status = upstreamRes.statusCode ?? 502
    if (!socket.destroyed) {
      const message = upstreamRes.statusMessage === '' ? 'Upstream Refused' : upstreamRes.statusMessage ?? 'Upstream Refused'
      socket.write(`HTTP/1.1 ${String(status)} ${message}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
    }
    report({ upgraded: false, status })
    socket.destroy()
  })

  upstreamReq.on('error', (error: Error) => {
    logger.warn('upgrade upstream error name=%s', error.name)
    report({ upgraded: false })
    socket.destroy()
  })

  if (head.length > 0) upstreamReq.write(head)
  upstreamReq.end()

  return {
    destroy() {
      upstreamReq.destroy()
      upstreamSocket?.destroy()
      socket.destroy()
    },
    heartbeatAnswered: () => answerer?.stats().answered ?? 0,
  }
}
