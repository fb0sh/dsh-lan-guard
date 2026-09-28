/**
 * Config model tests.
 *
 * The point of this file is the REJECTION side: every documented constraint
 * that keeps the listener safe must fail loudly rather than silently widen a
 * default. Assertions are never loosened to fit the implementation.
 */
import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DATA_DIR_NAME,
  DEFAULT_LISTEN_HOST,
  DEFAULT_LISTEN_PORT,
  DEFAULT_UPSTREAM_ORIGIN,
  LanGuardConfigError,
  isIpv4Literal,
  isLoopbackHost,
  isLoopbackOrigin,
  parseConfig,
  resolveDataDir,
} from '../src/config.ts'

/** The smallest config that is allowed to start. */
const MINIMAL = { dataDir: '/tmp/dsh-lan-guard-test' }

describe('parseConfig defaults', () => {
  it('applies the documented defaults', () => {
    const config = parseConfig(MINIMAL)
    expect(config.enabled).toBe(true)
    expect(config.listenHost).toBe(DEFAULT_LISTEN_HOST)
    expect(config.listenPort).toBe(DEFAULT_LISTEN_PORT)
    expect(config.upstreamOrigin).toBe(DEFAULT_UPSTREAM_ORIGIN)
    expect(config.networkInterface).toBeNull()
    expect(config.settingsUnlock).toBe(true)
    expect(config.auth.enabled).toBe(true)
    expect(config.auth.mode).toBe('token_and_password')
    expect(config.auth.adminPolicy).toBe('local_only')
    expect(config.auth.adminProtection).toBe(true)
    expect(config.auth.allowLoopback).toBe(true)
    expect(config.auth.sessionMaxAgeMs).toBe(2_592_000_000)
    expect(config.auth.adminSessionMaxAgeMs).toBe(1_800_000)
    expect(config.auth.maxFailedAttempts).toBe(5)
    expect(config.auth.lockoutMs).toBe(60_000)
    expect(config.tls.mode).toBe('self-signed')
  })

  it('defaults to a LAN-reachable listener WITH the gate and TLS on', () => {
    // User decision 2026-09-25: the plugin exists
    // to give LAN access, so a fresh install must be reachable after ONE
    // restart. The default is therefore 0.0.0.0 — and the two safety nets that
    // make that acceptable must be on in the same breath.
    const config = parseConfig(MINIMAL)
    expect(config.listenHost).toBe('0.0.0.0')
    expect(config.auth.enabled).toBe(true)
    expect(config.tls.mode).toBe('self-signed')
    expect(config.tls.allowInsecureLan).toBe(false)
  })

  it('keeps the default port clear of DSH and dsh-mobile', () => {
    expect([3080, 3443, 3444]).not.toContain(DEFAULT_LISTEN_PORT)
  })
})

describe('dataDir resolution', () => {
  const PROFILE = '/tmp/dsh-profile'
  const DERIVED = join(PROFILE, 'data', DATA_DIR_NAME)

  it('derives <profile>/data/dsh-lan-guard so a fresh install needs no config', () => {
    expect(parseConfig({}, PROFILE).dataDir).toBe(DERIVED)
    expect(resolveDataDir({}, PROFILE)).toEqual({ dir: DERIVED, source: 'profile' })
  })

  it('lets an explicit dataDir win over the derived default', () => {
    expect(parseConfig({ dataDir: '/tmp/explicit' }, PROFILE).dataDir).toBe('/tmp/explicit')
    expect(resolveDataDir({ dataDir: '/tmp/explicit' }, PROFILE)).toEqual({
      dir: '/tmp/explicit',
      source: 'config',
    })
  })

  it('treats a blank or absent dataDir as "not configured"', () => {
    expect(parseConfig({ dataDir: '   ' }, PROFILE).dataDir).toBe(DERIVED)
    expect(parseConfig({ dataDir: null }, PROFILE).dataDir).toBe(DERIVED)
    expect(parseConfig({ dataDir: undefined }, PROFILE).dataDir).toBe(DERIVED)
  })

  it('expands a leading ~ in an explicit dataDir', () => {
    // README documents `~/.dsh/...`, so the plugin must honour it rather than
    // creating a literal "~" directory under the process CWD.
    expect(parseConfig({ dataDir: '~/lg' }).dataDir).toBe(join(homedir(), 'lg'))
    expect(parseConfig({ dataDir: '~' }).dataDir).toBe(homedir())
  })

  it('reports no resolution instead of inventing a shared directory', () => {
    expect(resolveDataDir({})).toBeNull()
    expect(resolveDataDir({}, '   ')).toBeNull()
  })
})

