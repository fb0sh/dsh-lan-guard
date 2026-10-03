/**
 * dsh-lan-guard — the non-sensitive configuration model.
 *
 * Everything here lands in a profile patch file (`cordis.patch.yml`), which is
 * plain text a user may share or commit, so NO credential ever belongs in this
 * schema. Passwords, hashes and the
 * passwordless-link token live in the plugin's private dataDir instead.
 *
 * This module owns two things:
 *
 * - `Config`: the Schemastery schema the Loader validates the entry with. On
 *   DSH 0.1.7 a plugin's own `Config` IS its settings form (Config-derived
 *   forms), which is why the field set below is the documented SPEC §5 field
 *   set rather than an internal one.
 * - `parseConfig`: the semantic checks Schemastery cannot express (loopback
 *   upstream, literal listen address, the `auth.enabled === false` bind rule,
 *   and the resolution of `dataDir`, whose default is derived from the active
 *   profile rather than demanded from the operator). Invalid values must be
 *   REJECTED — a silently widened default is the failure mode this module
 *   exists to prevent.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Gate mode. `scope` is deliberately absent — this project has one LAN channel. */
export type AuthMode = 'password' | 'token' | 'token_and_password'

/** Who may reach the management surface. */
export type AdminPolicy = 'password_unlock' | 'local_only' | 'open'

/** Certificate source. */
export type TlsMode = 'self-signed' | 'provided' | 'off'

/** The `auth` block of the config. */
export interface AuthConfigShape {
  /** Master switch for the visitor-side gate. `false` is only legal on a loopback listener. */
  enabled: boolean
  /** Which visitor credentials are accepted. */
  mode: AuthMode
  /** How the management surface unlocks. */
  adminPolicy: AdminPolicy
  /** Whether management operations need an explicit admin unlock on top of a session. */
  adminProtection: boolean
  /** Whether loopback visitors skip the gate (the local user already has direct DSH access). */
  allowLoopback: boolean
  /** Whether a new device must name itself once before it is let in (P4-g). */
  requirePairing: boolean
  /** Whether a new device also needs an operator's approval before it is let in (F9). */
  requireApproval: boolean
  /** Visitor session lifetime in milliseconds. */
  sessionMaxAgeMs: number
  /** Admin session lifetime in milliseconds (in-memory only, so it is deliberately short). */
  adminSessionMaxAgeMs: number
  /** Failed attempts per IP before the lockout window opens. */
  maxFailedAttempts: number
  /** Lockout window in milliseconds. */
  lockoutMs: number
}

/** The `tls` block of the config. */
export interface TlsConfigShape {
  /** Certificate source; `self-signed` is the default. */
  mode: TlsMode
  /** PEM CA certificate for `mode: 'provided'`. */
  caCertFile: string | null
  /** PEM CA private key for `mode: 'provided'`. */
  caKeyFile: string | null
  /** PEM leaf certificate for `mode: 'provided'`. */
  certFile: string | null
  /** PEM leaf private key for `mode: 'provided'`. */
  keyFile: string | null
  /**
   * Explicit acknowledgement required to serve plain HTTP on a NON-loopback
   * listener (P4-e). Defaults to false: the gate password and the upstream
   * cookie would travel the LAN in clear text.
   */
  allowInsecureLan: boolean
}

/** The full non-sensitive config shape. */
export interface MdnsConfigShape {
  /** Whether to advertise the console over mDNS/DNS-SD (off by default). */
  enabled: boolean
}

