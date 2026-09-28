/**
 * dsh-lan-guard — plugin entry.
 *
 * Phase state:
 *
 * - P1 (done): config validation, the loopback reverse proxy, HTTP/WS relay
 *   and the upstream cookie exchange.
 * - P2 (this phase): the visitor gate in front of BOTH relay paths, and the
 *   management surface inside DSH's official settings page.
 * - P3 (next): the LAN listener, self-signed TLS and the QR code.
 *
 * The plugin never changes DSH's own binding or any DSH-side configuration; it
 * opens a second listener of its own.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AuthManager } from './auth/manager.ts'
import { VisitorGate } from './auth/gate.ts'
import {
  Config,
  LISTEN_PORT_PROBE_ATTEMPTS,
  isLoopbackHost,
  liveSwitches,
  parseConfig,
  resolveDataDir,
  type LanGuardConfigShape,
  type LiveSwitches,
} from './config.ts'
import type { LanGuardLogger } from './log.ts'
import { noopLogger } from './log.ts'
import { mdnsAdvertisement, startMdns } from './mdns.ts'
import { UpdateChecker } from './update-check.ts'
import { listNetworkAddresses, selectAddress } from './network.ts'
import { startProxy, type ProxyStats, type RunningProxy } from './proxy.ts'
import { buildAccessInfo, type AccessInfo } from './qrcode.ts'
import {
  registerManagementRoutes,
  type SettingsWriterLike,
  type WebServerLike,
} from './settings/routes.ts'
import { DeviceRegistry } from './store/devices.ts'
import { SecretsStore } from './store/secrets.ts'
import { ensureCa, fingerprintOf } from './tls/ca.ts'
import { ensureLeaf } from './tls/leaf.ts'
import { UpstreamAuth } from './upstream-auth.ts'

export { Config } from './config.ts'
export type { LanGuardConfigShape } from './config.ts'

/** Stable Cordis plugin name; also the Loader entry id and the settings namespace. */
export const name = 'dsh-lan-guard'

/** `connection` supplies the launch-token seam and the native fence; `webServer` hosts the management routes. */
export const inject = ['webServer', 'connection']

/** What the management-route registration needs from the plugin. */
export interface ManagementDeps {
  auth: AuthManager
  switches: LiveSwitches
  config: LanGuardConfigShape
  logger: LanGuardLogger
  /** Build the current access URL set and QR codes. */
  access: (secretToken?: string | null) => Promise<AccessInfo>
  /** The live listener facts (actual port + whether a fallback happened). */
  listener: { port: () => number; portFallback: () => boolean }
  /** Paired devices (P4-g). */
  devices: DeviceRegistry
  /** Update detection (F8). */
  updates: UpdateChecker
  /** Live WebSocket relay counters, for the health panel (P5). */
  relay?: { stats(): ProxyStats } | undefined
}

/** The host capabilities this plugin needs, narrowed so it is testable without a real Context. */
export interface LanGuardHost {
  /** `ctx.connection.authenticatedUrl` — the public token seam (route A). */
  authenticatedUrl: (baseUrl: string) => string
  /** DSH's own web server port, used to refuse a self-conflicting listener. */
  webServerPort?: number | undefined
  /**
   * The active profile directory, when the host can name it (`profileContext`).
   * Supplying it makes `dataDir` optional: the plugin derives
   * `<profileDir>/data/dsh-lan-guard` instead of demanding hand-written config.
   */
  profileDir?: string | undefined
  /** Logger; credentials are never passed to it. */
  logger?: LanGuardLogger
  /** Register the management surface; omitted when no DSH seams are available (unit tests). */
  registerManagement?: ((deps: ManagementDeps) => () => void) | undefined
}

/** A running plugin instance. */
export interface LanGuardRuntime {
  /** The visitor-facing proxy listener. */
  readonly proxy: RunningProxy
  /** The gate, exposed for tests and diagnostics. */
  readonly auth: AuthManager
  /** Paired devices (P4-g), exposed for tests and diagnostics. */
  readonly devices: DeviceRegistry
  /** Update detection (SPEC F8). */
  readonly updates: UpdateChecker
  /** Stop the listener, the gate and the management routes. */
  close(): Promise<void>
}

/**
 * Validate config and bring the plugin up.
 *
 * @param host - the host capabilities above.
 * @param rawConfig - the Loader config for this entry.
 * @returns the running runtime, or `undefined` when the plugin is switched off.
 */
/** Read the plugin's own version (used by the update check). */
async function readPackageVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    // A missing package.json only means the version chip cannot compare.
    return '0.0.0'
  }
}

