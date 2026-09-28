/**
 * Management surface tests.
 *
 * The routes run on a real HTTP server with real `IncomingMessage` /
 * `ServerResponse` objects, so the native-fence handoff, the CSRF rule and the
 * redaction are exercised as they are in production.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthManager } from '../src/auth/manager.ts'
import { staticSwitches, type LanGuardConfigShape } from '../src/config.ts'
import { noopLogger } from '../src/log.ts'
import { registerManagementRoutes, type SettingsWriterLike } from '../src/settings/routes.ts'
import type { ProxyStats } from '../src/proxy.ts'
import { DeviceRegistry } from '../src/store/devices.ts'
import { SecretsStore } from '../src/store/secrets.ts'
import { requestTo, type RawResponse, type RawRequestOptions } from './helpers/http-client.ts'
import { tmpDataDir } from './helpers/tmp.ts'

const PASSWORD = 'correct horse battery staple'
const ADMIN = 'admin password 42'

let closer: (() => Promise<void>) | undefined

afterEach(async () => {
  await closer?.()
  closer = undefined
})

/** Resolved config for the routes. */
function configWith(overrides: Partial<LanGuardConfigShape['auth']> = {}): LanGuardConfigShape {
  return {
    enabled: true,
    listenHost: '127.0.0.1',
    listenPort: 3445,
    upstreamOrigin: 'http://127.0.0.1:3080',
    networkInterface: null,
    dataDir: null,
    settingsUnlock: true,
    answerHeartbeat: true,
    socketWatchdog: true,
    mobileCompat: true,
    mobileScrollFix: true,
    auth: {
      enabled: true,
      mode: 'token_and_password',
      adminPolicy: 'local_only',
      adminProtection: true,
      allowLoopback: true,
      sessionMaxAgeMs: 2_592_000_000,
      adminSessionMaxAgeMs: 1_800_000,
      maxFailedAttempts: 5,
      lockoutMs: 60_000,
      requirePairing: false,
      requireApproval: false,
      ...overrides,
    },
    tls: { mode: 'off', caCertFile: null, caKeyFile: null, certFile: null, keyFile: null, allowInsecureLan: false },
    mdns: { enabled: false },
  }
}

interface Harness {
  port: number
  auth: AuthManager
  devices: DeviceRegistry
  /** Every `settings.update` call the endpoint made. */
  updates: { ns: string; patch: Record<string, unknown> }[]
  /** Set to make the native fence refuse. */
  fence: { rejection: number | undefined }
}

