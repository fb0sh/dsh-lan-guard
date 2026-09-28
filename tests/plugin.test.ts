/**
 * Plugin entry tests.
 *
 * These drive the real `apply`/`startLanGuard` wiring with a stub host, so the
 * phase gate, the gate wiring and the lifecycle disposer are exercised without
 * a real DSH process. The real-DSH load is a separate manual acceptance step.
 *
 * (Replaces the P1 version of this file, which asserted the pre-gate runtime
 * shape; that file was created in this same session.)
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { apply, startLanGuard, type LanGuardHost, type LanGuardRuntime } from '../src/index.ts'
import type { LanGuardLogger } from '../src/log.ts'
import type { AuthManager } from '../src/auth/manager.ts'
import type { WebServerLike } from '../src/settings/routes.ts'
import { startFakeDsh, type FakeDsh } from './helpers/fake-dsh.ts'
import { freePort, requestTo } from './helpers/http-client.ts'
import { tmpDataDir } from './helpers/tmp.ts'

let fake: FakeDsh | undefined
let runtime: LanGuardRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  await fake?.close()
  runtime = undefined
  fake = undefined
})

/** A logger that records nothing; assertions here are about behaviour, not logs. */
function silentLogger(): LanGuardLogger {
  return { info() {}, warn() {}, debug() {} }
}

/** A host stub backed by the fake upstream. */
function hostFor(upstream: FakeDsh, extra: Partial<LanGuardHost> = {}): LanGuardHost {
  return {
    authenticatedUrl: upstream.authenticatedUrl,
    logger: silentLogger(),
    ...extra,
  }
}

/** Seed an access password so the gate is a working gate rather than a refusal. */
async function seedPassword(auth: AuthManager): Promise<void> {
  await auth.setPassword('correct horse battery staple')
}