export interface LanGuardConfigShape {
  /** Plugin master switch; `false` registers nothing and opens no listener. */
  enabled: boolean
  /** Bind address: loopback, all interfaces, or one NIC literal. */
  listenHost: string
  /** Proxy port; `0` asks the OS for a free port (tests only). */
  listenPort: number
  /** The loopback origin requests are forwarded to. */
  upstreamOrigin: string
  /** Optional NIC selector. */
  networkInterface: string | null
  /** Private directory for sensitive state; explicit value wins, otherwise derived from the profile. */
  dataDir: string | null
  /**
   * Whether LAN visitors get DSH's OFFICIAL settings surface (default true).
   *
   * DSH disables that surface for any page whose address bar is not loopback
   * (`persistence = isLoopback ? "host" : "memory"`), which is every device
   * that reaches this machine through the gateway. When this switch is on, the
   * served index carries the `ownsHost` flag DSH's own desktop shell sets, so
   * Settings → Models and the other official pages work from the LAN too.
   *
   * It is a UI unlock, not a new transport privilege: the settings RPC is
   * already reachable for anything that passes the gate (reads are redacted by
   * DSH), and writes stay bounded by this plugin's gate and admin policy.
   */
  settingsUnlock: boolean
  /**
   * Whether the proxy answers DSH's WebSocket Ping frames itself (default true).
   *
   * Measured 2026-09-28: the host pings `/api/remote.mux` every 2 s and drops a
   * socket after two unanswered pings, so a phone that is suspended (screen
   * locked, switched away) loses the session socket after 6 s and the chat
   * transcript — which is the only part of the UI that rides that socket — never
   * finishes loading. Answering from the proxy hop keeps the tunnel alive; the
   * visitor's own Pong, when it comes, is a harmless duplicate.
   */
  answerHeartbeat: boolean
  /**
   * Whether the served index carries the client-side socket watchdog (default
   * true). It closes sockets stuck in CONNECTING and, when a resume from the
   * background leaves nothing open, reloads the page once — the only recovery
   * from WebKit's "WebSocket never opens after resume" behaviour.
   */
  socketWatchdog: boolean
  /**
   * Whether the served index carries mobile compatibility shims (default true):
   * `AbortSignal.any`/`timeout`, `Promise.withResolvers`, the `Iterator` global
   * and the mobile viewport/PWA metas. DSH's client throws inside its stream
   * path on engines without them, which leaves the chat stuck on
   * 「载入历史…」 with no error message at all.
   */
  mobileCompat: boolean
  /**
   * Whether the served index carries the narrow-screen scroll correction
   * (default true). Measured 2026-09-28: on a phone DSH's own shell clips the
   * conversation column behind its fixed floats, so the chat cannot be dragged;
   * desktop Chrome on the same viewport scrolls fine. The injected script only
   * acts when the page as a whole cannot scroll and it finds a layer that is
   * clipping overflowing content.
   */
  mobileScrollFix: boolean
  /**
   * Whether the served index registers the installability service worker
   * (default true).
   *
   * This is what turns "create shortcut" into "install as an app" on Android:
   * Chromium refuses the install entry for an origin with no service worker,
   * and DSH registers none. The worker itself does nothing — see `pwa.ts` —
   * so the switch exists for an operator who does not want a registration
   * surviving on every visitor's device.
   */
  pwaInstall: boolean
  /** Visitor-side gate configuration. */
  auth: AuthConfigShape
  /** Transport security configuration. */
  tls: TlsConfigShape
  /** Optional mDNS advertisement (P4-d). */
  mdns: MdnsConfigShape
}

/**
 * Default bind address: every interface, because this plugin's whole purpose is
 * LAN access and a fresh install must work after ONE restart.
 *
 * The exposure is gated, not silent: `auth.enabled` defaults to true and a
 * fresh install has NO access password, so the gate refuses every device until
 * one is set; TLS defaults to self-signed, so nothing travels in clear. The
 * settings page offers a 「仅本机」 switch for anyone who wants loopback only.
 */
export const DEFAULT_LISTEN_HOST = '0.0.0.0'
/**
 * Default proxy port: DSH's own port + 1, which is the mental model the user
 * asked for ("3081, 3082, 3083 … take the first free one"). It stays clear of
 * 3080 (DSH itself), 3443 (dsh-mobile gateway) and 3444 (dsh-mobile origin).
 */
export const DEFAULT_LISTEN_PORT = 3081
/** How many consecutive ports to try when the configured one is taken. */
export const LISTEN_PORT_PROBE_ATTEMPTS = 10
/** Default upstream: DSH's own loopback web server. */
export const DEFAULT_UPSTREAM_ORIGIN = 'http://127.0.0.1:3080'

