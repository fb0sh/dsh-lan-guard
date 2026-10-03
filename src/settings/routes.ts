/**
 * dsh-lan-guard — the management surface.
 *
 * These routes live on DSH's OWN web server, not on the proxy port, and they
 * are protected by DSH's native fence via `connection.requestRejection()` —
 * the researched seam that reuses the Host/Origin check plus DSH's browser
 * cookie authentication. The two auth surfaces are
 * deliberately distinct: being able to open the settings page is NOT the same
 * as being able to pass the visitor gate, and vice versa.
 *
 * Responsibilities:
 *
 * - `GET  /plugins/dsh-lan-guard/config` — the settings snapshot, redacted;
 * - `POST /plugins/dsh-lan-guard/config` — non-sensitive switches (through the
 *   host settings service, so there is ONE source of truth), password changes,
 *   passwordless-link rotation, and admin unlock/lock;
 * - `GET  /plugins/dsh-lan-guard/auth-status` — redacted status only.
 *
 * The admin unlock is exempt from every admin requirement (it IS the unlock),
 * which is the researched deadlock fix: an unlock that depended on a session
 * would make the console permanently unlockable once that session expired.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import type { AdminPolicy, AuthMode, LanGuardConfigShape, LiveSwitches } from '../config.ts'
import type { LanGuardLogger } from '../log.ts'
import { noopLogger } from '../log.ts'
import type { AuthManager } from '../auth/manager.ts'
import { buildClearedCookie, isLoopbackAddress, passesCsrfCheck, ADMIN_COOKIE } from '../auth/manager.ts'
import { VISITOR_HEADER } from '../headers.ts'
import type { AccessInfo } from '../qrcode.ts'
import { listDirectories } from '../workspace/browse.ts'
import type { DeviceRecord } from '../store/secrets.ts'
import type { DeviceStatus } from '../store/secrets.ts'
import type { UpdateStatus } from '../update-check.ts'
import { registerIndexPatches } from './index-tap.ts'
import type { ProxyStats } from '../proxy.ts'
import {
  PreferenceError,
  sanitizePreferencePatch,
  toSettingsPatch,
  type PreferenceValues,
} from '../store/preferences.ts'

/** Route prefix owned by this plugin on DSH's own web server. */
export const MANAGEMENT_BASE = '/plugins/dsh-lan-guard'
/** Largest accepted management body. */
const MAX_BODY_BYTES = 16 * 1024
/**
 * Minimum password length (user decision, 2026-09-24). SPEC F3 fixed no policy,
 * so this is deliberately a single constant rather than a configurable knob.
 */
export const MIN_PASSWORD_LENGTH = 8

/** The redacted gate status the settings page may see. */
export interface AuthStatus {
  /** The plugin master switch (top-level `enabled`, volatile). */
  pluginEnabled: boolean
  /**
   * Whether this request reached DSH directly on loopback rather than through
   * the LAN gateway. A direct loopback client is the machine's own operator
   * and has PHYSICAL UNLOCK PRIVILEGE: it is never asked for a password.
   */
  localAccess: boolean
  /** Whether this request must unlock the console before it may write. */
  adminRequired: boolean
  /** Whether this request may only read (remote access under `local_only`). */
  remoteReadOnly: boolean
  /** The gate master switch (`auth.enabled`, static — not editable from the page). */
  gateEnabled: boolean
  mode: AuthMode
  adminPolicy: AdminPolicy
  adminProtection: boolean
  allowLoopback: boolean
  hasPassword: boolean
  hasAdminPassword: boolean
  hasSecretToken: boolean
  adminUnlocked: boolean
}

/** One paired device as the settings page sees it (never its token). */
export interface DeviceView {
  id: string
  label: string
  /** F9 state. */
  status: DeviceStatus
  /** When the operator approved or blocked it. */
  decidedAtMs: number | null
  createdAtMs: number
  lastSeenAtMs: number | null
  lastIp: string | null
  revoked: boolean
}

