/**
 * Gate unit tests.
 *
 * The password hashing contract, the dual-password/admin-session split, the
 * per-IP lockout and the CSRF check are pinned here; the request-level flow is
 * in `gate.test.ts`.
 */
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AuthManager,
  LEGACY_PBKDF2_ITERATIONS,
  PBKDF2_ITERATIONS,
  generateSecretToken,
  hashPassword,
  isLoopbackAddress,
  passesCsrfCheck,
  readCookie,
  safeEqual,
  verifyPassword,
} from '../src/auth/manager.ts'
import { staticSwitches, type LanGuardConfigShape } from '../src/config.ts'
import { SecretsStore } from '../src/store/secrets.ts'
import { tmpDataDir } from './helpers/tmp.ts'

const PASSWORD = 'correct horse battery staple'
const ADMIN = 'admin password 42'

/** A request stub with the fields the gate reads. */
function reqStub(input: {
  remoteAddress?: string
  cookie?: string
  origin?: string
  host?: string
  secFetchSite?: string
} = {}): IncomingMessage {
  return {
    headers: {
      ...(input.cookie === undefined ? {} : { cookie: input.cookie }),
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      ...(input.host === undefined ? {} : { host: input.host }),
      ...(input.secFetchSite === undefined ? {} : { 'sec-fetch-site': input.secFetchSite }),
    },
    socket: { remoteAddress: input.remoteAddress ?? '192.168.1.50' },
  } as unknown as IncomingMessage
}

/** A minimal resolved config for the manager. */
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
      requirePairing: true,
      requireApproval: false,
      ...overrides,
    },
    tls: { mode: 'off', caCertFile: null, caKeyFile: null, certFile: null, keyFile: null, allowInsecureLan: false },
    mdns: { enabled: false },
  }
}

let managers: AuthManager[] = []

afterEach(() => {
  for (const manager of managers) manager.dispose()
  managers = []
})

/** Build an initialized manager over a fresh data dir. */
async function manager(
  overrides: Partial<LanGuardConfigShape['auth']> = {},
  now: () => number = () => Date.now(),
): Promise<AuthManager> {
  const config = configWith(overrides)
  const created = new AuthManager({
    store: new SecretsStore(await tmpDataDir()),
    auth: config.auth,
    switches: staticSwitches(config),
    now,
  })
  managers.push(created)
  await created.init()
  return created
}