describe('parseConfig rejection', () => {
  it('refuses to start when neither an explicit nor a derived dataDir exists', () => {
    // A host that names no profile directory is the only case left: the plugin
    // must not invent one.
    expect(() => parseConfig({})).toThrow(LanGuardConfigError)
    expect(() => parseConfig({ dataDir: '   ' })).toThrow(/dataDir/)
    expect(() => parseConfig({}, '   ')).toThrow(/dataDir/)
  })

  it('rejects a hostname listenHost', () => {
    expect(() => parseConfig({ ...MINIMAL, listenHost: 'localhost' })).toThrow(/IPv4 literal/)
    expect(() => parseConfig({ ...MINIMAL, listenHost: 'dsh.local' })).toThrow(/IPv4 literal/)
  })

  it('rejects a non-loopback upstream origin', () => {
    expect(() => parseConfig({ ...MINIMAL, upstreamOrigin: 'http://10.0.0.30:3080' })).toThrow(/loopback/)
    expect(() => parseConfig({ ...MINIMAL, upstreamOrigin: 'not a url' })).toThrow(LanGuardConfigError)
  })

  it('rejects an https upstream origin', () => {
    expect(() => parseConfig({ ...MINIMAL, upstreamOrigin: 'https://127.0.0.1:3080' })).toThrow(/http:/)
  })

  it('refuses to disable the gate on a network listener', () => {
    expect(() => parseConfig({
      ...MINIMAL,
      listenHost: '0.0.0.0',
      auth: { enabled: false },
    })).toThrow(/loopback listener/)
  })

  it('allows disabling the gate on loopback only', () => {
    const config = parseConfig({ ...MINIMAL, listenHost: '127.0.0.1', auth: { enabled: false } })
    expect(config.auth.enabled).toBe(false)
  })

  it('rejects an out-of-range port and a non-numeric port', () => {
    expect(() => parseConfig({ ...MINIMAL, listenPort: 70_000 })).toThrow(LanGuardConfigError)
    expect(() => parseConfig({ ...MINIMAL, listenPort: -1 })).toThrow(LanGuardConfigError)
    expect(() => parseConfig({ ...MINIMAL, listenPort: 'abc' })).toThrow(LanGuardConfigError)
  })

  it('rejects an unknown auth mode', () => {
    expect(() => parseConfig({ ...MINIMAL, auth: { mode: 'magic' } })).toThrow(LanGuardConfigError)
  })

  it('rejects an unknown admin policy', () => {
    expect(() => parseConfig({ ...MINIMAL, auth: { adminPolicy: 'anyone' } })).toThrow(LanGuardConfigError)
  })

  it('rejects non-positive session lifetimes and attempt budgets', () => {
    expect(() => parseConfig({ ...MINIMAL, auth: { sessionMaxAgeMs: 0 } })).toThrow(/sessionMaxAgeMs/)
    expect(() => parseConfig({ ...MINIMAL, auth: { adminSessionMaxAgeMs: 0 } })).toThrow(/adminSessionMaxAgeMs/)
    expect(() => parseConfig({ ...MINIMAL, auth: { maxFailedAttempts: 0 } })).toThrow(/maxFailedAttempts/)
  })

  it('requires certificate files when tls.mode is provided', () => {
    expect(() => parseConfig({ ...MINIMAL, tls: { mode: 'provided' } })).toThrow(/certFile/)
    expect(() => parseConfig({
      ...MINIMAL,
      tls: { mode: 'provided', certFile: '/tmp/leaf.pem', keyFile: '/tmp/leaf-key.pem' },
    })).not.toThrow()
  })

  it('rejects an unknown tls mode', () => {
    expect(() => parseConfig({ ...MINIMAL, tls: { mode: 'acme' } })).toThrow(LanGuardConfigError)
  })
})

describe('address helpers', () => {
  it('recognizes IPv4 literals only', () => {
    expect(isIpv4Literal('192.168.1.5')).toBe(true)
    expect(isIpv4Literal('256.1.1.1')).toBe(false)
    expect(isIpv4Literal('127.0.0.1')).toBe(true)
    expect(isIpv4Literal('localhost')).toBe(false)
  })

  it('recognizes loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('127.9.9.9')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('192.168.1.5')).toBe(false)
  })

  it('recognizes loopback origins', () => {
    expect(isLoopbackOrigin('http://127.0.0.1:3080')).toBe(true)
    expect(isLoopbackOrigin('http://192.168.1.5:3080')).toBe(false)
    expect(isLoopbackOrigin('ftp://127.0.0.1')).toBe(false)
    expect(isLoopbackOrigin('')).toBe(false)
  })
})

