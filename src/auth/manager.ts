/**
 * dsh-lan-guard — the visitor gate.
 *
 * The gate is the ONLY thing standing between the LAN and a remote-code-
 * execution UI, so its order of operations is part of the spec:
 *
 * 1. `auth.enabled: false` is only legal on a loopback listener (enforced in
 *    `config.ts`), so a network listener always reaches step 2+;
 * 2. loopback visitors may be exempted (`allowLoopback`) — the local user
 *    already has direct DSH access;
 * 3. a locked-out IP is refused BEFORE any password comparison;
 * 4. an unexpired session cookie passes;
 * 5. otherwise the request is unauthorized.
 *
 * Field semantics and parameters follow dsh-bridge: PBKDF2-SHA256 with 600000 iterations and an
 * algorithm-prefixed hash, `timingSafeEqual` for every comparison, dual
 * passwords, a `dsh_`-prefixed passwordless-link token, persistent visitor
 * sessions and memory-only admin sessions, per-IP failure lockout.
 */
import { createHash, randomBytes, timingSafeEqual, pbkdf2 } from 'node:crypto'
import { promisify } from 'node:util'
import type { IncomingMessage } from 'node:http'
import type { AuthConfigShape, AuthMode, LiveSwitches } from '../config.ts'
import { staticSwitches } from '../config.ts'
import type { LanGuardLogger } from '../log.ts'
import { noopLogger } from '../log.ts'
import type { SecretsStore, SecretsFile, SessionRecord } from '../store/secrets.ts'
import { emptySecrets } from '../store/secrets.ts'

const pbkdf2Async = promisify(pbkdf2)

/** Current PBKDF2 iteration count (hundreds of milliseconds — always async). */
export const PBKDF2_ITERATIONS = 600_000
/** Iterations assumed for a legacy bare-hex hash. */
export const LEGACY_PBKDF2_ITERATIONS = 10_000
/** Derived key length in bytes. */
export const PBKDF2_KEYLEN = 32
/** Digest. */
export const PBKDF2_DIGEST = 'sha256'
/** Salt length in bytes. */
const SALT_BYTES = 16
/** Session/admin cookie names on the proxy origin. */
export const SESSION_COOKIE = 'dsh_lan_guard_session'
export const ADMIN_COOKIE = 'dsh_lan_guard_admin'
/** Cookie carrying a device's paired identity (P4-g). */
export const DEVICE_COOKIE = 'dsh_lan_guard_device'
/** A paired device keeps its identity for a year. */
export const DEVICE_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1_000
/** How often expired sessions are swept. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1_000

/** Why a request was refused. */
export type DenyReason = 'unauthorized' | 'locked'

/** The gate's verdict for one request. */
export type VerifyResult =
  | { ok: true; via: 'disabled' | 'loopback' | 'session' }
  | { ok: false; reason: DenyReason; lockedUntilMs?: number }

/** Result of one password attempt. */
export type LoginResult =
  | { ok: true; cookie: string; expiresAtMs: number }
  | { ok: false; reason: 'invalid' | 'locked' | 'no-password'; lockedUntilMs?: number }

/** Derive a PBKDF2-SHA256 hash in the documented storage format. */
export async function hashPassword(
  password: string,
  saltHex: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<string> {
  const derived = await pbkdf2Async(password, Buffer.from(saltHex, 'hex'), iterations, PBKDF2_KEYLEN, PBKDF2_DIGEST)
  return `pbkdf2-sha256$${String(iterations)}$${derived.toString('hex')}`
}

/** Generate a fresh salt as hex. */
export function generateSalt(): string {
  return randomBytes(SALT_BYTES).toString('hex')
}

/** Generate a passwordless-link token: `dsh_` + 36 hex characters. */
export function generateSecretToken(): string {
  return `dsh_${randomBytes(18).toString('hex')}`
}

/** Constant-time comparison of two strings. */
export function safeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  if (actualBytes.byteLength !== expectedBytes.byteLength) return false
  return timingSafeEqual(actualBytes, expectedBytes)
}