describe('password hashing', () => {
  it('stores the documented prefixed format with 600000 iterations', async () => {
    const stored = await hashPassword(PASSWORD, 'aabb')
    expect(stored.startsWith(`pbkdf2-sha256$${String(PBKDF2_ITERATIONS)}$`)).toBe(true)
    expect(stored.split('$')[2]).toHaveLength(64)
  })

  it('verifies the right password and rejects the wrong one', async () => {
    const stored = await hashPassword(PASSWORD, 'aabb')
    await expect(verifyPassword(PASSWORD, 'aabb', stored)).resolves.toBe(true)
    await expect(verifyPassword(`${PASSWORD}!`, 'aabb', stored)).resolves.toBe(false)
  })

  it('treats a bare hex hash as the legacy 10000-iteration format', async () => {
    const legacy = await hashPassword(PASSWORD, 'ccdd', LEGACY_PBKDF2_ITERATIONS)
    const bareHex = legacy.split('$')[2] ?? ''
    expect(bareHex).not.toContain('$')
    await expect(verifyPassword(PASSWORD, 'ccdd', bareHex)).resolves.toBe(true)
    await expect(verifyPassword('nope', 'ccdd', bareHex)).resolves.toBe(false)
  })

  it('refuses an empty or missing stored hash', async () => {
    await expect(verifyPassword(PASSWORD, null, null)).resolves.toBe(false)
    await expect(verifyPassword(PASSWORD, 'aabb', '')).resolves.toBe(false)
  })

  it('compares in constant time and rejects length mismatches', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })

  it('generates a dsh_ token with 36 hex characters', () => {
    const token = generateSecretToken()
    expect(token).toMatch(/^dsh_[0-9a-f]{36}$/)
    expect(generateSecretToken()).not.toBe(token)
  })

  it('never writes the plaintext password to disk', async () => {
    const store = new SecretsStore(await tmpDataDir())
    const config = configWith()
    const created = new AuthManager({ store, auth: config.auth, switches: staticSwitches(config) })
    managers.push(created)
    await created.init()
    await created.setPassword(PASSWORD)

    const raw = await readFile(store.secretsPath, 'utf8')
    expect(raw).not.toContain(PASSWORD)
    expect(raw).toContain('pbkdf2-sha256$')
    const mode = (await stat(store.secretsPath)).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

describe('visitor sessions', () => {
  it('refuses every visitor while no password is configured', async () => {
    const gate = await manager()
    expect(gate.hasPassword).toBe(false)
    const result = await gate.login(reqStub(), 'anything')
    expect(result).toEqual({ ok: false, reason: 'no-password' })
    expect(gate.verifyRequest(reqStub())).toEqual({ ok: false, reason: 'unauthorized' })
  })

  it('mints a session on the right password and accepts it', async () => {
    const gate = await manager()
    await gate.setPassword(PASSWORD)
    const result = await gate.login(reqStub(), PASSWORD)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const cookie = result.cookie.split(';')[0] ?? ''
    expect(gate.verifyRequest(reqStub({ cookie }))).toEqual({ ok: true, via: 'session' })
  })

  it('rejects a wrong password without minting a session', async () => {
    const gate = await manager()
    await gate.setPassword(PASSWORD)
    const result = await gate.login(reqStub(), 'wrong')
    expect(result).toEqual({ ok: false, reason: 'invalid' })
  })

  it('locks an IP after the configured number of failures, then refuses even the right password', async () => {
    let now = 1_000_000
    const gate = await manager({ maxFailedAttempts: 3, lockoutMs: 60_000 }, () => now)
    await gate.setPassword(PASSWORD)

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await gate.login(reqStub(), 'wrong')).ok).toBe(false)
    }
    const third = await gate.login(reqStub(), 'wrong')
    expect(third.ok).toBe(false)
    if (third.ok) return
    expect(third.reason).toBe('locked')

    const blocked = await gate.login(reqStub(), PASSWORD)
    expect(blocked).toEqual({ ok: false, reason: 'locked', lockedUntilMs: 1_060_000 })
    expect(gate.verifyRequest(reqStub())).toEqual({
      ok: false,
      reason: 'locked',
      lockedUntilMs: 1_060_000,
    })

    now += 60_001
    expect((await gate.login(reqStub(), PASSWORD)).ok).toBe(true)
  })

  it('counts failures per IP', async () => {
    const gate = await manager({ maxFailedAttempts: 2, lockoutMs: 60_000 })
    await gate.setPassword(PASSWORD)
    await gate.login(reqStub({ remoteAddress: '10.0.0.7' }), 'wrong')
    await gate.login(reqStub({ remoteAddress: '10.0.0.7' }), 'wrong')
    // A different address is unaffected.
    expect((await gate.login(reqStub({ remoteAddress: '10.0.0.8' }), PASSWORD)).ok).toBe(true)
  })

  it('exempts loopback only when allowLoopback is set', async () => {
    const exempt = await manager({ allowLoopback: true })
    expect(exempt.verifyRequest(reqStub({ remoteAddress: '127.0.0.1' }))).toEqual({ ok: true, via: 'loopback' })
    const strict = await manager({ allowLoopback: false })
    expect(strict.verifyRequest(reqStub({ remoteAddress: '127.0.0.1' }))).toEqual({
      ok: false,
      reason: 'unauthorized',
    })
  })

  it('passes everything through when the gate is disabled', async () => {
    const gate = await manager({ enabled: false })
    expect(gate.verifyRequest(reqStub())).toEqual({ ok: true, via: 'disabled' })
  })

  it('persists visitor sessions across a restart but not admin sessions', async () => {
    const dir = await tmpDataDir()
    const config = configWith()
    const first = new AuthManager({ store: new SecretsStore(dir), auth: config.auth, switches: staticSwitches(config) })
    managers.push(first)
    await first.init()
    await first.setPassword(PASSWORD)
    await first.setAdminPassword(ADMIN)
    const login = await first.login(reqStub(), PASSWORD)
    if (!login.ok) throw new Error('login failed')
    const admin = await first.unlockAdmin(ADMIN)
    if (admin === undefined) throw new Error('admin unlock failed')
    const visitorCookie = login.cookie.split(';')[0] ?? ''
    const adminCookie = admin.cookie.split(';')[0] ?? ''
    first.dispose()

    const second = new AuthManager({ store: new SecretsStore(dir), auth: config.auth, switches: staticSwitches(config) })
    managers.push(second)
    await second.init()
    expect(second.verifyRequest(reqStub({ cookie: visitorCookie }))).toEqual({ ok: true, via: 'session' })
    expect(second.isAdminUnlocked(reqStub({ cookie: adminCookie }))).toBe(false)
    expect(second.hasPassword).toBe(true)
    expect(second.hasAdminPassword).toBe(true)
  })

  it('expires a visitor session', async () => {
    let now = 5_000
    const gate = await manager({ sessionMaxAgeMs: 1_000 }, () => now)
    await gate.setPassword(PASSWORD)
    const login = await gate.login(reqStub(), PASSWORD)
    if (!login.ok) throw new Error('login failed')
    const cookie = login.cookie.split(';')[0] ?? ''
    expect(gate.verifyRequest(reqStub({ cookie })).ok).toBe(true)
    now += 1_001
    expect(gate.verifyRequest(reqStub({ cookie }))).toEqual({ ok: false, reason: 'unauthorized' })
  })
})