export async function startLanGuard(host: LanGuardHost, rawConfig: unknown): Promise<LanGuardRuntime | undefined> {
  const logger = host.logger ?? noopLogger
  // Resolved here only for the log line; `parseConfig` applies the same precedence.
  const dataDir = resolveDataDir(rawConfig, host.profileDir)
  const config = parseConfig(rawConfig, host.profileDir)
  const switches = liveSwitches(rawConfig, config)

  if (!switches.enabled()) {
    logger.info('plugin disabled; no listener opened')
    return undefined
  }

  if (!isLoopbackHost(config.listenHost) && config.tls.mode === 'off') {
    // Reaching this line means the operator acknowledged the risk explicitly
    // (enforced in parseConfig); say so loudly, because the gate password is
    // now travelling unencrypted.
    logger.warn(
      'plain HTTP on a non-loopback listener was explicitly acknowledged; the gate password is not encrypted',
    )
  }

  if (
    host.webServerPort !== undefined
    && config.listenPort !== 0
    && config.listenPort === host.webServerPort
  ) {
    throw new Error(
      `dsh-lan-guard: listenPort ${config.listenPort} is DSH's own web server port; `
      + 'choose a different port (default 3445)',
    )
  }

  const store = new SecretsStore(config.dataDir ?? '', logger)
  // Say where credentials land and why: an install with no config at all now
  // works, so the operator must be able to find the directory without guessing.
  logger.info('private state dir=%s source=%s', config.dataDir ?? '', dataDir?.source ?? 'config')
  const auth = new AuthManager({ store, auth: config.auth, switches, logger })
  await auth.init()

  if (!auth.hasPassword) {
    // Honest, loud, and safe: with no password the gate refuses every visitor
    // rather than pretending to be a gate.
    logger.warn('no access password configured; the gate will refuse every device until one is set')
  }

  const devices = new DeviceRegistry({ store, logger })
  await devices.init()
  // Update detection (SPEC F8): read-only, cached, never installs anything.
  const updates = new UpdateChecker({ currentVersion: await readPackageVersion(), logger })
  const gate = new VisitorGate({
    auth,
    devices,
    requirePairing: () => switches.requirePairing(),
    requireApproval: () => switches.requireApproval(),
    logger,
  })
  const upstreamAuth = new UpstreamAuth({
    origin: config.upstreamOrigin,
    authenticatedUrl: host.authenticatedUrl,
    logger,
  })

  const tls = await materializeTls(config, logger)

  const proxy = await startProxy({
    listenHost: config.listenHost,
    listenPort: config.listenPort,
    portProbeAttempts: LISTEN_PORT_PROBE_ATTEMPTS,
    upstreamOrigin: config.upstreamOrigin,
    auth: upstreamAuth,
    gate,
    // Read per upgrade, not captured at start: the switch is live.
    answerHeartbeat: () => switches.answerHeartbeat(),
    ...(tls === undefined ? {} : { tls: { cert: tls.cert, key: tls.key } }),
    logger,
  })

  const mdns = config.mdns.enabled
    ? startMdns({
      advertisement: mdnsAdvertisement({
        port: proxy.port,
        secure: config.tls.mode !== 'off',
        address: selectAddress(listNetworkAddresses(), config.networkInterface)?.address ?? null,
      }),
      logger,
    })
    : undefined

  const access = (secretToken?: string | null): Promise<AccessInfo> => buildAccessInfo({
    port: proxy.port,
    portFallbackFrom: proxy.portFallback ? proxy.requestedPort : null,
    listenHost: config.listenHost,
    tlsMode: config.tls.mode,
    networkInterface: switches.networkInterface(),
    caFingerprint: tls?.caFingerprint ?? null,
    secretToken: secretToken ?? null,
  })

  const disposeManagement = host.registerManagement?.({
    auth,
    switches,
    config,
    logger,
    access,
    listener: { port: () => proxy.port, portFallback: () => proxy.portFallback },
    devices,
    updates,
    relay: { stats: () => proxy.stats() },
  })

  if (proxy.portFallback) {
    logger.warn('configured port %d was taken; listening on %d instead', proxy.requestedPort, proxy.port)
  }
  logger.info(
    'listening host=%s port=%d upstream=%s tls=%s gate=%s mode=%s',
    proxy.host,
    proxy.port,
    config.upstreamOrigin,
    config.tls.mode,
    switches.enabled() ? 'on' : 'off',
    switches.mode(),
  )

  return {
    proxy,
    auth,
    devices,
    updates,
    async close(): Promise<void> {
      mdns?.stop()
      disposeManagement?.()
      auth.dispose()
      await proxy.close()
    },
  }
}

/** The TLS material in use, plus the CA fingerprint the settings page shows. */
interface TlsMaterial {
  cert: string
  key: string
  caFingerprint: string | null
}

/**
 * Produce the listener's TLS material.
 *
 * `self-signed` keeps a long-lived CA and re-signs a leaf for the CURRENT
 * addresses, so a DHCP change never invalidates a phone's trust.
 */