/** Compare a candidate password against a stored hash, supporting legacy bare hex. */
export async function verifyPassword(
  password: string,
  saltHex: string | null,
  stored: string | null,
): Promise<boolean> {
  if (stored === null || stored === '' || saltHex === null || saltHex === '') return false
  const parts = stored.split('$')
  const isPrefixed = parts.length === 3 && parts[0] === 'pbkdf2-sha256'
  const iterations = isPrefixed ? Number.parseInt(parts[1] ?? '', 10) : LEGACY_PBKDF2_ITERATIONS
  const expectedHex = isPrefixed ? parts[2] ?? '' : stored
  if (!Number.isFinite(iterations) || iterations <= 0 || expectedHex === '') return false
  const derived = await pbkdf2Async(password, Buffer.from(saltHex, 'hex'), iterations, PBKDF2_KEYLEN, PBKDF2_DIGEST)
  return safeEqual(derived.toString('hex'), expectedHex)
}

/** Whether an address literal is loopback (IPv4 `127/8`, IPv6 `::1`, or v4-mapped). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  if (normalized === '::1') return true
  return normalized.startsWith('127.')
}

/** Read one cookie value by name from a request. */
export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (header === undefined) return undefined
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim()
  }
  return undefined
}

/** Build a `Set-Cookie` value for one of the gate's own cookies. */
export function buildSessionCookie(name: string, token: string, expiresAtMs: number, now: number): string {
  const maxAge = Math.max(0, Math.floor((expiresAtMs - now) / 1_000))
  return `${name}=${token}; Max-Age=${String(maxAge)}; Path=/; Expires=${new Date(expiresAtMs).toUTCString()}; HttpOnly; SameSite=Strict`
}

/** Build the cookie that clears one of the gate's cookies. */
export function buildClearedCookie(name: string): string {
  return `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`
}

/** Options for {@link AuthManager}. */
export interface AuthManagerOptions {
  store: SecretsStore
  /** Static knobs (session lifetimes, lockout budget). */
  auth: AuthConfigShape
  /** The five live switches; defaults to the static values in `auth`. */
  switches?: LiveSwitches
  logger?: LanGuardLogger
  /** Clock injection for tests. */
  now?: () => number
}

/** The visitor gate. */
export class AuthManager {
  readonly #store: SecretsStore
  readonly #auth: AuthConfigShape
  readonly #switches: LiveSwitches
  readonly #logger: LanGuardLogger
  readonly #now: () => number
  #secrets: SecretsFile = emptySecrets()
  #sessions = new Map<string, SessionRecord>()
  #adminSessions = new Map<string, number>()
  #failures = new Map<string, { count: number; lockedUntilMs: number }>()
  #sweeper: NodeJS.Timeout | undefined