/** The subset of {@link DeviceRegistry} the endpoints use. */
export interface DeviceRegistryLike {
  list(): readonly DeviceRecord[]
  add(label: string, options?: { pending?: boolean }): Promise<{ device: DeviceRecord; token: string }>
  setStatus(id: string, status: DeviceStatus): Promise<boolean>
  revoke(id: string): Promise<boolean>
  remove(id: string): Promise<boolean>
}

/** Project a stored device onto its public view. */
function deviceView(device: DeviceRecord): DeviceView {
  return {
    id: device.id,
    label: device.label,
    status: device.status,
    decidedAtMs: device.decidedAtMs,
    createdAtMs: device.createdAtMs,
    lastSeenAtMs: device.lastSeenAtMs,
    lastIp: device.lastIp,
    revoked: device.revokedAtMs !== null,
  }
}

/** The full settings snapshot. `secretToken` is present only when unlocked. */
export interface ConfigSnapshot {
  ok: true
  preferences: PreferenceValues
  listener: {
    listenHost: string
    /** The port actually bound. */
    listenPort: number
    /** The port from config (differs after a fallback). */
    configuredPort: number
    /** Whether the configured port was taken and a later one was used. */
    portFallback: boolean
    upstreamOrigin: string
  }
  authStatus: AuthStatus
  /** The access URL set plus QR codes. */
  access: AccessInfo
  /** Paired devices (P4-g); tokens are never included. */
  devices: DeviceView[]
  /** How many devices are waiting for approval (F9). */
  pendingCount: number
  /** WebSocket relay counters and the most recent outcomes (P5 health panel). */
  connection?: ProxyStats
  /** The passwordless link, present only for an admin-unlocked caller. */
  secretToken?: string
}

/** The subset of DSH's native fence this module uses. */
export interface RequestRejectionLike {
  requestRejection(request: IncomingMessage): number | undefined
}

/** The subset of `ctx.webServer` this module uses. */
export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
  /**
   * Optional raw index transform (DSH's `WebServer.tapIndex`). When the host
   * does not expose it, the remote settings-page unlock degrades away instead
   * of taking the plugin down.
   */
  tapIndex?(transform: (html: string) => string): () => void
}

/** The subset of the host `settings` service this module uses. */
export interface SettingsWriterLike {
  describe(): readonly { ns: string; revision?: number }[]
  update(ns: string, patch: Record<string, unknown>, expectedRevision?: number): Promise<void>
}

/** Options for {@link registerManagementRoutes}. */
export interface ManagementRoutesOptions {
  connection: RequestRejectionLike
  webServer: WebServerLike
  auth: AuthManager
  switches: LiveSwitches
  config: LanGuardConfigShape
  settings?: SettingsWriterLike | undefined
  /** The live listener facts (actual port + whether a fallback happened). */
  listener: { port: () => number; portFallback: () => boolean }
  /** Paired-device registry (P4-g). */
  devices: DeviceRegistryLike
  /** Update detection (F8): read-only, cached inside the checker. */
  updates: { check(options?: { force?: boolean }): Promise<UpdateStatus> }
  /** Live WebSocket relay counters (P5). Absent in unit tests without a proxy. */
  relay?: { stats(): ProxyStats } | undefined
  /**
   * Build the current access URL set and QR codes. Rebuilt per request, which
   * is what makes a NIC/port/TLS/token change refresh the QR.
   */
  access: (secretToken?: string | null) => Promise<AccessInfo>
  logger?: LanGuardLogger
}

/**
 * Whether a port is free, probed on LOOPBACK ONLY.
 *
 * Probing loopback never opens a network-facing socket (the gate-before-listen
 * rule), and it is conservative: if anything already holds the port on any
 * interface, binding loopback fails too, so a busy port is never reported free.
 */
async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = createNetServer()
    probe.once('error', () => {
      resolve(false)
    })
    probe.once('listening', () => {
      probe.close(() => {
        resolve(true)
      })
    })
    probe.listen(port, '127.0.0.1')
  })
}

/** Whether a request is a state change that needs the CSRF check. */
function isStateChanging(method: string | undefined): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
}