/**
 * The entry's config schema. Also the `dsh-lan-guard` settings form on DSH
 * 0.1.7 — the Loader entry id is the form namespace, so this object must stay
 * the documented field set.
 *
 * The NON-SENSITIVE switches  are `.volatile()`: an edit
 * commits into the running references and emits a volatile update instead of
 * remounting the plugin, and the host `settings` service refuses to write any
 * path that is not volatile. A volatile field's runtime
 * value is a stable reference with `get()`, not the bare value —
 * {@link parseConfig} unwraps it, and {@link liveSwitches} keeps the reference
 * so later edits are visible without a restart.
 *
 * `listenHost` is volatile too, and deliberately so: the settings page offers a
 * 「仅本机 / 局域网」 switch, and a switch the operator cannot write is worse
 * than no switch. The BIND still happens once at startup from the resolved
 * value, so the switch takes effect on the next dsh restart — the same contract
 * `listenPort` already has.
 *
 * NOTE on the nullable fields: Schemastery treats a `null` default as "no
 * fallback" (`if (isNullable(fallback)) return [data]`), so a field declared
 * `.default(null)` stays `undefined` when omitted. The documented `null`
 * defaults are therefore expressed as an empty string in the schema and
 * normalized back to `null` in {@link parseConfig} — an explicit `null` in a
 * patch file is accepted and normalized the same way.
 */
export const Config: z<LanGuardConfigShape, Record<string, unknown>> = z.object({
  enabled: z.boolean().default(true).volatile(),
  listenHost: z.string().default(DEFAULT_LISTEN_HOST).volatile(),
  listenPort: z.natural().max(65535).default(DEFAULT_LISTEN_PORT).volatile(),
  upstreamOrigin: z.string().default(DEFAULT_UPSTREAM_ORIGIN),
  networkInterface: z.string().default('').volatile(),
  // Optional on purpose: omitted means "derive <profileDir>/data/dsh-lan-guard"
  // (see resolveDataDir), so a fresh install needs no hand-written config. An
  // explicit value — including one using `~` — still wins.
  dataDir: z.string().default(''),
  // Volatile so the settings page can flip it, and read per index render: a
  // change needs only a page refresh, never a restart. Default ON because the
  // plugin's whole purpose is LAN access and the gate — not this switch — is
  // what protects the surface; an operator who wants DSH's stock behaviour
  // turns it off.
  settingsUnlock: z.boolean().default(true).volatile(),
  // The three mobile-resilience switches (2026-09-28). All default ON because
  // the failure they prevent is invisible until it happens, and each is
  // individually switchable for an operator who wants the stock proxy.
  answerHeartbeat: z.boolean().default(true).volatile(),
  socketWatchdog: z.boolean().default(true).volatile(),
  mobileCompat: z.boolean().default(true).volatile(),
  mobileScrollFix: z.boolean().default(true).volatile(),
  // Independent of mobileCompat on purpose: the shims patch an API for one
  // page, while a service worker is a registration that outlives it.
  pwaInstall: z.boolean().default(true).volatile(),
  auth: z.object({
    // NOT volatile on purpose (PLAN §5 工作项 9 lists the writable switches):
    // the gate master switch is a startup-safety field (SPEC §5 principle 3),
    // so it must not be editable at runtime while the gate reads it statically.
    enabled: z.boolean().default(true),
    mode: z.union([z.const('password'), z.const('token'), z.const('token_and_password')])
      .default('token_and_password').volatile(),
    adminPolicy: z.union([z.const('password_unlock'), z.const('local_only'), z.const('open')])
      .default('local_only').volatile(),
    adminProtection: z.boolean().default(true).volatile(),
    allowLoopback: z.boolean().default(true).volatile(),
    requirePairing: z.boolean().default(true).volatile(),
    requireApproval: z.boolean().default(false).volatile(),
    sessionMaxAgeMs: z.natural().default(2_592_000_000),
    adminSessionMaxAgeMs: z.natural().default(1_800_000),
    maxFailedAttempts: z.natural().default(5),
    lockoutMs: z.natural().default(60_000),
  }),
  tls: z.object({
    mode: z.union([z.const('self-signed'), z.const('provided'), z.const('off')]).default('self-signed'),
    caCertFile: z.string().default(''),
    caKeyFile: z.string().default(''),
    certFile: z.string().default(''),
    keyFile: z.string().default(''),
    allowInsecureLan: z.boolean().default(false),
  }),
  mdns: z.object({
    enabled: z.boolean().default(false),
  }),
})