/** Start the management routes on a real loopback server. */
async function harness(options: {
  auth?: Partial<LanGuardConfigShape['auth']>
  withSettings?: boolean
  password?: string | null
  adminPassword?: string | null
  /** Supply live relay counters, as the plugin does when a proxy is running. */
  relay?: { stats(): ProxyStats }
} = {}): Promise<Harness> {
  const config = configWith(options.auth)
  const store = new SecretsStore(await tmpDataDir())
  const devices = new DeviceRegistry({ store, logger: noopLogger })
  await devices.init()
  const auth = new AuthManager({
    store,
    auth: config.auth,
    switches: staticSwitches(config),
    logger: noopLogger,
  })
  await auth.init()
  const password = options.password === undefined ? PASSWORD : options.password
  if (password !== null) await auth.setPassword(password)
  const adminPassword = options.adminPassword === undefined ? ADMIN : options.adminPassword
  if (adminPassword !== null) await auth.setAdminPassword(adminPassword)

  const updates: Harness['updates'] = []
  const fence = { rejection: undefined as number | undefined }
  const settings: SettingsWriterLike | undefined = options.withSettings === false ? undefined : {
    describe: () => [{ ns: 'dsh-lan-guard', revision: 7 }],
    update: async (ns, patch) => {
      updates.push({ ns, patch })
    },
  }

  const handlers = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  registerManagementRoutes({
    connection: { requestRejection: () => fence.rejection },
    webServer: {
      register: (route) => {
        handlers.set(route.path, route.handler)
        return () => handlers.delete(route.path)
      },
    },
    auth,
    switches: staticSwitches(config),
    config,
    settings,
    listener: { port: () => config.listenPort, portFallback: () => false },
    updates: {
      check: async () => ({
        current: '0.1.1', latest: '0.2.0', hasUpdate: true, checkedAtMs: 1, error: null,
      }),
    },
    devices,
    ...(options.relay === undefined ? {} : { relay: options.relay }),
    access: async (secretToken) => ({
      port: config.listenPort,
      portFallbackFrom: null,
      secure: config.tls.mode !== 'off',
      tlsMode: config.tls.mode,
      caFingerprint: null,
      loopbackOnly: true,
      addresses: [],
      selectedUrl: `http://127.0.0.1:${String(config.listenPort)}/`,
      qrSvg: null,
      ...(secretToken === null || secretToken === undefined
        ? {}
        : { tokenUrl: `http://127.0.0.1:${String(config.listenPort)}/?auth=${secretToken}`, tokenQrSvg: '<svg></svg>' }),
      unavailableReason: 'loopback only (test)',
    }),
    logger: noopLogger,
  })

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x.invalid').pathname
    const handler = handlers.get(path)
    if (handler === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void handler(req, res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  closer = async () => {
    auth.dispose()
    await new Promise<void>(resolve => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    })
  }
  return { port: address.port, auth, devices, updates, fence }
}

/** Headers that make a request look like it arrived through the LAN gateway. */
const REMOTE = { 'x-dsh-lan-guard-visitor': '1' }

/** POST JSON to the management endpoint. */
async function post(port: number, body: unknown, options: RawRequestOptions = {}): Promise<RawResponse> {
  return await requestTo(port, {
    method: 'POST',
    path: '/plugins/dsh-lan-guard/config',
    headers: { 'content-type': 'application/json', host: `127.0.0.1:${String(port)}`, ...options.headers },
    body: JSON.stringify(body),
  })
}

/** Extract one cookie pair. */
function cookiePair(response: RawResponse, name: string): string {
  const raw = response.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
  for (const entry of list) {
    if (entry.startsWith(`${name}=`)) return entry.split(';')[0] ?? ''
  }
  throw new Error(`cookie ${name} not found`)
}

describe('native fence', () => {
  it('refuses when DSH rejects the request', async () => {
    const harnessed = await harness()
    harnessed.fence.rejection = 403
    const response = await requestTo(harnessed.port, { path: '/plugins/dsh-lan-guard/config' })
    expect(response.status).toBe(403)
    expect(JSON.parse(response.body.toString())).toEqual({ ok: false, error: 'forbidden' })
  })

  it('maps a 401 rejection to unauthorized', async () => {
    const harnessed = await harness()
    harnessed.fence.rejection = 401
    const response = await requestTo(harnessed.port, { path: '/plugins/dsh-lan-guard/auth-status' })
    expect(response.status).toBe(401)
  })

  it('never runs a write when the fence refuses', async () => {
    const harnessed = await harness()
    harnessed.fence.rejection = 403
    await post(harnessed.port, { preferences: { mode: 'password' } })
    expect(harnessed.updates).toEqual([])
  })
})

describe('snapshot', () => {
  it('returns the switches and the redacted status', async () => {
    const harnessed = await harness()
    const response = await requestTo(harnessed.port, { path: '/plugins/dsh-lan-guard/config' })
    expect(response.status).toBe(200)
    const body = JSON.parse(response.body.toString())
    expect(body.ok).toBe(true)
    expect(body.preferences).toEqual({
      enabled: true,
      listenPort: 3445,
      listenHost: '127.0.0.1',
      networkInterface: '',
      settingsUnlock: true,
      answerHeartbeat: true,
      socketWatchdog: true,
      mobileCompat: true,
      mobileScrollFix: true,
      mode: 'token_and_password',
      adminPolicy: 'local_only',
      adminProtection: true,
      allowLoopback: true,
      requirePairing: false,
      requireApproval: false,
    })
    expect(body.authStatus.hasPassword).toBe(true)
    expect(body.authStatus.hasAdminPassword).toBe(true)
    expect(body.listener.listenPort).toBe(3445)
  })

  it('never leaks the token, a hash or a salt while locked', async () => {
    const harnessed = await harness({ auth: { adminPolicy: 'password_unlock' } })
    await harnessed.auth.ensureSecretToken()
    const response = await requestTo(harnessed.port, {
      path: '/plugins/dsh-lan-guard/config',
      headers: REMOTE,
    })
    const raw = response.body.toString()
    expect(raw).not.toContain('pbkdf2')
    expect(raw).not.toContain('dsh_')
    expect(raw).not.toContain('secretToken')
    expect(JSON.parse(raw).authStatus.hasSecretToken).toBe(true)
  })

  it('keeps auth-status free of every credential', async () => {
    const harnessed = await harness()
    const response = await requestTo(harnessed.port, { path: '/plugins/dsh-lan-guard/auth-status' })
    const raw = response.body.toString()
    expect(response.status).toBe(200)
    expect(raw).not.toContain('pbkdf2')
    expect(raw).not.toContain('dsh_')
    expect(JSON.parse(raw).hasPassword).toBe(true)
  })
})

describe('admin unlock', () => {
  it('unlocks without any visitor session and then exposes the token', async () => {
    const harnessed = await harness()
    await harnessed.auth.ensureSecretToken()
    const unlocked = await post(harnessed.port, { adminUnlock: ADMIN })
    expect(unlocked.status).toBe(200)
    const adminCookie = cookiePair(unlocked, 'dsh_lan_guard_admin')

    const snapshot = await requestTo(harnessed.port, {
      path: '/plugins/dsh-lan-guard/config',
      headers: { cookie: adminCookie },
    })
    const body = JSON.parse(snapshot.body.toString())
    expect(body.authStatus.adminUnlocked).toBe(true)
    expect(body.secretToken).toMatch(/^dsh_[0-9a-f]{36}$/)
  })

  it('rejects a wrong admin password', async () => {
    const harnessed = await harness()
    const response = await post(harnessed.port, { adminUnlock: 'nope' })
    expect(response.status).toBe(401)
    expect(JSON.parse(response.body.toString()).error).toBe('admin_password_invalid')
  })

  it('locks again on request', async () => {
    const harnessed = await harness()
    const unlocked = await post(harnessed.port, { adminUnlock: ADMIN })
    const adminCookie = cookiePair(unlocked, 'dsh_lan_guard_admin')
    const locked = await post(harnessed.port, { adminLock: true }, { headers: { cookie: adminCookie } })
    expect(locked.status).toBe(200)
    expect(locked.headers['set-cookie']).toBeDefined()
  })
})

describe('preference writes', () => {
  it('drops unknown keys instead of writing them', async () => {
    const harnessed = await harness()
    const unlocked = await post(harnessed.port, { adminUnlock: ADMIN })
    const adminCookie = cookiePair(unlocked, 'dsh_lan_guard_admin')

    const response = await post(harnessed.port, {
      preferences: { mode: 'password', evil: true, __proto__: { polluted: true } },
    }, { headers: { cookie: adminCookie } })
    expect(response.status).toBe(200)
    expect(harnessed.updates).toEqual([{ ns: 'dsh-lan-guard', patch: { auth: { mode: 'password' } } }])
  })

  it('rejects an invalid value', async () => {
    const harnessed = await harness()
    const unlocked = await post(harnessed.port, { adminUnlock: ADMIN })
    const adminCookie = cookiePair(unlocked, 'dsh_lan_guard_admin')
    const response = await post(harnessed.port, { preferences: { mode: 'magic' } }, {
      headers: { cookie: adminCookie },
    })
    expect(response.status).toBe(400)
    expect(harnessed.updates).toEqual([])
  })

  it('never locks a DIRECT loopback operator (physical unlock privilege)', async () => {
    // The console used to lock on the machine's own desktop, which made the
    // plugin feel broken there (user feedback 2026-09-24).
    const harnessed = await harness()
    const snapshot = await requestTo(harnessed.port, { path: '/plugins/dsh-lan-guard/config' })
    const status = JSON.parse(snapshot.body.toString()).authStatus
    expect(status.localAccess).toBe(true)
    expect(status.adminRequired).toBe(false)

    const response = await post(harnessed.port, { preferences: { mode: 'password' } })
    expect(response.status).toBe(200)
    expect(harnessed.updates).toEqual([{ ns: 'dsh-lan-guard', patch: { auth: { mode: 'password' } } }])
  })

  it('makes REMOTE access read-only under local_only', async () => {
    const harnessed = await harness()
    const snapshot = await requestTo(harnessed.port, {
      path: '/plugins/dsh-lan-guard/config',
      headers: REMOTE,
    })
    const status = JSON.parse(snapshot.body.toString()).authStatus
    expect(status.localAccess).toBe(false)
    expect(status.remoteReadOnly).toBe(true)

    const response = await post(harnessed.port, { preferences: { mode: 'password' } }, { headers: REMOTE })
    expect(response.status).toBe(403)
    expect(JSON.parse(response.body.toString()).error).toBe('read_only_remote')
    expect(harnessed.updates).toEqual([])
  })

  it('requires an unlock for REMOTE writes under password_unlock', async () => {
    const harnessed = await harness({ auth: { adminPolicy: 'password_unlock' } })
    const refused = await post(harnessed.port, { preferences: { mode: 'password' } }, { headers: REMOTE })
    expect(refused.status).toBe(403)
    expect(JSON.parse(refused.body.toString()).error).toBe('admin_required')

    const unlocked = await post(harnessed.port, { adminUnlock: ADMIN }, { headers: REMOTE })
    expect(unlocked.status).toBe(200)
    const adminCookie = cookiePair(unlocked, 'dsh_lan_guard_admin')
    const allowed = await post(harnessed.port, { preferences: { mode: 'password' } }, {
      headers: { ...REMOTE, cookie: adminCookie },
    })
    expect(allowed.status).toBe(200)
  })

  it('reports a missing settings service instead of pretending to save', async () => {
    const harnessed = await harness({ withSettings: false })
    const unlocked = await post(harnessed.port, { adminUnlock: ADMIN })
    const adminCookie = cookiePair(unlocked, 'dsh_lan_guard_admin')
    const response = await post(harnessed.port, { preferences: { mode: 'password' } }, {
      headers: { cookie: adminCookie },
    })
    expect(response.status).toBe(400)
    expect(response.body.toString()).toContain('settings service is unavailable')
  })

  it('refuses a cross-site write', async () => {
    const harnessed = await harness()
    const response = await post(harnessed.port, { preferences: { mode: 'password' } }, {
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(response.status).toBe(403)
    expect(JSON.parse(response.body.toString()).error).toBe('csrf')
  })

  it('refuses a write from another origin', async () => {
    const harnessed = await harness()
    const response = await post(harnessed.port, { preferences: { mode: 'password' } }, {
      headers: { origin: 'http://evil.example' },
    })
    expect(response.status).toBe(403)
  })
})

describe('credentials', () => {
  it('changes the access password when the current one is supplied', async () => {
    const harnessed = await harness()
    const response = await post(harnessed.port, { setPassword: { current: PASSWORD, next: 'a brand new secret' } })
    expect(response.status).toBe(200)
    expect(await harnessed.auth.verifyAccessPassword('a brand new secret')).toBe(true)
    expect(await harnessed.auth.verifyAccessPassword(PASSWORD)).toBe(false)
  })

  it('refuses a password change without the current password or an unlock', async () => {
    // Long enough to pass the length policy, so this exercises AUTHORIZATION.
    const harnessed = await harness({ auth: { adminPolicy: 'password_unlock' } })
    const response = await post(harnessed.port, { setPassword: { next: 'sneaky but long' } }, { headers: REMOTE })
    expect(response.status).toBe(403)
    expect(await harnessed.auth.verifyAccessPassword('sneaky but long')).toBe(false)
  })

  it('refuses an empty new password', async () => {
    const harnessed = await harness()
    const response = await post(harnessed.port, { setPassword: { current: PASSWORD, next: '' } })
    expect(response.status).toBe(400)
  })

  it('rotates the token only when unlocked (remote)', async () => {
    const harnessed = await harness({ auth: { adminPolicy: 'password_unlock' } })
    const before = await harnessed.auth.ensureSecretToken()
    const refused = await post(harnessed.port, { rotateToken: true }, { headers: REMOTE })
    expect(refused.status).toBe(403)

    const unlocked = await post(harnessed.port, { adminUnlock: ADMIN }, { headers: REMOTE })
    const adminCookie = cookiePair(unlocked, 'dsh_lan_guard_admin')
    const rotated = await post(harnessed.port, { rotateToken: true }, {
      headers: { ...REMOTE, cookie: adminCookie },
    })
    expect(rotated.status).toBe(200)
    expect(harnessed.auth.secretToken()).not.toBe(before)
  })
})

describe('first-time setup', () => {
  it('lets the operator set the FIRST access password through the fence', async () => {
    const harnessed = await harness({ password: null, adminPassword: null })
    expect(harnessed.auth.hasPassword).toBe(false)
    const response = await post(harnessed.port, { setPassword: { next: 'first secret' } })
    expect(response.status).toBe(200)
    expect(await harnessed.auth.verifyAccessPassword('first secret')).toBe(true)
  })

  it('lets the operator set the FIRST admin password, then still requires the current one', async () => {
    const harnessed = await harness({ password: null, adminPassword: null, auth: { adminPolicy: 'password_unlock' } })
    const first = await post(harnessed.port, { setAdminPassword: { next: ADMIN } })
    expect(first.status).toBe(200)

    // From a REMOTE, locked console the current password is required.
    const second = await post(harnessed.port, { setAdminPassword: { next: 'another admin' } }, { headers: REMOTE })
    expect(second.status).toBe(403)
    const withCurrent = await post(harnessed.port, {
      setAdminPassword: { current: ADMIN, next: 'another admin' },
    }, { headers: REMOTE })
    expect(withCurrent.status).toBe(200)
    expect(await harnessed.auth.verifyAdminPassword('another admin')).toBe(true)
  })
})

describe('passwordless link lifecycle', () => {
  it('creates the token lazily for a managing caller and never for a locked one', async () => {
    const harnessed = await harness({ auth: { adminPolicy: 'password_unlock' } })
    expect(harnessed.auth.hasSecretToken).toBe(false)

    const locked = await requestTo(harnessed.port, {
      path: '/plugins/dsh-lan-guard/config',
      headers: REMOTE,
    })
    expect(JSON.parse(locked.body.toString()).secretToken).toBeUndefined()
    expect(harnessed.auth.hasSecretToken).toBe(false)

    const unlocked = await post(harnessed.port, { adminUnlock: ADMIN }, { headers: REMOTE })
    const adminCookie = cookiePair(unlocked, 'dsh_lan_guard_admin')
    const snapshot = await requestTo(harnessed.port, {
      path: '/plugins/dsh-lan-guard/config',
      headers: { ...REMOTE, cookie: adminCookie },
    })
    expect(JSON.parse(snapshot.body.toString()).secretToken).toMatch(/^dsh_[0-9a-f]{36}$/)
    expect(harnessed.auth.hasSecretToken).toBe(true)
  })
})

describe('access information', () => {
  it('includes the access snapshot without the token while locked', async () => {
    const harnessed = await harness({ auth: { adminPolicy: 'password_unlock' } })
    const response = await requestTo(harnessed.port, {
      path: '/plugins/dsh-lan-guard/config',
      headers: REMOTE,
    })
    const body = JSON.parse(response.body.toString())
    expect(body.access.selectedUrl).toBe('http://127.0.0.1:3445/')
    expect(body.access.tokenUrl).toBeUndefined()
    expect(body.access.qrSvg).toBeNull()
  })

  it('adds the passwordless URL and its QR only when unlocked', async () => {
    const harnessed = await harness()
    await harnessed.auth.ensureSecretToken()
    const unlocked = await post(harnessed.port, { adminUnlock: ADMIN })
    const adminCookie = cookiePair(unlocked, 'dsh_lan_guard_admin')
    const response = await requestTo(harnessed.port, {
      path: '/plugins/dsh-lan-guard/config',
      headers: { cookie: adminCookie },
    })
    const body = JSON.parse(response.body.toString())
    expect(body.access.tokenUrl).toContain('?auth=dsh_')
    expect(body.access.tokenQrSvg).toContain('<svg')
  })

  it('enforces the agreed minimum password length', async () => {
    const harnessed = await harness()
    const short = await post(harnessed.port, { setPassword: { current: PASSWORD, next: 'short' } })
    expect(short.status).toBe(400)
    expect(short.body.toString()).toContain('at least 8 characters')
    const long = await post(harnessed.port, { setPassword: { current: PASSWORD, next: 'long enough' } })
    expect(long.status).toBe(200)
  })
})

describe('network interface selection (P4-a)', () => {
  it('writes the interface through the settings service', async () => {
    const harnessed = await harness()
    const unlocked = await post(harnessed.port, { adminUnlock: ADMIN })
    const adminCookie = cookiePair(unlocked, 'dsh_lan_guard_admin')
    const response = await post(harnessed.port, { preferences: { networkInterface: 'en0' } }, {
      headers: { cookie: adminCookie },
    })
    expect(response.status).toBe(200)
    expect(harnessed.updates).toEqual([{ ns: 'dsh-lan-guard', patch: { networkInterface: 'en0' } }])
  })

  it('drops an unknown key beside the interface selection', async () => {
    const harnessed = await harness()
    const unlocked = await post(harnessed.port, { adminUnlock: ADMIN })
    const adminCookie = cookiePair(unlocked, 'dsh_lan_guard_admin')
    await post(harnessed.port, { preferences: { networkInterface: 'en0', shell: 'rm -rf /' } }, {
      headers: { cookie: adminCookie },
    })
    expect(harnessed.updates).toEqual([{ ns: 'dsh-lan-guard', patch: { networkInterface: 'en0' } }])
  })
})

describe('listen scope (2026-09-25)', () => {
  it('writes the bind address through the settings service', async () => {
    const harnessed = await harness()
    const unlocked = await post(harnessed.port, { adminUnlock: ADMIN })
    const adminCookie = cookiePair(unlocked, 'dsh_lan_guard_admin')
    const response = await post(harnessed.port, { preferences: { listenHost: '0.0.0.0' } }, {
      headers: { cookie: adminCookie },
    })
    expect(response.status).toBe(200)
    expect(harnessed.updates).toEqual([{ ns: 'dsh-lan-guard', patch: { listenHost: '0.0.0.0' } }])
  })

  it('refuses a NIC literal from the endpoint', async () => {
    const harnessed = await harness()
    const unlocked = await post(harnessed.port, { adminUnlock: ADMIN })
    const adminCookie = cookiePair(unlocked, 'dsh_lan_guard_admin')
    const response = await post(harnessed.port, { preferences: { listenHost: '10.0.0.20' } }, {
      headers: { cookie: adminCookie },
    })
    expect(response.status).toBe(400)
    expect(harnessed.updates).toEqual([])
  })

  it('refuses a non-loopback bind while the gate is disabled', async () => {
    // parseConfig rejects that combination at startup, so writing it from the
    // page would break the next restart. A refused save beats a broken boot.
    const harnessed = await harness({ auth: { enabled: false } })
    const unlocked = await post(harnessed.port, { adminUnlock: ADMIN })
    const adminCookie = cookiePair(unlocked, 'dsh_lan_guard_admin')
    const response = await post(harnessed.port, { preferences: { listenHost: '0.0.0.0' } }, {
      headers: { cookie: adminCookie },
    })
    expect(response.status).toBe(400)
    expect(JSON.parse(response.body.toString()).error).toBe('gate_disabled_requires_loopback')
    expect(harnessed.updates).toEqual([])
  })
})

describe('first-run bootstrap in the real environment', () => {
  it('unlocks the management session when the FIRST password is set', async () => {
    const harnessed = await harness({ password: null, adminPassword: null })
    const response = await post(harnessed.port, { setPassword: { next: 'first real secret' } })
    expect(response.status).toBe(200)
    const adminCookie = cookiePair(response, 'dsh_lan_guard_admin')
    const snapshot = await requestTo(harnessed.port, {
      path: '/plugins/dsh-lan-guard/config',
      headers: { cookie: adminCookie },
    })
    expect(JSON.parse(snapshot.body.toString()).authStatus.adminUnlocked).toBe(true)
  })
})

describe('port configuration', () => {
  it('validates the listenPort patch', async () => {
    const harnessed = await harness()
    const bad = await post(harnessed.port, { preferences: { listenPort: 70_000 } })
    expect(bad.status).toBe(400)
    expect(bad.body.toString()).toContain('listenPort')
    const ok = await post(harnessed.port, { preferences: { listenPort: 3085 } })
    expect(ok.status).toBe(200)
    expect(harnessed.updates).toEqual([{ ns: 'dsh-lan-guard', patch: { listenPort: 3085 } }])
  })

  it('reports a free port and a busy port', async () => {
    const { createServer } = await import('node:net')
    const blocker = createServer()
    await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve))
    const address = blocker.address()
    const busyPort = typeof address === 'object' && address !== null ? address.port : 0

    const harnessed = await harness()
    const busy = await requestTo(harnessed.port, {
      path: `/plugins/dsh-lan-guard/port-check?port=${String(busyPort)}`,
    })
    expect(JSON.parse(busy.body.toString()).available).toBe(false)

    const { createServer: createProbe } = await import('node:net')
    const probe = createProbe()
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
    const probeAddress = probe.address()
    const freePort = typeof probeAddress === 'object' && probeAddress !== null ? probeAddress.port : 0
    await new Promise<void>(resolve => probe.close(() => resolve()))

    const free = await requestTo(harnessed.port, {
      path: `/plugins/dsh-lan-guard/port-check?port=${String(freePort)}`,
    })
    expect(JSON.parse(free.body.toString()).available).toBe(true)
    await new Promise<void>(resolve => blocker.close(() => resolve()))
  })

  it('refuses a nonsense port', async () => {
    const harnessed = await harness()
    const response = await requestTo(harnessed.port, {
      path: '/plugins/dsh-lan-guard/port-check?port=abc',
    })
    expect(response.status).toBe(400)
  })
})

describe('paired devices (P4-g)', () => {
  it('lists, adds (token returned once) and revokes', async () => {
    const harnessed = await harness()
    const empty = await requestTo(harnessed.port, { path: '/plugins/dsh-lan-guard/devices' })
    expect(JSON.parse(empty.body.toString()).devices).toEqual([])

    // Devices are created by the PAIRING PAGE (the phone names itself); the
    // console only lists and revokes them.
    const { device, token } = await harnessed.devices.add('我的 iPhone')
    const listed = await requestTo(harnessed.port, { path: '/plugins/dsh-lan-guard/devices' })
    const listedBody = JSON.parse(listed.body.toString())
    expect(listedBody.devices).toHaveLength(1)
    expect(listedBody.devices[0].label).toBe('我的 iPhone')
    // The list never carries the token.
    expect(listed.body.toString()).not.toContain(token)

    const id = device.id
    const revoked = await requestTo(harnessed.port, {
      method: 'POST',
      path: '/plugins/dsh-lan-guard/devices',
      headers: { 'content-type': 'application/json', host: `127.0.0.1:${String(harnessed.port)}` },
      body: JSON.stringify({ action: 'revoke', id }),
    })
    expect(revoked.status).toBe(200)
    expect(JSON.parse(revoked.body.toString()).devices[0].revoked).toBe(true)
    expect(harnessed.devices.verify(token)).toBeUndefined()
  })

  it('refuses remote read-only device changes', async () => {
    const harnessed = await harness()
    const refused = await requestTo(harnessed.port, {
      method: 'POST',
      path: '/plugins/dsh-lan-guard/devices',
      headers: { ...REMOTE, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'add', label: 'x' }),
    })
    expect(refused.status).toBe(403)
    expect(JSON.parse(refused.body.toString()).error).toBe('read_only_remote')
  })

  it('rejects a bad action', async () => {
    const harnessed = await harness()
    const bad = await requestTo(harnessed.port, {
      method: 'POST',
      path: '/plugins/dsh-lan-guard/devices',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'nope' }),
    })
    expect(bad.status).toBe(400)
  })
})