describe('startLanGuard', () => {
  it('serves the upstream through a loopback listener', async () => {
    fake = await startFakeDsh()
    runtime = await startLanGuard(hostFor(fake), {
      dataDir: await tmpDataDir(),
      listenHost: '127.0.0.1',
      listenPort: 0,
      upstreamOrigin: fake.origin,
      tls: { mode: 'off' },
      auth: { allowLoopback: true },
    })
    expect(runtime).toBeDefined()
    expect(runtime?.proxy.host).toBe('127.0.0.1')
    // allowLoopback defaults to true, so a loopback visitor passes the gate.
    const response = await requestTo(runtime?.proxy.port ?? 0, { path: '/' })
    expect(response.status).toBe(200)
    expect(response.body.toString()).toContain('fake dsh index')
  })

  it('opens no listener when the plugin is disabled', async () => {
    fake = await startFakeDsh()
    const result = await startLanGuard(hostFor(fake), {
      dataDir: await tmpDataDir(),
      enabled: false,
    })
    expect(result).toBeUndefined()
  })

  it('refuses a non-loopback listener with TLS disabled', async () => {
    fake = await startFakeDsh()
    await expect(startLanGuard(hostFor(fake), {
      dataDir: await tmpDataDir(),
      listenHost: '0.0.0.0',
      tls: { mode: 'off' },
    })).rejects.toThrow(/plain HTTP on the network/)
  })

  it('refuses to collide with the DSH web server port', async () => {
    fake = await startFakeDsh()
    await expect(startLanGuard(hostFor(fake, { webServerPort: 3080 }), {
      dataDir: await tmpDataDir(),
      listenHost: '127.0.0.1',
      listenPort: 3080,
    })).rejects.toThrow(/DSH's own web server port/)
  })

  it('starts with no config at all when the host names the active profile', async () => {
    // The out-of-box path: an install whose profile patch
    // carries no `dsh-lan-guard` entry at all must still come up, with its
    // private state under `<profile>/data/dsh-lan-guard`.
    fake = await startFakeDsh()
    const profileDir = await tmpDataDir()
    runtime = await startLanGuard(hostFor(fake, { profileDir }), {
      listenHost: '127.0.0.1',
      listenPort: 0,
      upstreamOrigin: fake.origin,
      tls: { mode: 'off' },
    })
    expect(runtime).toBeDefined()
    const derived = join(profileDir, 'data', 'dsh-lan-guard')
    expect(runtime?.auth.hasPassword).toBe(false)
    await expect(stat(derived)).resolves.toBeDefined()
  })

  it('refuses an invalid config', async () => {
    // No explicit dataDir AND no profile directory: the one case the plugin
    // must refuse rather than invent a shared location.
    fake = await startFakeDsh()
    await expect(startLanGuard(hostFor(fake), {})).rejects.toThrow(/dataDir/)
  })

  it('gates a visitor even though the listener is loopback', async () => {
    // A loopback listener can still be reached by a LAN client through any
    // other forwarder, so the gate must not depend on the bind address.
    fake = await startFakeDsh()
    runtime = await startLanGuard(hostFor(fake), {
      dataDir: await tmpDataDir(),
      listenHost: '127.0.0.1',
      listenPort: 0,
      upstreamOrigin: fake.origin,
      tls: { mode: 'off' },
      auth: { allowLoopback: false },
    })
    const started = runtime
    if (started === undefined) throw new Error('runtime missing')
    await seedPassword(started.auth)
    const response = await requestTo(started.proxy.port, { path: '/', headers: { accept: 'text/html' } })
    expect(response.status).toBe(401)
    expect(response.body.toString()).toContain('访问密码')
  })
})

describe('apply', () => {
  it('starts the listener, registers management routes and closes on dispose', async () => {
    fake = await startFakeDsh()
    const port = await freePort()
    const disposers: (() => unknown)[] = []
    const routes: string[] = []

    const ctx = {
      logger: () => silentLogger(),
      connection: {
        authenticatedUrl: fake.authenticatedUrl,
        requestRejection: () => undefined,
      },
      webServer: {
        port: 3080,
        register: (route: { path: string }) => {
          routes.push(route.path)
          return () => {}
        },
      },
      effect: (execute: () => () => unknown) => {
        disposers.push(execute())
      },
    } as unknown as Context

    await apply(ctx, {
      dataDir: await tmpDataDir(),
      listenHost: '127.0.0.1',
      listenPort: port,
      upstreamOrigin: fake.origin,
      tls: { mode: 'off' },
      auth: { allowLoopback: true },
    })

    const response = await requestTo(port, { path: '/' })
    expect(response.status).toBe(200)
    expect(routes).toEqual([
      '/plugins/dsh-lan-guard/config',
      '/plugins/dsh-lan-guard/auth-status',
      '/plugins/dsh-lan-guard/devices',
      '/plugins/dsh-lan-guard/workspaces',
      '/plugins/dsh-lan-guard/update',
      '/plugins/dsh-lan-guard/port-check',
    ])
    expect(disposers).toHaveLength(1)

    await disposers[0]?.()
    await expect(requestTo(port, { path: '/', headers: { connection: 'close' } })).rejects.toThrow()
  })

  it('passes the live relay counters through to the management snapshot', async () => {
    // The snapshot field is optional, so a missing passthrough degrades
    // SILENTLY: the health panel would simply never show a counter. This test
    // drives the real `apply` wiring and reads the JSON the page fetches
    // (regression: the first 0.4.0 build dropped `deps.relay` here).
    fake = await startFakeDsh()
    const port = await freePort()
    const handlers = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
    const ctx = {
      logger: () => silentLogger(),
      connection: { authenticatedUrl: fake.authenticatedUrl, requestRejection: () => undefined },
      webServer: {
        port: 3080,
        register: (route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) => {
          handlers.set(route.path, route.handler)
          return () => {}
        },
      },
      effect: () => {},
    } as unknown as Context

    await apply(ctx, {
      dataDir: await tmpDataDir(),
      listenHost: '127.0.0.1',
      listenPort: port,
      upstreamOrigin: fake.origin,
      tls: { mode: 'off' },
      auth: { allowLoopback: true },
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
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    try {
      const response = await requestTo((server.address() as AddressInfo).port, {
        path: '/plugins/dsh-lan-guard/config',
      })
      const body = JSON.parse(response.body.toString()) as {
        preferences: Record<string, unknown>
        connection?: { heartbeatAnswered: number; wsUpgrades: number; recent: unknown[] }
      }
      expect(body.preferences.answerHeartbeat).toBe(true)
      expect(body.preferences.socketWatchdog).toBe(true)
      expect(body.preferences.mobileCompat).toBe(true)
      expect(body.connection).toBeDefined()
      expect(body.connection?.heartbeatAnswered).toBe(0)
      expect(body.connection?.wsUpgrades).toBe(0)
      expect(body.connection?.recent).toEqual([])
    } finally {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => { server.close(() => resolve()) })
    }
  })

  it('derives dataDir from profileContext so a zero-config install works', async () => {    // The reported failure: an install whose profile patch has no entry for
    // this plugin at all. `profileContext` is the only thing DSH supplies, and
    // the management routes must still come up.
    fake = await startFakeDsh()
    const port = await freePort()
    const routes: string[] = []
    const profileDir = await tmpDataDir()
    const ctx = {
      logger: () => silentLogger(),
      connection: { authenticatedUrl: fake.authenticatedUrl, requestRejection: () => undefined },
      get: (name: string) => (name === 'profileContext' ? { dir: profileDir, name: 'web' } : undefined),
      webServer: {
        port: 3080,
        register: (route: { path: string }) => {
          routes.push(route.path)
          return () => {}
        },
      },
      effect: () => {},
    } as unknown as Context

    await apply(ctx, {
      listenHost: '127.0.0.1',
      listenPort: port,
      upstreamOrigin: fake.origin,
      tls: { mode: 'off' },
    })

    expect(routes).toContain('/plugins/dsh-lan-guard/config')
    await expect(stat(join(profileDir, 'data', 'dsh-lan-guard'))).resolves.toBeDefined()
  })

  it('installs the index tap that unlocks the official settings page', async () => {
    // The real wiring: DSH's `webServer.tapIndex` is what puts the `ownsHost`
    // flag into the served index, which is the only thing that can lift the
    // upstream "settings are unavailable in this browser" state for a LAN page.
    fake = await startFakeDsh()
    const port = await freePort()
    const disposers: (() => unknown)[] = []
    const transforms: ((html: string) => string)[] = []
    let tapDisposed = 0
    const ctx = {
      logger: () => silentLogger(),
      connection: { authenticatedUrl: fake.authenticatedUrl, requestRejection: () => undefined },
      webServer: {
        port: 3080,
        register: () => () => {},
        tapIndex: (transform: (html: string) => string) => {
          transforms.push(transform)
          return () => { tapDisposed += 1 }
        },
      },
      effect: (execute: () => () => unknown) => {
        disposers.push(execute())
      },
    } as unknown as Context

    await apply(ctx, {
      dataDir: await tmpDataDir(),
      listenHost: '127.0.0.1',
      listenPort: port,
      upstreamOrigin: fake.origin,
      tls: { mode: 'off' },
      auth: { allowLoopback: true },
    })

    const index = '<html><head></head><body>app</body></html>'
    expect(transforms).toHaveLength(1)
    const transformed = transforms[0]?.(index)
    expect(transformed).toContain('__DSH_TRANSPORT__')
    expect(transformed).toContain('ownsHost:true')

    await disposers[0]?.()
    expect(tapDisposed).toBe(1)
  })

  it('leaves the index untouched only when every index patch is switched off', async () => {
    fake = await startFakeDsh()
    const port = await freePort()
    const transforms: ((html: string) => string)[] = []
    const ctx = {
      logger: () => silentLogger(),
      connection: { authenticatedUrl: fake.authenticatedUrl, requestRejection: () => undefined },
      webServer: {
        port: 3080,
        register: () => () => {},
        tapIndex: (transform: (html: string) => string) => {
          transforms.push(transform)
          return () => {}
        },
      },
      effect: () => {},
    } as unknown as Context

    await apply(ctx, {
      dataDir: await tmpDataDir(),
      listenHost: '127.0.0.1',
      listenPort: port,
      upstreamOrigin: fake.origin,
      tls: { mode: 'off' },
      settingsUnlock: false,
      // The two mobile patches default ON; the identity assertion below is
      // about the tap being a no-op when NOTHING is requested.
      mobileCompat: false,
      socketWatchdog: false,
      mobileScrollFix: false,
      auth: { allowLoopback: true },
    })

    const index = '<html><head></head><body>app</body></html>'
    expect(transforms[0]?.(index)).toBe(index)
  })

  it('keeps the unlock off while still shipping the mobile patches', async () => {
    fake = await startFakeDsh()
    const port = await freePort()
    const transforms: ((html: string) => string)[] = []
    const ctx = {
      logger: () => silentLogger(),
      connection: { authenticatedUrl: fake.authenticatedUrl, requestRejection: () => undefined },
      webServer: {
        port: 3080,
        register: () => () => {},
        tapIndex: (transform: (html: string) => string) => {
          transforms.push(transform)
          return () => {}
        },
      },
      effect: () => {},
    } as unknown as Context

    await apply(ctx, {
      dataDir: await tmpDataDir(),
      listenHost: '127.0.0.1',
      listenPort: port,
      upstreamOrigin: fake.origin,
      tls: { mode: 'off' },
      settingsUnlock: false,
      auth: { allowLoopback: true },
    })

    const transformed = transforms[0]?.('<html><head></head><body>app</body></html>')
    expect(transformed).not.toContain('dsh-lan-guard:settings-unlock')
    expect(transformed).toContain('dsh-lan-guard:mobile-compat')
    expect(transformed).toContain('dsh-lan-guard:socket-watchdog')
  })

  it('does not take the plugin down when the settings service is unavailable', async () => {
    fake = await startFakeDsh()
    const port = await freePort()
    const ctx = {
      logger: () => silentLogger(),
      connection: { authenticatedUrl: fake.authenticatedUrl, requestRejection: () => undefined },
      // `settings` is intentionally absent: accessing it throws in Cordis.
      get webServer() {
        return { port: 3080, register: () => () => {} } as unknown as WebServerLike
      },
      effect: () => {},
    } as unknown as Context

    await apply(ctx, {
      dataDir: await tmpDataDir(),
      listenHost: '127.0.0.1',
      listenPort: port,
      upstreamOrigin: fake.origin,
      tls: { mode: 'off' },
      auth: { allowLoopback: true },
    })
    const response = await requestTo(port, { path: '/' })
    expect(response.status).toBe(200)
  })
})