/** Read a small JSON body. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new PreferenceError('request body too large')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new PreferenceError('request body must be JSON')
  }
}

/**
 * Register the management routes.
 *
 * @param options - the DSH seams plus the gate state.
 * @returns a disposer removing every route.
 */
export function registerManagementRoutes(options: ManagementRoutesOptions): () => void {
  const logger = options.logger ?? noopLogger
  const disposers: (() => void)[] = []

  const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(`${JSON.stringify(body)}\n`)
  }

  /** Whether the request arrived directly on loopback (no visitor marker). */
  const isLocalRequest = (req: IncomingMessage): boolean => (
    isLoopbackAddress(req.socket.remoteAddress) && req.headers[VISITOR_HEADER] === undefined
  )

  /**
   * How the management console treats THIS request.
   *
   * - a direct loopback client is the operator: never locked (physical unlock
   *   privilege — user decision 2026-09-24, matching the reference console);
   * - remote access under `local_only` is read-only (SPEC F3: "only local
   *   loopback may manage; other devices are read-only");
   * - remote access under `password_unlock` must unlock first;
   * - `open` never locks.
   */
  const adminStateOf = (req: IncomingMessage): 'open' | 'local' | 'readonly' | 'locked' => {
    const policy = options.switches.adminPolicy()
    if (policy === 'open') return 'open'
    if (isLocalRequest(req)) return 'local'
    if (policy === 'local_only') return 'readonly'
    return options.auth.isAdminUnlocked(req) ? 'open' : 'locked'
  }

  /** Build the redacted status. */
  const statusOf = (req: IncomingMessage): AuthStatus => ({
    pluginEnabled: options.switches.enabled(),
    localAccess: isLocalRequest(req),
    adminRequired: adminStateOf(req) === 'locked',
    remoteReadOnly: adminStateOf(req) === 'readonly',
    gateEnabled: options.config.auth.enabled,
    mode: options.switches.mode(),
    adminPolicy: options.switches.adminPolicy(),
    adminProtection: options.switches.adminProtection(),
    allowLoopback: options.switches.allowLoopback(),
    hasPassword: options.auth.hasPassword,
    hasAdminPassword: options.auth.hasAdminPassword,
    hasSecretToken: options.auth.hasSecretToken,
    adminUnlocked: options.auth.isAdminUnlocked(req),
  })

  /** Build the settings snapshot, including the token only when unlocked. */
  const snapshotOf = async (req: IncomingMessage): Promise<ConfigSnapshot> => {
    const token = mayManage(req) ? options.auth.secretToken() : undefined
    const snapshot: ConfigSnapshot = {
      ok: true,
      preferences: {
        enabled: options.switches.enabled(),
        listenPort: options.switches.listenPort(),
        listenHost: options.switches.listenHost(),
        networkInterface: options.switches.networkInterface() ?? '',
        settingsUnlock: options.switches.settingsUnlock(),
        answerHeartbeat: options.switches.answerHeartbeat(),
        socketWatchdog: options.switches.socketWatchdog(),
        mobileCompat: options.switches.mobileCompat(),
        mobileScrollFix: options.switches.mobileScrollFix(),
        pwaInstall: options.switches.pwaInstall(),
        mode: options.switches.mode(),
        adminPolicy: options.switches.adminPolicy(),
        adminProtection: options.switches.adminProtection(),
        allowLoopback: options.switches.allowLoopback(),
        requirePairing: options.switches.requirePairing(),
        requireApproval: options.switches.requireApproval(),
      },
      listener: {
        listenHost: options.config.listenHost,
        listenPort: options.listener.port(),
        configuredPort: options.switches.listenPort(),
        portFallback: options.listener.portFallback(),
        upstreamOrigin: options.config.upstreamOrigin,
      },
      authStatus: statusOf(req),
      access: await options.access(token ?? null),
      devices: options.devices.list().map(deviceView),
      pendingCount: options.devices.list().filter(device => device.status === 'pending').length,
    }
    if (token !== undefined) snapshot.secretToken = token
    const relay = options.relay
    if (relay !== undefined) snapshot.connection = relay.stats()
    return snapshot
  }

  /** Run the native fence; returns true when the request was refused. */
  const refusedByFence = (req: IncomingMessage, res: ServerResponse): boolean => {
    const rejection = options.connection.requestRejection(req)
    if (rejection === undefined) return false
    sendJson(res, rejection, { ok: false, error: rejection === 403 ? 'forbidden' : 'unauthorized' })
    return true
  }

  /**
   * Whether the caller may manage this console at all: the machine's own
   * operator (direct loopback) or an explicitly unlocked remote session. The
   * passwordless link is a credential and is only handed to these callers.
   */
  const mayManage = (req: IncomingMessage): boolean => {
    const state = adminStateOf(req)
    return state === 'open' || state === 'local'
  }

  /** Whether the caller may not write at all (remote + `local_only`). */
  const isRemoteReadOnly = (req: IncomingMessage): boolean => adminStateOf(req) === 'readonly'

  /** Whether the caller must be admin-unlocked for management writes. */
  const needsAdmin = (req: IncomingMessage): boolean => (
    options.switches.adminProtection() && adminStateOf(req) === 'locked'
  )

  /** Write non-sensitive switches through the host settings service. */
  const writePreferences = async (values: Partial<PreferenceValues>): Promise<void> => {
    const writer = options.settings
    if (writer === undefined) {
      throw new PreferenceError('settings service is unavailable; cannot persist switches')
    }
    const row = writer.describe().find(entry => entry.ns === 'dsh-lan-guard')
    await writer.update('dsh-lan-guard', toSettingsPatch(values), row?.revision)
  }

  const handleConfig = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (refusedByFence(req, res)) return

    if (!isStateChanging(req.method)) {
      // The passwordless link is a credential, so it is created lazily and
      // only ever handed to an admin-unlocked caller.
      if (mayManage(req)) await options.auth.ensureSecretToken()
      sendJson(res, 200, await snapshotOf(req))
      return
    }
    if (!passesCsrfCheck(req)) {
      sendJson(res, 403, { ok: false, error: 'csrf' })
      return
    }
    if (isRemoteReadOnly(req)) {
      // local_only means "the machine's own operator manages this console".
      sendJson(res, 403, { ok: false, error: 'read_only_remote' })
      return
    }

    let body: Record<string, unknown>
    try {
      const parsed = await readJsonBody(req)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new PreferenceError('request body must be a JSON object')
      }
      body = parsed as Record<string, unknown>
    } catch (error) {
      sendJson(res, 400, { ok: false, error: (error as Error).message })
      return
    }

    const extraCookies: string[] = []
    try {
      // Admin unlock first: it is the ONE operation that must never require an
      // already-unlocked console, or the surface could deadlock.
      if (typeof body.adminUnlock === 'string') {
        const unlocked = await options.auth.unlockAdmin(body.adminUnlock)
        if (unlocked === undefined) {
          logger.warn('admin unlock failed')
          sendJson(res, 401, { ok: false, error: 'admin_password_invalid' })
          return
        }
        extraCookies.push(unlocked.cookie)
      }
      if (body.adminLock === true) {
        options.auth.lockAdmin(req)
        extraCookies.push(buildClearedCookie(ADMIN_COOKIE))
      }

      if (body.preferences !== undefined) {
        if (needsAdmin(req)) {
          sendJson(res, 403, { ok: false, error: 'admin_required' })
          return
        }
        const values = sanitizePreferencePatch(body.preferences)
        // A non-loopback bind with the gate disabled is rejected at startup. Refusing it HERE keeps the settings
        // page from writing a config that would fail the next restart — a
        // broken boot is far worse than a refused save.
        if (
          values.listenHost !== undefined
          && values.listenHost !== '127.0.0.1'
          && !options.config.auth.enabled
        ) {
          sendJson(res, 400, { ok: false, error: 'gate_disabled_requires_loopback' })
          return
        }
        await writePreferences(values)
        if (values.mode !== undefined) {
          // A mode change must bite immediately: otherwise a phone that already
          // logged in keeps its session and never sees the new requirement.
          await options.auth.revokeAllSessions()
        }
      }

      if (body.setPassword !== undefined) {
        const request = body.setPassword as { current?: unknown; next?: unknown }
        if (typeof request?.next !== 'string' || request.next.length < MIN_PASSWORD_LENGTH) {
          throw new PreferenceError(`setPassword.next must be at least ${String(MIN_PASSWORD_LENGTH)} characters`)
        }
        // Bootstrap: with no password configured there is nothing to confirm,
        // and DSH's native fence already proves the caller is the local
        // operator. Requiring a "current" password here would make the first
        // setup impossible (and the admin unlock impossible too, since it falls
        // back to the access password).
        const allowed = !options.auth.hasPassword
          || mayManage(req)
          || (typeof request.current === 'string' && await options.auth.verifyAccessPassword(request.current))
        if (!allowed) {
          sendJson(res, 403, { ok: false, error: 'current_password_required' })
          return
        }
        const wasBootstrap = !options.auth.hasPassword
        await options.auth.setPassword(request.next)
        // Changing the password invalidates every existing visitor session.
        await options.auth.revokeAllSessions()
        if (wasBootstrap) {
          // The caller just set the FIRST password from behind DSH's native
          // fence, so unlock this management session with it instead of asking
          // for the password they only just chose.
          const unlocked = await options.auth.unlockAdmin(request.next)
          if (unlocked !== undefined) extraCookies.push(unlocked.cookie)
        }
      }

      if (body.setAdminPassword !== undefined) {
        const request = body.setAdminPassword as { current?: unknown; next?: unknown }
        if (typeof request?.next !== 'string' || request.next.length < MIN_PASSWORD_LENGTH) {
          throw new PreferenceError(`setAdminPassword.next must be at least ${String(MIN_PASSWORD_LENGTH)} characters`)
        }
        const allowed = !options.auth.hasAdminPassword
          || mayManage(req)
          || (typeof request.current === 'string' && await options.auth.verifyAdminPassword(request.current))
        if (!allowed) {
          sendJson(res, 403, { ok: false, error: 'current_password_required' })
          return
        }
        await options.auth.setAdminPassword(request.next)
      }

      if (body.rotateToken === true) {
        if (needsAdmin(req)) {
          sendJson(res, 403, { ok: false, error: 'admin_required' })
          return
        }
        await options.auth.rotateSecretToken()
      }
    } catch (error) {
      if (error instanceof PreferenceError) {
        sendJson(res, 400, { ok: false, error: error.message })
        return
      }
      // The management surface is reachable only through DSH's native fence
      // (and, for writes, an admin unlock), so the operator gets the actual
      // reason instead of an opaque failure — a settings page that silently
      // refuses to save is worse than one that explains why.
      const detail = (error as Error).message
      logger.warn('management write failed name=%s message=%s', (error as Error).name, detail)
      sendJson(res, 500, { ok: false, error: 'internal_error', detail: detail.slice(0, 300) })
      return
    }

    if (mayManage(req)) await options.auth.ensureSecretToken()
    const snapshot = await snapshotOf(req)
    if (extraCookies.length === 0) {
      sendJson(res, 200, snapshot)
      return
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': extraCookies,
    })
    res.end(`${JSON.stringify(snapshot)}\n`)
  }

  const handleAuthStatus = (req: IncomingMessage, res: ServerResponse): void => {
    if (refusedByFence(req, res)) return
    sendJson(res, 200, { ok: true, ...statusOf(req) })
  }

  disposers.push(options.webServer.register({ kind: 'exact', path: `${MANAGEMENT_BASE}/config`, handler: handleConfig }))
  disposers.push(options.webServer.register({
    kind: 'exact',
    path: `${MANAGEMENT_BASE}/auth-status`,
    handler: handleAuthStatus,
  }))
  /**
   * Paired devices (P4-g): list, add, revoke.
   *
   * Adding returns the token exactly ONCE; the list never carries a token or
   * its hash. Writes need the same authority as any other management write
   * (the machine's own operator, or an unlocked remote session).
   */
  const handleDevices = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (refusedByFence(req, res)) return
    if (!isStateChanging(req.method)) {
      sendJson(res, 200, { ok: true, devices: options.devices.list().map(deviceView) })
      return
    }
    if (!passesCsrfCheck(req)) {
      sendJson(res, 403, { ok: false, error: 'csrf' })
      return
    }
    if (isRemoteReadOnly(req) || needsAdmin(req)) {
      sendJson(res, 403, {
        ok: false,
        error: isRemoteReadOnly(req) ? 'read_only_remote' : 'admin_required',
      })
      return
    }
    let body: Record<string, unknown>
    try {
      const parsed = await readJsonBody(req)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new PreferenceError('request body must be a JSON object')
      }
      body = parsed as Record<string, unknown>
    } catch (error) {
      sendJson(res, 400, { ok: false, error: (error as Error).message })
      return
    }
    try {
      if (body.action === 'approve' || body.action === 'block' || body.action === 'unblock') {
        if (typeof body.id !== 'string') throw new PreferenceError('id must be a string')
        const status: DeviceStatus = body.action === 'approve'
          ? 'approved'
          : body.action === 'block' ? 'blocked' : 'pending'
        const changed = await options.devices.setStatus(body.id, status)
        sendJson(res, changed ? 200 : 404, {
          ok: changed,
          ...(changed ? {} : { error: 'unknown_or_unchanged_device' }),
          devices: options.devices.list().map(deviceView),
          pendingCount: options.devices.list().filter(device => device.status === 'pending').length,
        })
        return
      }
      if (body.action === 'delete') {
        if (typeof body.id !== 'string') throw new PreferenceError('id must be a string')
        const removed = await options.devices.remove(body.id)
        sendJson(res, removed ? 200 : 404, {
          ok: removed,
          ...(removed ? {} : { error: 'unknown_device' }),
          devices: options.devices.list().map(deviceView),
        })
        return
      }
      if (body.action === 'revoke') {
        if (typeof body.id !== 'string') throw new PreferenceError('id must be a string')
        const revoked = await options.devices.revoke(body.id)
        sendJson(res, revoked ? 200 : 404, {
          ok: revoked,
          ...(revoked ? {} : { error: 'unknown_or_revoked_device' }),
          devices: options.devices.list().map(deviceView),
        })
        return
      }
      throw new PreferenceError('action must be "revoke" or "delete"')
    } catch (error) {
      if (error instanceof PreferenceError) {
        sendJson(res, 400, { ok: false, error: error.message })
        return
      }
      logger.warn('device operation failed name=%s', (error as Error).name)
      sendJson(res, 500, { ok: false, error: 'internal_error' })
    }
  }

  disposers.push(options.webServer.register({
    kind: 'exact',
    path: `${MANAGEMENT_BASE}/devices`,
    handler: handleDevices,
  }))

  /**
   * Remote workspace picker: ONE directory level per request.
   *
   * DSH resolves its directory-picker seam once at boot, and on a loopback-only
   * bind with a display that resolution is `native` — the OS folder dialog
   * opens on THIS machine's screen. A browser arriving through the LAN gateway
   * therefore cannot use "添加工作区" at all. The browser half of this plugin
   * shadows the official flow occupant and drives this route instead; the
   * picked path still goes back through DSH's own workspace flow, so nothing is
   * registered here.
   *
   * AUTHORITY: reading the host's directory tree is a privileged operation, so
   * it needs the SAME authority as every other management call — the machine's
   * own operator, or a remote session that unlocked the console. Under the
   * default `local_only` policy a remote device gets `read_only_remote`, which
   * the page explains instead of failing silently.
   *
   * RATE LIMIT: a runaway UI loop must not turn into unbounded filesystem
   * walks. The bucket is keyed by the socket address plus the visitor marker,
   * and because the proxy connects from loopback and does not forward the
   * client address, every proxied visitor shares ONE bucket — this is a runaway
   * guard, not a per-device quota.
   */
  const BROWSE_RATE_LIMIT = 240
  const BROWSE_RATE_WINDOW_MS = 60_000
  const browseBudget = new Map<string, { used: number; resetAtMs: number }>()

  /** Consume one unit from the caller's budget; false when it is exhausted. */
  const overBrowseBudget = (req: IncomingMessage): boolean => {
    const key = `${req.socket.remoteAddress ?? 'unknown'}:${req.headers[VISITOR_HEADER] === undefined ? 'local' : 'visitor'}`
    const now = Date.now()
    if (browseBudget.size > 64) {
      // DSH's own web server is loopback-only, so the key space is tiny; this
      // prune only exists so the map can never grow with the request count.
      for (const [existing, entry] of browseBudget) {
        if (entry.resetAtMs <= now) browseBudget.delete(existing)
      }
    }
    const bucket = browseBudget.get(key)
    if (bucket === undefined || bucket.resetAtMs <= now) {
      browseBudget.set(key, { used: 1, resetAtMs: now + BROWSE_RATE_WINDOW_MS })
      return false
    }
    bucket.used += 1
    return bucket.used > BROWSE_RATE_LIMIT
  }

  const handleWorkspaces = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (refusedByFence(req, res)) return
    if (isRemoteReadOnly(req)) {
      sendJson(res, 403, { ok: false, error: 'read_only_remote' })
      return
    }
    // The SAME authority rule as every other management write: `adminProtection`
    // may waive the unlock, while `local_only` never can (checked just above).
    if (needsAdmin(req)) {
      sendJson(res, 403, { ok: false, error: 'admin_required' })
      return
    }
    if (overBrowseBudget(req)) {
      sendJson(res, 429, { ok: false, error: 'rate_limited' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://dsh-lan-guard.invalid')
    const result = await listDirectories(url.searchParams.get('path'))
    if (result.ok) {
      sendJson(res, 200, result)
      return
    }
    const status = result.error === 'blocked'
      ? 403
      : result.error === 'not_found' ? 404 : result.error === 'unreadable' ? 500 : 400
    sendJson(res, status, result)
  }

  disposers.push(options.webServer.register({
    kind: 'exact',
    path: `${MANAGEMENT_BASE}/workspaces`,
    handler: handleWorkspaces,
  }))

  /**
   * Update detection (SPEC F8). Read-only: it reports what npm has and the
   * settings page offers a copyable command — the host never installs anything.
   */
  disposers.push(options.webServer.register({
    kind: 'exact',
    path: `${MANAGEMENT_BASE}/update`,
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (refusedByFence(req, res)) return
      const url = new URL(req.url ?? '/', 'http://dsh-lan-guard.invalid')
      const status = await options.updates.check({ force: url.searchParams.get('force') === '1' })
      sendJson(res, 200, { ok: true, ...status })
    },
  }))
  disposers.push(options.webServer.register({
    kind: 'exact',
    path: `${MANAGEMENT_BASE}/port-check`,
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (refusedByFence(req, res)) return
      const url = new URL(req.url ?? '/', 'http://dsh-lan-guard.invalid')
      const port = Number.parseInt(url.searchParams.get('port') ?? '', 10)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        sendJson(res, 400, { ok: false, error: 'invalid_port' })
        return
      }
      sendJson(res, 200, { ok: true, port, available: await isPortAvailable(port) })
    },
  }))

  /**
   * Index patches: the remote settings-page unlock, the mobile compatibility
   * shims and the client-side socket watchdog.
   *
   * DSH disables its OFFICIAL settings surface for any page whose address bar
   * is not loopback, which is every device arriving through this gateway; the
   * proxy cannot change that because the decision is made in the visitor's
   * browser. The same tap is where the phone-side shims belong: both are
   * "the served document must carry this", and both read their live switch on
   * every render so a toggle needs only a page refresh.
   */
  const disposePatches = registerIndexPatches({
    webServer: options.webServer,
    switches: {
      settingsUnlock: () => options.switches.settingsUnlock(),
      mobileCompat: () => options.switches.mobileCompat(),
      mobileScrollFix: () => options.switches.mobileScrollFix(),
      socketWatchdog: () => options.switches.socketWatchdog(),
      pwaInstall: () => options.switches.pwaInstall(),
    },
    logger,
  })
  if (disposePatches !== undefined) disposers.push(disposePatches)

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