describe('F9 device endpoints', () => {
  it('approves, blocks and unblocks a device', async () => {
    const harnessed = await harness()
    const { device } = await harnessed.devices.add('待批准手机', { pending: true })
    const listed = await requestTo(harnessed.port, { path: '/plugins/dsh-lan-guard/devices' })
    expect(JSON.parse(listed.body.toString()).devices[0].status).toBe('pending')

    const call = async (action: string): Promise<string> => {
      const response = await requestTo(harnessed.port, {
        method: 'POST',
        path: '/plugins/dsh-lan-guard/devices',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, id: device.id }),
      })
      expect(response.status).toBe(200)
      return JSON.parse(response.body.toString()).devices[0].status as string
    }
    expect(await call('approve')).toBe('approved')
    expect(await call('block')).toBe('blocked')
    expect(await call('unblock')).toBe('pending')
  })

  it('exposes pendingCount in the snapshot', async () => {
    const harnessed = await harness()
    await harnessed.devices.add('待批准', { pending: true })
    const response = await requestTo(harnessed.port, { path: '/plugins/dsh-lan-guard/config' })
    const body = JSON.parse(response.body.toString())
    expect(body.pendingCount).toBe(1)
    expect(body.preferences.requireApproval).toBe(false)
  })
})

describe('remote settings-page unlock (2026-09-26)', () => {
  it('reports the switch in the snapshot', async () => {
    const harnessed = await harness()
    const response = await requestTo(harnessed.port, { path: '/plugins/dsh-lan-guard/config' })
    expect(JSON.parse(response.body.toString()).preferences.settingsUnlock).toBe(true)
  })

  it('writes the switch through the settings service', async () => {
    const harnessed = await harness()
    const response = await post(harnessed.port, { preferences: { settingsUnlock: false } })
    expect(response.status).toBe(200)
    expect(harnessed.updates).toEqual([{ ns: 'dsh-lan-guard', patch: { settingsUnlock: false } }])
  })

  it('refuses a non-boolean', async () => {
    const harnessed = await harness()
    const response = await post(harnessed.port, { preferences: { settingsUnlock: 'off' } })
    expect(response.status).toBe(400)
    expect(harnessed.updates).toEqual([])
  })
})