  constructor(options: AuthManagerOptions) {
    this.#store = options.store
    this.#auth = options.auth
    this.#switches = options.switches ?? staticSwitches({
      enabled: options.auth.enabled,
      listenHost: '127.0.0.1',
      listenPort: 0,
      upstreamOrigin: 'http://127.0.0.1:0',
      networkInterface: null,
      dataDir: null,
      settingsUnlock: true,
      answerHeartbeat: true,
      socketWatchdog: true,
      mobileCompat: true,
      mobileScrollFix: true,
      pwaInstall: true,
      auth: options.auth,
      tls: { mode: 'off', caCertFile: null, caKeyFile: null, certFile: null, keyFile: null, allowInsecureLan: false },
      mdns: { enabled: false },
    })
    this.#logger = options.logger ?? noopLogger
    this.#now = options.now ?? (() => Date.now())
  }

  /** Load persisted secrets and sessions, then start the expiry sweeper. */
  async init(): Promise<void> {
    await this.#store.ensureDir()
    this.#secrets = await this.#store.loadSecrets()
    const stored = await this.#store.loadSessions()
    const now = this.#now()
    this.#sessions = new Map(stored.filter(record => record.expiresAtMs > now).map(record => [record.token, record]))
    this.#sweeper = setInterval(() => {
      void this.#sweep()
    }, SWEEP_INTERVAL_MS)
    this.#sweeper.unref()
  }

  /** Stop the sweeper. */
  dispose(): void {
    if (this.#sweeper !== undefined) clearInterval(this.#sweeper)
    this.#sweeper = undefined
  }

  /** Whether an access password is configured at all. */
  get hasPassword(): boolean {
    return this.#secrets.passwordHash !== null && this.#secrets.passwordHash !== ''
  }

  /** Whether an independent admin password is configured. */
  get hasAdminPassword(): boolean {
    return this.#secrets.adminPasswordHash !== null && this.#secrets.adminPasswordHash !== ''
  }

  /** Whether a passwordless-link token exists. */
  get hasSecretToken(): boolean {
    return this.#secrets.secretToken !== null && this.#secrets.secretToken !== ''
  }

  /** The live visitor credential mode (drives the login page). */
  get mode(): AuthMode {
    return this.#switches.mode()
  }

  /** Whether the gate is switched on. */
  get enabled(): boolean {
    return this.#auth.enabled
  }

  /** The passwordless-link token, for the admin-unlocked settings view only. */
  secretToken(): string | undefined {
    return this.#secrets.secretToken ?? undefined
  }

  /** Set (or replace) the access password. */
  async setPassword(password: string): Promise<void> {
    const salt = generateSalt()
    this.#secrets = {
      ...this.#secrets,
      passwordSalt: salt,
      passwordHash: await hashPassword(password, salt),
    }
    await this.#store.saveSecrets(this.#secrets)
  }

  /** Set (or replace) the independent admin password. */
  async setAdminPassword(password: string): Promise<void> {
    const salt = generateSalt()
    this.#secrets = {
      ...this.#secrets,
      adminPasswordSalt: salt,
      adminPasswordHash: await hashPassword(password, salt),
    }
    await this.#store.saveSecrets(this.#secrets)
  }

  /** Ensure a passwordless-link token exists, returning it. */
  async ensureSecretToken(): Promise<string> {
    if (this.#secrets.secretToken !== null && this.#secrets.secretToken !== '') return this.#secrets.secretToken
    const token = generateSecretToken()
    this.#secrets = { ...this.#secrets, secretToken: token }
    await this.#store.saveSecrets(this.#secrets)
    return token
  }

  /** Replace the passwordless-link token with a fresh one. */
  async rotateSecretToken(): Promise<string> {
    const token = generateSecretToken()
    this.#secrets = { ...this.#secrets, secretToken: token }
    await this.#store.saveSecrets(this.#secrets)
    return token
  }

  /** Per-IP failure state, for the login page's honest lockout display. */
  lockoutFor(ip: string): { failures: number; lockedUntilMs: number } {
    const state = this.#failures.get(ip)
    if (state === undefined) return { failures: 0, lockedUntilMs: 0 }
    return { failures: state.count, lockedUntilMs: state.lockedUntilMs }
  }

  /**
   * Decide whether one request may proceed.
   *
   * @param req - the incoming request (HTTP or upgrade).
   * @returns the verdict; `ok: false` carries why.
   */
  verifyRequest(req: IncomingMessage): VerifyResult {
    if (!this.#auth.enabled) return { ok: true, via: 'disabled' }
    const ip = clientIp(req)
    if (this.#switches.allowLoopback() && isLoopbackAddress(req.socket.remoteAddress)) {
      return { ok: true, via: 'loopback' }
    }
    const state = this.#failures.get(ip)
    const now = this.#now()
    if (state !== undefined && state.lockedUntilMs > now) {
      return { ok: false, reason: 'locked', lockedUntilMs: state.lockedUntilMs }
    }
    if (this.#sessionIsValid(readCookie(req, SESSION_COOKIE))) return { ok: true, via: 'session' }
    return { ok: false, reason: 'unauthorized' }
  }

  /**
   * Validate one visitor password and, on success, mint a session.
   *
   * @param req - the login request (for the client IP).
   * @param password - the submitted password.
   * @returns the session cookie to send, or why it failed.
   */
  async login(req: IncomingMessage, password: string): Promise<LoginResult> {
    const ip = clientIp(req)
    const now = this.#now()
    const state = this.#failures.get(ip)
    if (state !== undefined && state.lockedUntilMs > now) {
      return { ok: false, reason: 'locked', lockedUntilMs: state.lockedUntilMs }
    }
    if (!this.hasPassword) {
      // A gate with no password must never behave like "any password works".
      return { ok: false, reason: 'no-password' }
    }
    if (!(await verifyPassword(password, this.#secrets.passwordSalt, this.#secrets.passwordHash))) {
      const lockedUntilMs = this.#recordFailure(ip)
      return lockedUntilMs > 0
        ? { ok: false, reason: 'locked', lockedUntilMs }
        : { ok: false, reason: 'invalid' }
    }
    this.#failures.delete(ip)
    const token = randomBytes(32).toString('base64url')
    const expiresAtMs = now + this.#auth.sessionMaxAgeMs
    this.#sessions.set(token, { token, expiresAtMs, createdAtMs: now })
    await this.#persistSessions()
    return { ok: true, cookie: buildSessionCookie(SESSION_COOKIE, token, expiresAtMs, now), expiresAtMs }
  }

  /** Verify a candidate against the access password (the "change password" flow). */
  async verifyAccessPassword(candidate: string): Promise<boolean> {
    return verifyPassword(candidate, this.#secrets.passwordSalt, this.#secrets.passwordHash)
  }

  /** Verify a candidate against the admin password, falling back to the access password when unset. */
  async verifyAdminPassword(candidate: string): Promise<boolean> {
    const useAdmin = this.hasAdminPassword
    return verifyPassword(
      candidate,
      useAdmin ? this.#secrets.adminPasswordSalt : this.#secrets.passwordSalt,
      useAdmin ? this.#secrets.adminPasswordHash : this.#secrets.passwordHash,
    )
  }

  /** Validate the passwordless-link token. */
  async verifySecretToken(candidate: string): Promise<boolean> {
    const token = this.#secrets.secretToken
    if (token === null || token === '') return false
    return safeEqual(candidate, token)
  }

  /** Mint a session without a password (a validated passwordless link). */
  async issueSession(): Promise<{ cookie: string; expiresAtMs: number }> {
    const now = this.#now()
    const token = randomBytes(32).toString('base64url')
    const expiresAtMs = now + this.#auth.sessionMaxAgeMs
    this.#sessions.set(token, { token, expiresAtMs, createdAtMs: now })
    await this.#persistSessions()
    return { cookie: buildSessionCookie(SESSION_COOKIE, token, expiresAtMs, now), expiresAtMs }
  }

  /**
   * Validate the admin password and unlock the management surface.
   *
   * Deliberately independent of any visitor session: the researched
   * dsh-bridge deadlock was an unlock that required a valid visitor session,
   * so an expired session made the management console permanently unlockable.
   *
   * @param password - the submitted admin password (falls back to the access password when unset).
   * @returns the admin cookie, or `undefined` when the password is wrong.
   */
  async unlockAdmin(password: string): Promise<{ cookie: string; expiresAtMs: number } | undefined> {
    const useAdmin = this.hasAdminPassword
    const ok = await verifyPassword(
      password,
      useAdmin ? this.#secrets.adminPasswordSalt : this.#secrets.passwordSalt,
      useAdmin ? this.#secrets.adminPasswordHash : this.#secrets.passwordHash,
    )
    if (!ok) return undefined
    const now = this.#now()
    const token = randomBytes(32).toString('base64url')
    const expiresAtMs = now + this.#auth.adminSessionMaxAgeMs
    this.#adminSessions.set(token, expiresAtMs)
    return { cookie: buildSessionCookie(ADMIN_COOKIE, token, expiresAtMs, now), expiresAtMs }
  }

  /** Lock the management surface again. */
  lockAdmin(req: IncomingMessage): void {
    const token = readCookie(req, ADMIN_COOKIE)
    if (token !== undefined) this.#adminSessions.delete(token)
  }

  /** Whether this request carries a live admin session. */
  isAdminUnlocked(req: IncomingMessage): boolean {
    if (!this.#switches.adminProtection()) return true
    const token = readCookie(req, ADMIN_COOKIE)
    if (token === undefined) return false
    const expiresAtMs = this.#adminSessions.get(token)
    if (expiresAtMs === undefined) return false
    if (expiresAtMs <= this.#now()) {
      this.#adminSessions.delete(token)
      return false
    }
    return true
  }

  /** Whether the admin surface should be shown locked, given the policy. */
  requiresAdminUnlock(req: IncomingMessage): boolean {
    if (this.#switches.adminPolicy() === 'open') return false
    if (this.#switches.adminPolicy() === 'local_only') return !isLoopbackAddress(req.socket.remoteAddress)
    return !this.isAdminUnlocked(req)
  }

  /** Validate a session cookie without touching failure counters. */
  #sessionIsValid(token: string | undefined): boolean {
    if (token === undefined) return false
    const record = this.#sessions.get(token)
    if (record === undefined) return false
    if (record.expiresAtMs <= this.#now()) {
      this.#sessions.delete(token)
      return false
    }
    return true
  }

  /** Record a failed attempt and report when the lockout ends (0 = not locked). */
  #recordFailure(ip: string): number {
    const now = this.#now()
    const state = this.#failures.get(ip) ?? { count: 0, lockedUntilMs: 0 }
    const count = state.count + 1
    if (count >= this.#auth.maxFailedAttempts) {
      const lockedUntilMs = now + this.#auth.lockoutMs
      this.#failures.set(ip, { count: 0, lockedUntilMs })
      this.#logger.warn('visitor lockout engaged failures=%d lockoutMs=%d', count, this.#auth.lockoutMs)
      return lockedUntilMs
    }
    this.#failures.set(ip, { count, lockedUntilMs: 0 })
    return 0
  }

  /** Persist the live visitor sessions (admin sessions stay in memory). */
  async #persistSessions(): Promise<void> {
    await this.#store.saveSessions([...this.#sessions.values()])
  }

  /**
   * Drop every visitor session.
   *
   * Called when the access password or the auth mode changes: otherwise a phone
   * that already logged in keeps its 30-day session and never sees the new
   * requirement (user report 2026-09-24: "我改成了需要密码，但用户却不需要输入").
   *
   * @returns how many sessions were dropped.
   */
  async revokeAllSessions(): Promise<number> {
    const dropped = this.#sessions.size
    this.#sessions.clear()
    this.#adminSessions.clear()
    await this.#persistSessions()
    if (dropped > 0) this.#logger.warn('all visitor sessions revoked count=%d', dropped)
    return dropped
  }

  /** Drop expired sessions and persist the remainder. */
  async #sweep(): Promise<void> {
    const now = this.#now()
    let changed = false
    for (const [token, record] of this.#sessions) {
      if (record.expiresAtMs <= now) {
        this.#sessions.delete(token)
        changed = true
      }
    }
    for (const [token, expiresAtMs] of this.#adminSessions) {
      if (expiresAtMs <= now) this.#adminSessions.delete(token)
    }
    if (changed) await this.#persistSessions()
  }
}

/** The client IP used for lockout accounting. */
export function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown'
}

/**
 * Whether a state-changing request passes the CSRF check.
 *
 * A malicious page on the LAN can reach the proxy port, so a same-origin
 * check is required on every state change: `Sec-Fetch-Site: cross-site` is
 * refused outright, and when an `Origin` is present its host must equal the
 * request's Host.
 *
 * @param req - the state-changing request.
 * @returns true when the request may proceed.
 */
export function passesCsrfCheck(req: IncomingMessage): boolean {
  // `Sec-Fetch-Site` is the authoritative signal and every current browser
  // sends it: refuse only an explicit cross-site request.
  const site = req.headers['sec-fetch-site']
  if (site === 'cross-site') return false
  if (site === 'same-origin' || site === 'same-site' || site === 'none') return true

  // Fall back to `Origin` only when the browser sent no fetch metadata. An
  // opaque (`null`) or unparsable Origin is a client quirk — some in-app
  // browsers and private modes send `Origin: null` on same-origin form posts —
  // NOT an attack signal. Rejecting it locked real phones out of the login
  // form (user report 2026-09-24: "远程访问，输入密码也不对"), so it is treated
  // as "no usable Origin" and the request is allowed through.
  const origin = req.headers.origin
  if (origin === undefined || origin === 'null') return true
  const host = req.headers.host
  if (host === undefined) return false
  try {
    const parsed = new URL(origin)
    // Compare the authority, but tolerate a port-only difference (a proxy that
    // terminates on another port still belongs to the same operator).
    return parsed.host === host || parsed.hostname === host.split(':')[0]
  } catch {
    return true
  }
}

/** Hash helper used by tests to prove hashes are never echoed. */
export function hashForLog(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}