/** The live, non-sensitive switches. */
export interface LiveSwitches {
  /** Plugin master switch. */
  enabled(): boolean
  /** Selected NIC / address, or `null` for "pick automatically". */
  networkInterface(): string | null
  /** Configured listen port (applies on the next start). */
  listenPort(): number
  /** Configured bind address (applies on the next start). */
  listenHost(): string
  /** Visitor credential mode. */
  mode(): AuthMode
  /** Management unlock policy. */
  adminPolicy(): AdminPolicy
  /** Whether management operations need an explicit unlock. */
  adminProtection(): boolean
  /** Whether loopback visitors skip the gate. */
  allowLoopback(): boolean
  /** Whether LAN visitors get DSH's official settings surface. */
  settingsUnlock(): boolean
  /** Whether the proxy answers DSH's WebSocket heartbeat while a visitor is suspended. */
  answerHeartbeat(): boolean
  /** Whether the served index carries the client-side socket watchdog. */
  socketWatchdog(): boolean
  /** Whether the served index carries the mobile compatibility shims. */
  mobileCompat(): boolean
  /** Whether the served index carries the narrow-screen scroll correction. */
  mobileScrollFix(): boolean
  /** Whether the served index registers the installability service worker. */
  pwaInstall(): boolean
  /** Whether an unnamed device must pair before it is let in. */
  requirePairing(): boolean
  /** Whether a paired device still needs the operator's approval (F9). */
  requireApproval(): boolean
}

/** Whether a resolved value is a volatile reference rather than a bare value. */
function isVolatileLike(value: unknown): value is { get(): unknown } {
  return typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function'
}

/** Read a possibly-volatile field, falling back when absent. */
function readField<T>(value: unknown, fallback: T): T {
  if (isVolatileLike(value)) return value.get() as T
  return value === undefined || value === null ? fallback : value as T
}

/**
 * Build the live switch accessors over a raw Loader config.
 *
 * When the Loader resolved the schema, the fields are volatile references, so
 * an edit made through the settings service is visible immediately. Tests and
 * plain objects fall back to the resolved values.
 *
 * @param rawConfig - the config as `apply` received it.
 * @param resolved - the normalized config from {@link parseConfig}.
 * @returns accessors for the writable switches.
 */
export function liveSwitches(rawConfig: unknown, resolved: LanGuardConfigShape): LiveSwitches {
  const root = (typeof rawConfig === 'object' && rawConfig !== null ? rawConfig : {}) as Record<string, unknown>
  const auth = (typeof root.auth === 'object' && root.auth !== null ? root.auth : {}) as Record<string, unknown>
  return {
    enabled: () => readField(root.enabled, resolved.enabled),
    networkInterface: () => emptyToNull(readField(root.networkInterface, '')),
    listenPort: () => readField(root.listenPort, resolved.listenPort),
    listenHost: () => readField(root.listenHost, resolved.listenHost),
    settingsUnlock: () => readField(root.settingsUnlock, resolved.settingsUnlock),
    answerHeartbeat: () => readField(root.answerHeartbeat, resolved.answerHeartbeat),
    socketWatchdog: () => readField(root.socketWatchdog, resolved.socketWatchdog),
    mobileCompat: () => readField(root.mobileCompat, resolved.mobileCompat),
    mobileScrollFix: () => readField(root.mobileScrollFix, resolved.mobileScrollFix),
    pwaInstall: () => readField(root.pwaInstall, resolved.pwaInstall),
    mode: () => readField(root.auth === undefined ? undefined : auth.mode, resolved.auth.mode),
    adminPolicy: () => readField(root.auth === undefined ? undefined : auth.adminPolicy, resolved.auth.adminPolicy),
    adminProtection: () => readField(
      root.auth === undefined ? undefined : auth.adminProtection,
      resolved.auth.adminProtection,
    ),
    allowLoopback: () => readField(root.auth === undefined ? undefined : auth.allowLoopback, resolved.auth.allowLoopback),
    requirePairing: () => readField(root.auth === undefined ? undefined : auth.requirePairing, resolved.auth.requirePairing),
    requireApproval: () => readField(
      root.auth === undefined ? undefined : auth.requireApproval,
      resolved.auth.requireApproval,
    ),
  }
}

