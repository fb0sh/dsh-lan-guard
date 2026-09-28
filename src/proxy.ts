/**
 * dsh-lan-guard — the reverse proxy itself.
 *
 * The proxy owns its own listener; it never touches DSH's binding. Requests are relayed transparently to the
 * loopback upstream:
 *
 * - HTTP: one `http.request` per visitor request, streamed both ways. Nothing
 *   is buffered, so a large or streaming response keeps its semantics.
 * - WebSocket: the upgrade is relayed by {@link forwardUpgrade}.
 * - A `401` from the upstream means our cached loopback cookie died (DSH
 *   restarted, or the cookie was rotated). For a safe method the request is
 *   re-authenticated and retried ONCE — never for a body-carrying method.
 *
 * The gate is NOT part of this module's P1 scope; P2 inserts it in front of
 * both the HTTP and the upgrade path.
 */
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { Duplex } from 'node:stream'
import type { TLSSocket } from 'node:tls'
import {
  authorityOf,
  buildUpstreamRequestHeaders,
  buildUpstreamResponseHeaders,
  normalizeRequestTarget,
} from './headers.ts'
import type { LanGuardLogger } from './log.ts'
import { noopLogger } from './log.ts'
import type { VisitorGate } from './auth/gate.ts'
import { ADMIN_COOKIE } from './auth/manager.ts'
import type { UpstreamAuth } from './upstream-auth.ts'
import {
  forwardUpgrade,
  guardUpgradeSocket,
  type RelayOutcome,
  type UpgradeTunnel,
  type UpstreamTarget,
} from './websocket.ts'

/**
 * The visitor cookies this proxy relays in BOTH directions.
 *
 * The proxy injects DSH's loopback session cookie itself and never forwards the
 * visitor's other cookies (the gate session and the device identity belong to
 * the proxy origin). But this plugin mints its OWN admin session cookie, and the
 * only code that can validate it — the management route — runs on DSH's web
 * server, behind this proxy. Dropping it made `adminPolicy: password_unlock`
 * unsatisfiable for every remote device: the unlock POST returned 200 and the
 * very next request was locked again (reported 2026-09-26: "远程选了密码解锁，
 * 添加工作区里仍然是空的"). Relaying exactly this name keeps DSH's own cookie
 * out of the visitor's browser while letting the plugin's credential round-trip.
 */
const RELAY_COOKIE_NAMES = [ADMIN_COOKIE] as const

/** Options for {@link startProxy}. */
export interface ProxyOptions {
  /** Bind address (loopback in P1/P2; P3 opens it to the LAN). */
  listenHost: string
  /** Bind port; `0` asks the OS for a free port. */
  listenPort: number
  /** How many consecutive ports to try when the configured one is taken. */
  portProbeAttempts?: number
  /** Loopback origin to forward to. */
  upstreamOrigin: string
  /** Owns the injected loopback cookie. */
  auth: UpstreamAuth
  /**
   * The visitor gate. When present it runs BEFORE anything is forwarded, on
   * both the HTTP and the upgrade path: the gate is never behind the listener.
   */
  gate?: VisitorGate
  /** PEM certificate and key; when present the listener serves HTTPS. */
  tls?: { cert: string; key: string }
  /**
   * Answer the upstream's WebSocket Ping frames from this hop.
   *
   * DSH reaps a mux socket 6 s after its Pings stop being answered (measured
   * 2026-09-28), which is exactly what happens while a phone is suspended. See
   * `ws-heartbeat.ts`. A function is read per upgrade, so a live switch applies
   * without a restart.
   */
  answerHeartbeat?: boolean | (() => boolean)
  /** Logger. */
  logger?: LanGuardLogger
}

/** One relayed WebSocket, as the management console sees it (P5). */
export interface RelayEvent {
  /** When the outcome was recorded, in epoch milliseconds. */
  atMs: number
  /** The request target the tunnel was opened for. */
  target: string
  /** Whether the upstream accepted the upgrade. */
  upgraded: boolean
  /** Upstream or gate status when the upgrade was refused. */
  status?: number
  /** Tunnel lifetime in milliseconds. */
  durationMs: number
  /** Bytes relayed upstream → visitor. */
  bytesToVisitor: number
  /** Bytes relayed visitor → upstream. */
  bytesToUpstream: number
  /** Whether the upstream sent a WebSocket Close frame before the socket died. */
  sawCloseFrame: boolean
}