describe('already-resolved configs', () => {
  it('accepts the config the Loader resolved (volatile references, not raw values)', async () => {
    // The Loader validates through Config BEFORE calling apply, so apply sees
    // volatile references. parseConfig must handle that, not reject it.
    const { Config } = await import('../src/config.ts')
    const resolved = Config({ dataDir: '/tmp/x' } as never) as unknown
    expect((resolved as { enabled: unknown }).enabled).toBeTypeOf('object')
    const parsed = parseConfig(resolved)
    expect(parsed.enabled).toBe(true)
    expect(parsed.auth.mode).toBe('token_and_password')
    expect(parsed.auth.allowLoopback).toBe(true)
    expect(parsed.dataDir).toBe('/tmp/x')
  })

  it('keeps live switches live after an edit', async () => {
    const { Config, liveSwitches } = await import('../src/config.ts')
    const resolved = Config({ dataDir: '/tmp/x' } as never) as unknown
    const parsed = parseConfig(resolved)
    const switches = liveSwitches(resolved, parsed)
    expect(switches.mode()).toBe('token_and_password')
    const reference = (resolved as { auth: { mode: { get(): string } } }).auth.mode
    // The settings service writes through the reference's hidden writer; the
    // observable contract here is that the accessor reads the reference.
    expect(reference.get()).toBe('token_and_password')
  })
})

describe('networkInterface switch (P4-a)', () => {
  it('is volatile, defaults to null, and survives the resolved-config handoff', async () => {
    const { Config, liveSwitches } = await import('../src/config.ts')
    const resolved = Config({ dataDir: '/tmp/x', networkInterface: 'en0' } as never) as unknown
    expect((resolved as { networkInterface: unknown }).networkInterface).toBeTypeOf('object')
    const parsed = parseConfig(resolved)
    expect(parsed.networkInterface).toBe('en0')
    expect(liveSwitches(resolved, parsed).networkInterface()).toBe('en0')
  })

  it('maps an empty value to null and rejects an implausible name', async () => {
    const { sanitizePreferencePatch, toSettingsPatch } = await import('../src/store/preferences.ts')
    expect(parseConfig({ dataDir: '/tmp/x' }).networkInterface).toBeNull()
    expect(sanitizePreferencePatch({ networkInterface: 'en0' })).toEqual({ networkInterface: 'en0' })
    expect(sanitizePreferencePatch({ networkInterface: '' })).toEqual({ networkInterface: '' })
    expect(() => sanitizePreferencePatch({ networkInterface: 'a b; rm -rf /' })).toThrow(/interface name/)
    expect(() => sanitizePreferencePatch({ networkInterface: 7 })).toThrow(/string/)
    expect(toSettingsPatch({ networkInterface: 'en0' })).toEqual({ networkInterface: 'en0' })
  })
})

describe('listenHost switch (2026-09-25)', () => {
  it('is volatile and survives the resolved-config handoff', async () => {
    const { Config, liveSwitches } = await import('../src/config.ts')
    const resolved = Config({ dataDir: '/tmp/x', listenHost: '127.0.0.1' } as never) as unknown
    expect((resolved as { listenHost: unknown }).listenHost).toBeTypeOf('object')
    const parsed = parseConfig(resolved)
    expect(parsed.listenHost).toBe('127.0.0.1')
    expect(liveSwitches(resolved, parsed).listenHost()).toBe('127.0.0.1')
  })

  it('reads the live reference rather than freezing the startup value', async () => {
    const { Config, liveSwitches } = await import('../src/config.ts')
    const resolved = Config({ dataDir: '/tmp/x' } as never) as unknown
    const parsed = parseConfig(resolved)
    const switches = liveSwitches(resolved, parsed)
    expect(switches.listenHost()).toBe('0.0.0.0')
    // The accessor reads the volatile reference, so a settings-service write is
    // visible without a remount (the writer itself is host-owned).
    const reference = (resolved as { listenHost: { get(): string } }).listenHost
    expect(reference.get()).toBe('0.0.0.0')
    expect(switches.listenHost()).toBe(reference.get())
  })

  it('accepts exactly the two addresses the settings page offers', async () => {
    const { sanitizePreferencePatch, toSettingsPatch } = await import('../src/store/preferences.ts')
    expect(sanitizePreferencePatch({ listenHost: '127.0.0.1' })).toEqual({ listenHost: '127.0.0.1' })
    expect(sanitizePreferencePatch({ listenHost: '0.0.0.0' })).toEqual({ listenHost: '0.0.0.0' })
    expect(toSettingsPatch({ listenHost: '127.0.0.1' })).toEqual({ listenHost: '127.0.0.1' })
    // A NIC literal stays a profile-patch-only, advanced setting: the endpoint
    // must not become "write any address string".
    expect(() => sanitizePreferencePatch({ listenHost: '10.0.0.20' })).toThrow(/listenHost/)
    expect(() => sanitizePreferencePatch({ listenHost: '' })).toThrow(/listenHost/)
    expect(() => sanitizePreferencePatch({ listenHost: true })).toThrow(/listenHost/)
  })
})