describe('admin unlock', () => {
  it('accepts the admin password independently of any visitor session', async () => {
    const gate = await manager({ adminPolicy: 'password_unlock' })
    await gate.setPassword(PASSWORD)
    await gate.setAdminPassword(ADMIN)
    // The researched deadlock: an unlock must not need a live visitor session.
    const unlocked = await gate.unlockAdmin(ADMIN)
    expect(unlocked).toBeDefined()
    const cookie = unlocked?.cookie.split(';')[0] ?? ''
    expect(gate.isAdminUnlocked(reqStub({ cookie }))).toBe(true)
    expect(gate.isAdminUnlocked(reqStub())).toBe(false)
  })

  it('falls back to the access password when no admin password is set', async () => {
    const gate = await manager()
    await gate.setPassword(PASSWORD)
    expect(await gate.unlockAdmin(PASSWORD)).toBeDefined()
    expect(await gate.unlockAdmin(ADMIN)).toBeUndefined()
  })

  it('rejects a wrong admin password', async () => {
    const gate = await manager()
    await gate.setPassword(PASSWORD)
    await gate.setAdminPassword(ADMIN)
    expect(await gate.unlockAdmin(PASSWORD)).toBeUndefined()
  })

  it('expires the admin session and can be locked explicitly', async () => {
    let now = 10_000
    const gate = await manager({ adminSessionMaxAgeMs: 500 }, () => now)
    await gate.setPassword(PASSWORD)
    const unlocked = await gate.unlockAdmin(PASSWORD)
    const cookie = unlocked?.cookie.split(';')[0] ?? ''
    expect(gate.isAdminUnlocked(reqStub({ cookie }))).toBe(true)
    gate.lockAdmin(reqStub({ cookie }))
    expect(gate.isAdminUnlocked(reqStub({ cookie }))).toBe(false)

    const again = await gate.unlockAdmin(PASSWORD)
    const second = again?.cookie.split(';')[0] ?? ''
    now += 501
    expect(gate.isAdminUnlocked(reqStub({ cookie: second }))).toBe(false)
  })

  it('reports lock state per adminPolicy', async () => {
    const gate = await manager({ adminPolicy: 'local_only' })
    expect(gate.requiresAdminUnlock(reqStub({ remoteAddress: '192.168.1.9' }))).toBe(true)
    expect(gate.requiresAdminUnlock(reqStub({ remoteAddress: '127.0.0.1' }))).toBe(false)

    const open = await manager({ adminPolicy: 'open' })
    expect(open.requiresAdminUnlock(reqStub({ remoteAddress: '192.168.1.9' }))).toBe(false)
  })
})