/** Live relay counters for the management console (P5). */
export interface ProxyStats {
  /** Upgraded tunnels currently open. */
  wsActive: number
  /** Upgrades the upstream accepted since start. */
  wsUpgrades: number
  /** Upgrades refused by the gate or the upstream since start. */
  wsRefused: number
  /** Pongs written to the upstream on a visitor's behalf since start. */
  heartbeatAnswered: number
  /** The last few outcomes, newest first. */
  recent: readonly RelayEvent[]
}

/** A running proxy listener. */
export interface RunningProxy {
  /** The address actually bound. */
  readonly host: string
  /** The port actually bound (resolved when `listenPort` was 0). */
  readonly port: number
  /** The port that was configured (differs from `port` after a fallback). */
  readonly requestedPort: number
  /** Whether the configured port was taken and a later one was used instead. */
  readonly portFallback: boolean
  /** Stop listening and drop every live connection. */
  close(): Promise<void>
  /** Relay counters and the most recent outcomes (P5 "连接体检"). */
  stats(): ProxyStats
}

/** Bind one port, resolving on `listening` and rejecting on `error`. */
function listenOnce(server: Server, host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

/** Resolve an origin URL into the hostname/port pair `http.request` needs. */
export function parseUpstream(origin: string): UpstreamTarget {
  const url = new URL(origin)
  return {
    hostname: url.hostname,
    port: url.port === '' ? 80 : Number(url.port),
  }
}

/** Whether a request method may be retried after a `401` without side effects. */
function isSafeMethod(method: string | undefined): boolean {
  return method === 'GET' || method === 'HEAD'
}

/** The peer address of a socket whose own typing does not carry one. */
function peerOf(socket: unknown): string {
  const address = (socket as { remoteAddress?: unknown }).remoteAddress
  return typeof address === 'string' && address !== '' ? address : 'unknown'
}

/**
 * Answer a plaintext HTTP request that reached the TLS port with a redirect to
 * the same address over `https`.
 *
 * Three facts shape this function:
 *
 * 1. it only ever runs for a connection whose handshake ALREADY failed, so it
 *    cannot affect a working TLS session;
 * 2. the request line and headers are gone by then — the TLS parser consumed
 *    and rejected them — so the redirect targets the root of the address the
 *    client connected to, not the path it asked for;
 * 3. a plaintext reply cannot travel through the `TLSSocket` at all (writing to
 *    it is encrypted into nothing — measured: the client receives zero bytes),
 *    so only the raw socket underneath can carry it. Node exposes that as the
 *    private `_parent`; the field is verified on Node 20, 22 and 24. When it is
 *    absent — a future Node change — this returns false and the caller destroys
 *    the socket, which is exactly the behaviour before this function existed.
 *
 * @param socket - the socket whose TLS handshake failed.
 * @param logger - logger, used only for the degraded path.
 * @returns whether the redirect was written.
 */
function redirectPlaintextToHttps(socket: TLSSocket, logger: LanGuardLogger): boolean {
  const raw = (socket as unknown as { _parent?: unknown })._parent as
    | { writable?: unknown; end?: unknown }
    | undefined
  if (raw === undefined || raw === null || raw.writable !== true || typeof raw.end !== 'function') {
    logger.debug?.('plaintext redirect unavailable: no writable raw socket')
    return false
  }
  const address = socket.localAddress
  const port = socket.localPort
  if (address === undefined || address === '' || port === undefined) return false
  const host = address.includes(':') ? `[${address}]` : address
  try {
    // One `end` (write + FIN) is enough: the client reads the whole response.
    ;(raw.end as (chunk: string) => unknown).call(
      raw,
      'HTTP/1.1 301 Moved Permanently\r\n'
      + `location: https://${host}:${String(port)}/\r\n`
      + 'content-length: 0\r\nconnection: close\r\n\r\n',
    )
    return true
  } catch (error) {
    logger.warn('plaintext redirect failed name=%s', (error as Error).name)
    return false
  }
}

/**
 * Start the proxy listener.
 *
 * @param options - bind address, upstream origin and the cookie owner.
 * @returns the running proxy, resolved once the socket is bound.
 */
export async function startProxy(options: ProxyOptions): Promise<RunningProxy> {
  const logger = options.logger ?? noopLogger
  const upstream = parseUpstream(options.upstreamOrigin)
  const authority = authorityOf(options.upstreamOrigin)
  const sockets = new Set<Duplex>()
  /** Live read of the heartbeat switch; a plain boolean is a fixed decision. */
  const heartbeatEnabled = (): boolean => (
    typeof options.answerHeartbeat === 'function'
      ? options.answerHeartbeat()
      : options.answerHeartbeat === true
  )

  // Relay counters for the management console's health panel (P5). They are a
  // bounded ring: the panel reports the last few outcomes, never a log file.
  const recent: RelayEvent[] = []
  const liveTunnels = new Set<UpgradeTunnel>()
  let wsActive = 0
  let wsUpgrades = 0
  let wsRefused = 0
  /** Pongs answered by tunnels that have already closed. */
  let heartbeatAnsweredClosed = 0
  const recordRelay = (target: string, outcome: RelayOutcome): void => {
    if (outcome.upgraded) {
      wsActive = Math.max(0, wsActive - 1)
    } else {
      wsRefused += 1
    }
    recent.unshift({
      atMs: Date.now(),
      target,
      upgraded: outcome.upgraded,
      ...(outcome.status === undefined ? {} : { status: outcome.status }),
      durationMs: outcome.durationMs,
      bytesToVisitor: outcome.bytesToVisitor,
      bytesToUpstream: outcome.bytesToUpstream,
      sawCloseFrame: outcome.sawCloseFrame,
    })
    if (recent.length > 12) recent.pop()
  }
  const recordRefusal = (target: string, status: number): void => {
    wsRefused += 1
    recent.unshift({
      atMs: Date.now(),
      target,
      upgraded: false,
      status,
      durationMs: 0,
      bytesToVisitor: 0,
      bytesToUpstream: 0,
      sawCloseFrame: false,
    })
    if (recent.length > 12) recent.pop()
  }

  const fail = (res: ServerResponse, code: number, body: string): void => {
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(code, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(`${body}\n`)
  }

  const forwardHttp = async (
    req: IncomingMessage,
    res: ServerResponse,
    target: string,
    mayRetry: boolean,
  ): Promise<void> => {
    let cookie: string
    try {
      cookie = await options.auth.cookieHeader()
    } catch (error) {
      logger.warn('upstream authentication failed name=%s', (error as Error).name)
      fail(res, 502, 'dsh-lan-guard: upstream authentication unavailable')
      return
    }

    const headers = buildUpstreamRequestHeaders({
      headers: req.headers,
      authority,
      upstreamCookie: cookie,
      relayCookieNames: RELAY_COOKIE_NAMES,
    })
    const upstreamReq = httpRequest({
      hostname: upstream.hostname,
      port: upstream.port,
      method: req.method,
      path: target,
      headers,
    })

    upstreamReq.on('response', (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502
      if (status === 401 && mayRetry && isSafeMethod(req.method)) {
        upstreamRes.resume()
        options.auth.invalidate('upstream returned 401')
        void forwardHttp(req, res, target, false)
        return
      }
      res.writeHead(
        status,
        upstreamRes.statusMessage === '' ? undefined : upstreamRes.statusMessage,
        buildUpstreamResponseHeaders(upstreamRes.headers, RELAY_COOKIE_NAMES),
      )
      upstreamRes.pipe(res)
    })

    upstreamReq.on('error', (error: Error) => {
      logger.warn('upstream request failed name=%s code=%s', error.name, (error as NodeJS.ErrnoException).code ?? 'none')
      fail(res, 502, 'dsh-lan-guard: upstream unavailable')
    })

    res.on('close', () => {
      if (!upstreamReq.destroyed) upstreamReq.destroy()
    })

    // A safe method has no body, and re-piping an already-consumed request
    // stream on the 401 retry would never emit `end` again.
    if (isSafeMethod(req.method)) upstreamReq.end()
    else req.pipe(upstreamReq)
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      // The gate runs first and owns the response when it refuses.
      if (options.gate !== undefined) {
        // A rejection here would be an unhandled rejection, and Node 24 exits
        // the process on those — one bad request must never take dsh down.
        const decision = await options.gate.handleHttp(req, res).catch((error: Error) => {
          logger.warn('gate failed name=%s', error.name)
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end('{"ok":false,"error":"internal_error"}')
          } else {
            res.end()
          }
          return 'handled' as const
        })
        if (decision === 'handled') return
      }
      await forwardHttp(req, res, normalizeRequestTarget(req.url), true)
    })()
  }

  // The TLS server is kept separately typed: `tlsClientError` lives on
  // `tls.Server` and would be invisible behind the `Server` cast below.
  const httpsServer = options.tls === undefined
    ? undefined
    : createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, handler)
  const server: Server = httpsServer ?? createServer(handler)

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  if (httpsServer !== undefined) {
    // A plaintext client on the TLS port never reaches the gate: the handshake
    // fails first and Node answers with NOTHING at all, so the visitor sees a
    // bare "无法访问" (user report 2026-09-26: ERR_EMPTY_RESPONSE / -324 — the
    // browser was handed an `http://` address for a listener that serves only
    // https). This is the only place that failure is observable, so both the
    // log line and the redirect live here.
    httpsServer.on('tlsClientError', (error: Error, socket: TLSSocket) => {
      const code = (error as NodeJS.ErrnoException).code ?? error.name
      const plaintext = code === 'ERR_SSL_HTTP_REQUEST'
      logger.warn(
        'tls handshake failed code=%s plaintextHttp=%s ip=%s',
        code,
        plaintext ? 'yes' : 'no',
        peerOf(socket),
      )
      if (plaintext && redirectPlaintextToHttps(socket, logger)) return
      socket.destroy()
    })
  }

  // Node answers an unparsable request with a 400 of its own, and attaching a
  // listener REPLACES that default, so it is reproduced verbatim here — with the
  // log line the default never had (user request 2026-09-26: connection-level
  // failures were invisible in the log).
  server.on('clientError', (error: NodeJS.ErrnoException, socket: Duplex) => {
    logger.warn('malformed request code=%s ip=%s', error.code ?? error.name, peerOf(socket))
    if (error.code === 'ECONNRESET' || socket.writable !== true) {
      socket.destroy()
      return
    }
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // The error handler goes on BEFORE any await: a reconnect that drops the
    // socket mid-authentication must not emit an unhandled error.
    guardUpgradeSocket(socket, logger)
    const upgradeTarget = normalizeRequestTarget(req.url)
    void (async () => {
      // A WebSocket upgrade is a request like any other and passes the gate
      // first; an unauthenticated upgrade is refused before any upstream work.
      if (options.gate !== undefined) {
        const refusal = await options.gate.verifyUpgrade(req)
        if (refusal !== undefined) {
          recordRefusal(upgradeTarget, refusal.status)
          if (!socket.destroyed) {
            socket.write(`HTTP/1.1 ${String(refusal.status)} Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
          }
          socket.destroy()
          return
        }
      }
      let cookie: string
      try {
        cookie = await options.auth.cookieHeader()
      } catch (error) {
        logger.warn('upgrade authentication failed name=%s', (error as Error).name)
        recordRefusal(upgradeTarget, 502)
        socket.destroy()
        return
      }
      let tunnel: ReturnType<typeof forwardUpgrade> | undefined
      tunnel = forwardUpgrade({
        req,
        socket,
        head,
        upstream,
        target: upgradeTarget,
        headers: buildUpstreamRequestHeaders({
          headers: req.headers,
          authority,
          upstreamCookie: cookie,
          upgrade: true,
          relayCookieNames: RELAY_COOKIE_NAMES,
        }),
        logger,
        answerHeartbeat: heartbeatEnabled(),
        onUpgraded: () => {
          wsActive += 1
          wsUpgrades += 1
        },
        onOutcome: (target, outcome) => {
          // A closed tunnel's answered-ping count is folded into the totals; a
          // still-open one is summed live by `stats()`.
          if (tunnel !== undefined) {
            liveTunnels.delete(tunnel)
            heartbeatAnsweredClosed += tunnel.heartbeatAnswered()
          }
          recordRelay(target, outcome)
        },
      })
      if (tunnel !== undefined) liveTunnels.add(tunnel)
    })()
  })

  // The configured port is a preference, not a promise: if it is taken, walk
  // up to the next free one instead of failing to start (user request
  // 2026-09-24: "3081, 3082, 3083 … take the first free one"). The real bind IS
  // the probe — no throwaway socket, so no race and no extra listener.
  const attempts = options.portProbeAttempts ?? 0
  const requestedPort = options.listenPort
  let boundPort = requestedPort
  for (let offset = 0; ; offset += 1) {
    try {
      await listenOnce(server, options.listenHost, boundPort)
      break
    } catch (error) {
      const busy = (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
      if (!busy || requestedPort === 0 || offset >= attempts) throw error
      const next = requestedPort + offset + 1
      logger.warn('port %d is taken; trying %d', boundPort, next)
      boundPort = next
    }
  }

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : options.listenPort

  return {
    host: options.listenHost,
    port,
    requestedPort,
    portFallback: port !== requestedPort,
    stats(): ProxyStats {
      let heartbeatAnswered = heartbeatAnsweredClosed
      for (const tunnel of liveTunnels) heartbeatAnswered += tunnel.heartbeatAnswered()
      return {
        wsActive,
        wsUpgrades,
        wsRefused,
        heartbeatAnswered,
        recent: [...recent],
      }
    },
    close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
        for (const socket of sockets) socket.destroy()
        sockets.clear()
      })
    },
  }
}