/** Wrap plain values as live switches (used by tests and by callers without a raw config). */
export function staticSwitches(config: LanGuardConfigShape): LiveSwitches {
  return {
    enabled: () => config.enabled,
    networkInterface: () => config.networkInterface,
    listenPort: () => config.listenPort,
    listenHost: () => config.listenHost,
    settingsUnlock: () => config.settingsUnlock,
    answerHeartbeat: () => config.answerHeartbeat,
    socketWatchdog: () => config.socketWatchdog,
    mobileCompat: () => config.mobileCompat,
    mobileScrollFix: () => config.mobileScrollFix,
    pwaInstall: () => config.pwaInstall,
    mode: () => config.auth.mode,
    adminPolicy: () => config.auth.adminPolicy,
    adminProtection: () => config.auth.adminProtection,
    allowLoopback: () => config.auth.allowLoopback,
    requirePairing: () => config.auth.requirePairing,
    requireApproval: () => config.auth.requireApproval,
  }
}

/** Raised when a config value is syntactically valid but semantically unsafe. */
export class LanGuardConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LanGuardConfigError'
  }
}

const IPV4_LITERAL = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/** Whether an address literal is IPv4. Hostnames are rejected on purpose: a name can be re-resolved. */
export function isIpv4Literal(value: string): boolean {
  if (!IPV4_LITERAL.test(value)) return false
  return value.split('.').every(part => Number(part) <= 255)
}

/** Whether a host literal is loopback (IPv4 `127/8`, IPv6 `::1`, or `localhost`). */
export function isLoopbackHost(value: string): boolean {
  if (value === 'localhost' || value === '::1' || value === '[::1]') return true
  if (!isIpv4Literal(value)) return false
  return value.split('.')[0] === '127'
}

/** Whether an origin URL points at this machine's loopback interface. */
export function isLoopbackOrigin(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return isLoopbackHost(url.hostname)
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LanGuardConfigError(`dsh-lan-guard: ${field} must be a non-empty string`)
  }
  return value
}

/** Map an absent-or-blank optional path to the documented `null`. */
function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** Directory this plugin owns under the active profile's `data` directory. */
export const DATA_DIR_NAME = 'dsh-lan-guard'

/** Where a resolved private-state directory came from. */
export type DataDirSource = 'config' | 'profile'

/** A resolved private-state directory plus its provenance. */
export interface DataDirResolution {
  /** Directory holding secrets, devices and sessions. */
  dir: string
  /** `config` for an explicit `dataDir`, `profile` for the derived default. */
  source: DataDirSource
}

/**
 * Expand a leading `~` against the OS home.
 *
 * Local on purpose: `@deepseek-ai/dsh-home-paths` would be a new runtime
 * dependency for three lines.
 *
 * @param value - a configured path that may start with `~`.
 * @returns the expanded path, or the value unchanged.
 */