describe('token and helpers', () => {
  it('verifies the passwordless token in constant time and rotates it', async () => {
    const gate = await manager()
    const token = await gate.ensureSecretToken()
    expect(await gate.verifySecretToken(token)).toBe(true)
    expect(await gate.verifySecretToken(`${token}x`)).toBe(false)
    const rotated = await gate.rotateSecretToken()
    expect(rotated).not.toBe(token)
    expect(await gate.verifySecretToken(token)).toBe(false)
  })

  it('reads cookies by name', () => {
    expect(readCookie(reqStub({ cookie: 'a=1; dsh_lan_guard_session=xyz; b=2' }), 'dsh_lan_guard_session')).toBe('xyz')
    expect(readCookie(reqStub({ cookie: 'a=1' }), 'dsh_lan_guard_session')).toBeUndefined()
    expect(readCookie(reqStub(), 'dsh_lan_guard_session')).toBeUndefined()
  })

  it('recognizes loopback addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('192.168.1.1')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })

  it('enforces the CSRF rule on state changes', () => {
    expect(passesCsrfCheck(reqStub())).toBe(true)
    expect(passesCsrfCheck(reqStub({ host: '10.0.0.5:3445', origin: 'http://10.0.0.5:3445' }))).toBe(true)
    expect(passesCsrfCheck(reqStub({ host: '10.0.0.5:3445', origin: 'http://evil.example' }))).toBe(false)
    expect(passesCsrfCheck(reqStub({ secFetchSite: 'cross-site' }))).toBe(false)
    expect(passesCsrfCheck(reqStub({ origin: 'http://10.0.0.5:3445' }))).toBe(false)
  })
})

describe('CSRF tolerance for real phones', () => {
  it('accepts the fetch-metadata signals a same-origin form sends', () => {
    expect(passesCsrfCheck(reqStub({ secFetchSite: 'same-origin' }))).toBe(true)
    expect(passesCsrfCheck(reqStub({ secFetchSite: 'same-site' }))).toBe(true)
    expect(passesCsrfCheck(reqStub({ secFetchSite: 'none' }))).toBe(true)
  })

  it('accepts an opaque or unparsable Origin instead of locking the phone out', () => {
    // Some in-app browsers / private modes post `Origin: null` on a same-origin
    // form; that used to be answered with the CSRF page.
    expect(passesCsrfCheck(reqStub({ origin: 'null', host: '10.0.0.20:3445' }))).toBe(true)
    expect(passesCsrfCheck(reqStub({ origin: 'not a url', host: '10.0.0.20:3445' }))).toBe(true)
  })

  it('still refuses a real cross-site post', () => {
    expect(passesCsrfCheck(reqStub({ secFetchSite: 'cross-site', origin: 'http://evil.example' }))).toBe(false)
    expect(passesCsrfCheck(reqStub({ origin: 'http://evil.example', host: '10.0.0.20:3445' }))).toBe(false)
  })

  it('tolerates a port-only mismatch between Origin and Host', () => {
    expect(passesCsrfCheck(reqStub({ origin: 'https://10.0.0.20:443', host: '10.0.0.20:3445' }))).toBe(true)
  })
})