async function materializeTls(config: LanGuardConfigShape, logger: LanGuardLogger): Promise<TlsMaterial | undefined> {
  if (config.tls.mode === 'off') {
    logger.warn('TLS is disabled; the gate password travels in clear text on this listener')
    return undefined
  }
  if (config.tls.mode === 'provided') {
    const certFile = config.tls.certFile
    const keyFile = config.tls.keyFile
    if (certFile === null || keyFile === null) {
      throw new Error('dsh-lan-guard: tls.mode "provided" requires certFile and keyFile')
    }
    const [cert, key] = await Promise.all([readFile(certFile, 'utf8'), readFile(keyFile, 'utf8')])
    const caCertFile = config.tls.caCertFile
    return {
      cert,
      key,
      caFingerprint: caCertFile === null ? null : fingerprintOf(await readFile(caCertFile, 'utf8')),
    }
  }
  const directory = join(config.dataDir ?? '', 'tls')
  const ca = await ensureCa(join(directory, 'ca.pem'), join(directory, 'ca-key.pem'))
  const leaf = await ensureLeaf({
    ca,
    addresses: listNetworkAddresses().map(entry => entry.address),
    certPath: join(directory, 'leaf.pem'),
    keyPath: join(directory, 'leaf-key.pem'),
  })
  logger.info('self-signed TLS ready caFingerprint=%s addresses=%d', ca.fingerprint, leaf.addresses.length)
  return { cert: leaf.cert, key: leaf.key, caFingerprint: ca.fingerprint }
}

/**
 * Look a host service up without requiring it.
 *
 * `ctx.<service>` would throw for a service this plugin does not declare in
 * `inject`, and declaring one would stop the plugin from loading in hosts that
 * ship none. `ctx.get(name)` is the optional lookup, so a missing service
 * degrades one feature instead of taking the whole plugin down.
 *
 * @param ctx - the plugin context.
 * @param name - the host service name.
 * @returns the service, or `undefined` when it is absent.
 */
function optionalService<T>(ctx: Context, name: string): T | undefined {
  const lookup = (ctx as unknown as { get?: (name: string) => unknown }).get
  if (typeof lookup !== 'function') return undefined
  try {
    const service = lookup.call(ctx, name)
    return service === undefined || service === null ? undefined : service as T
  } catch {
    return undefined
  }
}

/**
 * The host `settings` service, when this profile ships one.
 *
 * Without it the management endpoint degrades to read-only instead of taking
 * the plugin down, and it never pretends a write succeeded.
 *
 * @param ctx - the plugin context.
 * @returns the settings writer, or `undefined`.
 */
function optionalSettings(ctx: Context): SettingsWriterLike | undefined {
  return optionalService<SettingsWriterLike>(ctx, 'settings')
}

/**
 * The active profile directory, read from DSH's own `profileContext` service.
 *
 * This is the FACT the plugin derives its default `dataDir` from — never its
 * own module location, which a linked package moves.
 *
 * @param ctx - the plugin context.
 * @returns the directory, or `undefined` when the host cannot name one.
 */
function activeProfileDir(ctx: Context): string | undefined {
  const profile = optionalService<{ dir?: unknown }>(ctx, 'profileContext')
  const dir = profile?.dir
  return typeof dir === 'string' && dir.trim() !== '' ? dir : undefined
}

/**
 * Cordis entry point.
 *
 * @param ctx - the plugin's context (injects `webServer` and `connection`).
 * @param rawConfig - the Loader config for this entry.
 */
export async function apply(ctx: Context, rawConfig: unknown): Promise<void> {
  const logger = ctx.logger(name) as unknown as LanGuardLogger
  const runtime = await startLanGuard({
    authenticatedUrl: (baseUrl: string) => ctx.connection.authenticatedUrl(baseUrl),
    webServerPort: ctx.webServer.port,
    profileDir: activeProfileDir(ctx),
    logger,
    registerManagement: deps => registerManagementRoutes({
      connection: { requestRejection: request => ctx.connection.requestRejection(request) },
      webServer: ctx.webServer as unknown as WebServerLike,
      settings: optionalSettings(ctx),
      auth: deps.auth,
      switches: deps.switches,
      config: deps.config,
      access: deps.access,
      listener: deps.listener,
      devices: deps.devices,
      updates: deps.updates,
      // Without this passthrough the health panel's relay counters silently
      // disappear: the snapshot field is optional, so nothing fails loudly.
      ...(deps.relay === undefined ? {} : { relay: deps.relay }),
      logger: deps.logger,
    }),
  }, rawConfig)
  if (runtime === undefined) return
  ctx.effect(() => () => runtime.close(), 'dsh-lan-guard listener, gate and management routes')
}