export function expandTilde(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * Resolve the private-state directory.
 *
 * Precedence:
 *
 * 1. an explicit `dataDir` from this entry's config — the documented override;
 * 2. `<profileDir>/data/dsh-lan-guard`, derived from DSH's own `profileContext`.
 *
 * The plugin still refuses to guess from its OWN module location: a profile may
 * link the package and Node resolves symlinks, so `import.meta.url` can point at
 * a checkout rather than the profile. A host that can
 * name neither source gets an error instead of a silently shared directory.
 *
 * @param rawConfig - the raw Loader config (a volatile reference is unwrapped).
 * @param profileDir - the active profile directory, when the host can name it.
 * @returns the resolution, or `null` when neither source is available.
 */
export function resolveDataDir(rawConfig: unknown, profileDir?: string | undefined): DataDirResolution | null {
  const root = (typeof rawConfig === 'object' && rawConfig !== null ? rawConfig : {}) as Record<string, unknown>
  const raw = root.dataDir
  const value = isVolatileLike(raw) ? raw.get() : raw
  const explicit = typeof value === 'string' ? emptyToNull(value) : null
  if (explicit !== null) return { dir: expandTilde(explicit), source: 'config' }
  const derived = emptyToNull(profileDir)
  if (derived === null) return null
  return { dir: join(expandTilde(derived), 'data', DATA_DIR_NAME), source: 'profile' }
}

/**
 * Unwrap the volatile references of an already-resolved config.
 *
 * The Loader validates the entry through this schema BEFORE calling `apply`,
 * so at runtime `apply` receives the RESOLVED config: the five volatile
 * switches are `{ get() }` references, not booleans. Re-validating that value
 * as if it were the raw patch would reject it, so the references are unwrapped
 * first. Raw patches (tests, direct callers) pass through untouched.
 *
 * @param input - a raw patch or an already-resolved config.
 * @returns the same shape with volatile references replaced by their values.
 */
function unwrapVolatileInput(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input
  const source = input as Record<string, unknown>
  const result: Record<string, unknown> = { ...source }
  for (const key of [
    'enabled', 'networkInterface', 'listenPort', 'listenHost', 'settingsUnlock',
    'answerHeartbeat', 'socketWatchdog', 'mobileCompat', 'mobileScrollFix', 'pwaInstall',
  ]) {
    const value = result[key]
    if (isVolatileLike(value)) result[key] = (value as { get(): unknown }).get()
  }
  if (typeof source.auth === 'object' && source.auth !== null) {
    const auth = { ...(source.auth as Record<string, unknown>) }
    for (const key of [
      'enabled', 'mode', 'adminPolicy', 'adminProtection', 'allowLoopback', 'requirePairing', 'requireApproval',
    ]) {
      const value = auth[key]
      if (isVolatileLike(value)) auth[key] = (value as { get(): unknown }).get()
    }
    result.auth = auth
  }
  return result
}

/**
 * Apply defaults, then enforce every constraint Schemastery cannot express.
 *
 * @param input - the raw Loader config (or `undefined` for a bare `insert` row).
 * @param profileDir - the active profile directory; supplies the derived `dataDir`.
 * @returns the normalized, fully defaulted config.
 * @throws LanGuardConfigError when a value would make the listener unsafe.
 */
export function parseConfig(input: unknown, profileDir?: string | undefined): LanGuardConfigShape {
  let resolved: Record<string, unknown>
  try {
    // Schemastery applies the documented defaults and rejects wrong types; the
    // cast only carries the shape, the schema is the actual validator.
    resolved = Config(unwrapVolatileInput(input ?? {}) as LanGuardConfigShape) as unknown as Record<string, unknown>
  } catch (error) {
    throw new LanGuardConfigError(`dsh-lan-guard: invalid config: ${(error as Error).message}`)
  }

  const rawAuth = (resolved.auth ?? {}) as Record<string, unknown>
  const rawTls = (resolved.tls ?? {}) as Record<string, unknown>
  const rawMdns = (resolved.mdns ?? {}) as Record<string, unknown>
  // The schema has already rejected a non-string `dataDir`, so this raw read
  // only has to tolerate absence. It runs on `input` (not `resolved`) because
  // the derived default is a resolution POLICY, not a schema default.
  const dataDir = resolveDataDir(input, profileDir)

  const config: LanGuardConfigShape = {
    // The writable switches are volatile references at runtime; unwrap them for
    // the plain resolved view. `liveSwitches()` keeps the references for liveness.
    enabled: readField(resolved.enabled, true),
    listenHost: readField(resolved.listenHost, DEFAULT_LISTEN_HOST),
    listenPort: readField(resolved.listenPort, DEFAULT_LISTEN_PORT),
    upstreamOrigin: readField(resolved.upstreamOrigin, DEFAULT_UPSTREAM_ORIGIN),
    networkInterface: emptyToNull(readField(resolved.networkInterface, '')),
    dataDir: dataDir?.dir ?? null,
    settingsUnlock: readField(resolved.settingsUnlock, true),
    answerHeartbeat: readField(resolved.answerHeartbeat, true),
    socketWatchdog: readField(resolved.socketWatchdog, true),
    mobileCompat: readField(resolved.mobileCompat, true),
    mobileScrollFix: readField(resolved.mobileScrollFix, true),
    pwaInstall: readField(resolved.pwaInstall, true),
    auth: {
      enabled: readField(rawAuth.enabled, true),
      mode: readField(rawAuth.mode, 'token_and_password'),
      adminPolicy: readField(rawAuth.adminPolicy, 'local_only'),
      adminProtection: readField(rawAuth.adminProtection, true),
      allowLoopback: readField(rawAuth.allowLoopback, true),
      requirePairing: readField(rawAuth.requirePairing, true),
      requireApproval: readField(rawAuth.requireApproval, false),
      sessionMaxAgeMs: readField(rawAuth.sessionMaxAgeMs, 2_592_000_000),
      adminSessionMaxAgeMs: readField(rawAuth.adminSessionMaxAgeMs, 1_800_000),
      maxFailedAttempts: readField(rawAuth.maxFailedAttempts, 5),
      lockoutMs: readField(rawAuth.lockoutMs, 60_000),
    },
    tls: {
      mode: readField(rawTls.mode, 'self-signed'),
      caCertFile: emptyToNull(readField(rawTls.caCertFile, '')),
      caKeyFile: emptyToNull(readField(rawTls.caKeyFile, '')),
      certFile: emptyToNull(readField(rawTls.certFile, '')),
      keyFile: emptyToNull(readField(rawTls.keyFile, '')),
      allowInsecureLan: readField(rawTls.allowInsecureLan, false),
    },
    mdns: { enabled: readField(rawMdns.enabled, false) },
  }

  const dataDirPath = config.dataDir
  if (dataDirPath === null || dataDirPath.trim() === '') {
    throw new LanGuardConfigError(
      'dsh-lan-guard: no dataDir could be resolved: this entry configures none and the host exposes no '
      + "profile directory. Set it in this entry's config (cordis.patch.yml), "
      + 'e.g. dataDir: ~/.dsh/profiles/web/data/dsh-lan-guard',
    )
  }

  if (!isIpv4Literal(config.listenHost)) {
    throw new LanGuardConfigError(
      `dsh-lan-guard: listenHost ${JSON.stringify(config.listenHost)} must be an IPv4 literal `
      + "(e.g. '127.0.0.1', '0.0.0.0', or one NIC address)",
    )
  }

  if (!isLoopbackOrigin(config.upstreamOrigin)) {
    throw new LanGuardConfigError(
      `dsh-lan-guard: upstreamOrigin ${JSON.stringify(config.upstreamOrigin)} must be a loopback http(s) origin `
      + '(the gate cookie is injected into upstream requests, so a non-loopback upstream would leak it)',
    )
  }

  if (new URL(config.upstreamOrigin).protocol !== 'http:') {
    // DSH's own web server carries no TLS, and the
    // proxy forwards plain HTTP upstream only.
    throw new LanGuardConfigError(
      `dsh-lan-guard: upstreamOrigin ${JSON.stringify(config.upstreamOrigin)} must use http:// — `
      + "DSH's loopback web server does not serve TLS",
    )
  }

  if (!config.auth.enabled && !isLoopbackHost(config.listenHost)) {
    throw new LanGuardConfigError(
      `dsh-lan-guard: auth.enabled is false while listenHost is ${JSON.stringify(config.listenHost)}; `
      + 'the gate may only be disabled on a loopback listener',
    )
  }

  if (!isLoopbackHost(config.listenHost) && config.tls.mode === 'off' && !config.tls.allowInsecureLan) {
    // SPEC §6.2: plain HTTP on the LAN needs an explicit acknowledgement, not a
    // silent default — the gate password and the upstream cookie are readable
    // by anyone on the same network.
    throw new LanGuardConfigError(
      `dsh-lan-guard: listenHost ${JSON.stringify(config.listenHost)} with tls.mode "off" would serve the `
      + 'gate password and the upstream session over plain HTTP on the network. Enable TLS (the default '
      + 'self-signed mode), bind 127.0.0.1, or set tls.allowInsecureLan: true to accept that risk explicitly.',
    )
  }

  if (config.auth.sessionMaxAgeMs <= 0) {
    throw new LanGuardConfigError('dsh-lan-guard: auth.sessionMaxAgeMs must be greater than zero')
  }
  if (config.auth.adminSessionMaxAgeMs <= 0) {
    throw new LanGuardConfigError('dsh-lan-guard: auth.adminSessionMaxAgeMs must be greater than zero')
  }
  if (config.auth.maxFailedAttempts < 1) {
    throw new LanGuardConfigError('dsh-lan-guard: auth.maxFailedAttempts must be at least 1')
  }
  if (config.auth.lockoutMs < 0) {
    throw new LanGuardConfigError('dsh-lan-guard: auth.lockoutMs must not be negative')
  }

  if (config.tls.mode === 'provided') {
    requireNonEmptyString(config.tls.certFile, 'tls.certFile')
    requireNonEmptyString(config.tls.keyFile, 'tls.keyFile')
  }

  return config
}