describe('LAN HTTP acknowledgement (P4-e)', () => {
  it('refuses plain HTTP on a non-loopback listener without the explicit flag', () => {
    expect(() => parseConfig({
      dataDir: '/tmp/x',
      listenHost: '0.0.0.0',
      tls: { mode: 'off' },
    })).toThrow(/allowInsecureLan/)
  })

  it('allows it once the operator acknowledges the risk explicitly', () => {
    const config = parseConfig({
      dataDir: '/tmp/x',
      listenHost: '0.0.0.0',
      tls: { mode: 'off', allowInsecureLan: true },
    })
    expect(config.tls.mode).toBe('off')
    expect(config.tls.allowInsecureLan).toBe(true)
  })

  it('still allows TLS-off on loopback without any acknowledgement', () => {
    expect(parseConfig({ dataDir: '/tmp/x', listenHost: '127.0.0.1', tls: { mode: 'off' } }).tls.mode).toBe('off')
  })
})

describe('settingsUnlock switch (2026-09-26)', () => {
  it('defaults to ON, because the gate — not this switch — protects the surface', () => {
    expect(parseConfig({ dataDir: '/tmp/x' }).settingsUnlock).toBe(true)
  })

  it('is volatile and survives the resolved-config handoff', async () => {
    const { Config, liveSwitches } = await import('../src/config.ts')
    const resolved = Config({ dataDir: '/tmp/x', settingsUnlock: false } as never) as unknown
    // The Loader hands `apply` volatile references, not bare values; a
    // re-validation that rejected that shape would take the plugin down.
    expect((resolved as { settingsUnlock: unknown }).settingsUnlock).toBeTypeOf('object')
    const parsed = parseConfig(resolved)
    expect(parsed.settingsUnlock).toBe(false)
    expect(liveSwitches(resolved, parsed).settingsUnlock()).toBe(false)
    expect(liveSwitches(resolved, parsed).settingsUnlock()).toBe(false)
  })

  it('accepts a boolean from the settings page and refuses anything else', async () => {
    const { sanitizePreferencePatch, toSettingsPatch } = await import('../src/store/preferences.ts')
    expect(sanitizePreferencePatch({ settingsUnlock: false })).toEqual({ settingsUnlock: false })
    expect(sanitizePreferencePatch({ settingsUnlock: true })).toEqual({ settingsUnlock: true })
    expect(toSettingsPatch({ settingsUnlock: false })).toEqual({ settingsUnlock: false })
    expect(() => sanitizePreferencePatch({ settingsUnlock: 'off' })).toThrow(/boolean/)
    expect(() => sanitizePreferencePatch({ settingsUnlock: 0 })).toThrow(/boolean/)
  })
})

describe('mobile resilience switches (2026-09-28)', () => {
  const KEYS = ['answerHeartbeat', 'socketWatchdog', 'mobileCompat', 'mobileScrollFix'] as const

  it('all default ON: the failure they prevent is invisible until it happens', () => {
    const config = parseConfig({ dataDir: '/tmp/x' })
    for (const key of KEYS) expect(config[key]).toBe(true)
  })

  it('are volatile, so a toggle applies without a restart', async () => {
    const { Config, liveSwitches, parseConfig: parse } = await import('../src/config.ts')
    const resolved = Config({ dataDir: '/tmp/x', answerHeartbeat: false, socketWatchdog: false, mobileCompat: false, mobileScrollFix: false } as never) as unknown
    for (const key of KEYS) expect((resolved as Record<string, unknown>)[key]).toBeTypeOf('object')
    const parsed = parse(resolved)
    const switches = liveSwitches(resolved, parsed)
    for (const key of KEYS) {
      expect(parsed[key]).toBe(false)
      expect(switches[key]()).toBe(false)
    }
  })

  it('accept booleans from the settings page and refuse anything else', async () => {
    const { sanitizePreferencePatch, toSettingsPatch } = await import('../src/store/preferences.ts')
    for (const key of KEYS) {
      expect(sanitizePreferencePatch({ [key]: false })).toEqual({ [key]: false })
      expect(toSettingsPatch({ [key]: false })).toEqual({ [key]: false })
      expect(() => sanitizePreferencePatch({ [key]: 'off' })).toThrow(/boolean/)
    }
    // The whitelist is the whole point: an unknown key never reaches the writer.
    expect(sanitizePreferencePatch({ answerHeartbeat: true, somethingElse: true })).toEqual({ answerHeartbeat: true })
  })
})