describe('mobile resilience surface (2026-09-28)', () => {
  it('reports all three switches in the snapshot', async () => {
    const harnessed = await harness()
    const response = await requestTo(harnessed.port, { path: '/plugins/dsh-lan-guard/config' })
    const body = JSON.parse(response.body.toString()) as { preferences: Record<string, unknown> }
    expect(body.preferences.answerHeartbeat).toBe(true)
    expect(body.preferences.socketWatchdog).toBe(true)
    expect(body.preferences.mobileCompat).toBe(true)
    expect(body.preferences.mobileScrollFix).toBe(true)
  })

  it('writes each switch through the settings service', async () => {
    for (const key of ['answerHeartbeat', 'socketWatchdog', 'mobileCompat', 'mobileScrollFix'] as const) {
      const harnessed = await harness()
      const response = await post(harnessed.port, { preferences: { [key]: false } })
      expect(response.status).toBe(200)
      expect(harnessed.updates).toEqual([{ ns: 'dsh-lan-guard', patch: { [key]: false } }])
      await closer?.()
      closer = undefined
    }
  })

  it('omits the relay counters when the host supplies no proxy', async () => {
    const harnessed = await harness()
    const response = await requestTo(harnessed.port, { path: '/plugins/dsh-lan-guard/config' })
    expect(JSON.parse(response.body.toString()).connection).toBeUndefined()
  })

  it('reports the relay counters when a proxy is present (P5 health panel)', async () => {
    const harnessed = await harness({
      relay: {
        stats: () => ({
          wsActive: 1,
          wsUpgrades: 7,
          wsRefused: 2,
          heartbeatAnswered: 41,
          recent: [{
            atMs: 1,
            target: '/api/remote.mux',
            upgraded: true,
            durationMs: 6_000,
            bytesToVisitor: 2_000_000,
            bytesToUpstream: 12_000,
            sawCloseFrame: false,
          }],
        }),
      },
    })
    const response = await requestTo(harnessed.port, { path: '/plugins/dsh-lan-guard/config' })
    const connection = JSON.parse(response.body.toString()).connection as {
      heartbeatAnswered: number
      recent: { durationMs: number; sawCloseFrame: boolean }[]
    }
    expect(connection.heartbeatAnswered).toBe(41)
    expect(connection.recent[0]?.durationMs).toBe(6_000)
    expect(connection.recent[0]?.sawCloseFrame).toBe(false)
  })
})
