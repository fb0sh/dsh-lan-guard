/**
 * Remote workspace picker — the management route.
 *
 * The route reads the host's directory tree, so the matrix that matters is the
 * AUTHORITY matrix (operator / remote read-only / locked / unlocked) plus the
 * fence and the runaway guard. It runs on a real loopback server so the visitor
 * marker and the admin cookie behave exactly as they do in production.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuthManager } from '../src/auth/manager.ts'
import { staticSwitches, type LanGuardConfigShape } from '../src/config.ts'
import { noopLogger } from '../src/log.ts'
import { registerManagementRoutes } from '../src/settings/routes.ts'
import { DeviceRegistry } from '../src/store/devices.ts'
import { SecretsStore } from '../src/store/secrets.ts'
import { requestTo, type RawResponse } from './helpers/http-client.ts'
import { tmpDataDir } from './helpers/tmp.ts'

const PASSWORD = 'correct horse battery staple'
const ADMIN = 'admin password 42'
const BROWSE_PATH = '/plugins/dsh-lan-guard/workspaces'
const REMOTE = { 'x-dsh-lan-guard-visitor': '1' }

let closer: (() => Promise<void>) | undefined
let scratch: string

beforeEach(async () => {
  const root = join(process.cwd(), '.tmp', 'test-data')
  await mkdir(root, { recursive: true })
  scratch = await mkdtemp(join(root, 'wsroute-'))
})

afterEach(async () => {
  await closer?.()
  closer = undefined
  await rm(scratch, { recursive: true, force: true })
})

function configWith(
  adminPolicy: LanGuardConfigShape['auth']['adminPolicy'],
  adminProtection = true,
): LanGuardConfigShape {
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
    pwaInstall: true,
    auth: {
      enabled: true,
      mode: 'token_and_password',
      adminPolicy,
      adminProtection,
      allowLoopback: true,
      sessionMaxAgeMs: 2_592_000_000,
      adminSessionMaxAgeMs: 1_800_000,
      maxFailedAttempts: 5,
      lockoutMs: 60_000,
      requirePairing: false,
      requireApproval: false,
    },
    tls: { mode: 'off', caCertFile: null, caKeyFile: null, certFile: null, keyFile: null, allowInsecureLan: false },
    mdns: { enabled: false },
  }
}

interface Harness {
  port: number
  fence: { rejection: number | undefined }
}

/** Start the management routes on a real loopback server. */
async function harness(
  adminPolicy: LanGuardConfigShape['auth']['adminPolicy'] = 'local_only',
  adminProtection = true,
): Promise<Harness> {
  const config = configWith(adminPolicy, adminProtection)
  const store = new SecretsStore(await tmpDataDir())
  const devices = new DeviceRegistry({ store, logger: noopLogger })
  await devices.init()
  const auth = new AuthManager({ store, auth: config.auth, switches: staticSwitches(config), logger: noopLogger })
  await auth.init()
  await auth.setPassword(PASSWORD)
  await auth.setAdminPassword(ADMIN)

  const fence = { rejection: undefined as number | undefined }
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
    settings: { describe: () => [{ ns: 'dsh-lan-guard', revision: 1 }], update: async () => {} },
    listener: { port: () => config.listenPort, portFallback: () => false },
    updates: { check: async () => ({ current: '0.1.1', latest: '0.1.1', hasUpdate: false, checkedAtMs: 1, error: null }) },
    devices,
    access: async () => ({
      port: config.listenPort,
      portFallbackFrom: null,
      secure: false,
      tlsMode: 'off',
      caFingerprint: null,
      loopbackOnly: true,
      addresses: [],
      selectedUrl: 'http://127.0.0.1:3445/',
      qrSvg: null,
      unavailableReason: 'loopback-only',
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
  return { port: address.port, fence }
}

/** GET one browse request. */
async function browse(port: number, path?: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  const query = path === undefined ? '' : `?path=${encodeURIComponent(path)}`
  return await requestTo(port, {
    method: 'GET',
    path: `${BROWSE_PATH}${query}`,
    headers: { host: `127.0.0.1:${String(port)}`, ...headers },
  })
}

/** Unlock the console and return the admin cookie pair. */
async function unlock(port: number): Promise<string> {
  const response = await requestTo(port, {
    method: 'POST',
    path: '/plugins/dsh-lan-guard/config',
    headers: { 'content-type': 'application/json', host: `127.0.0.1:${String(port)}`, ...REMOTE },
    body: JSON.stringify({ adminUnlock: ADMIN }),
  })
  const raw = response.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
  const cookie = list.find(entry => entry.startsWith('dsh_lan_guard_admin='))
  expect(cookie).toBeDefined()
  return cookie?.split(';')[0] ?? ''
}

describe('GET /plugins/dsh-lan-guard/workspaces', () => {
  it('lists one level for the machine’s own operator', async () => {
    await mkdir(join(scratch, 'project-a'))
    const { port } = await harness()
    const response = await browse(port, scratch)
    expect(response.status).toBe(200)
    const body = JSON.parse(response.body.toString('utf8')) as { ok: boolean; entries: { name: string }[] }
    expect(body.ok).toBe(true)
    expect(body.entries.map(entry => entry.name)).toEqual(['project-a'])
  })

  it('refuses a remote device under the default local_only policy', async () => {
    const { port } = await harness('local_only')
    const response = await browse(port, scratch, REMOTE)
    expect(response.status).toBe(403)
    expect(JSON.parse(response.body.toString('utf8'))).toMatchObject({ error: 'read_only_remote' })
  })

  it('asks a remote device to unlock under password_unlock, then allows it', async () => {
    const { port } = await harness('password_unlock')
    const locked = await browse(port, scratch, REMOTE)
    expect(locked.status).toBe(403)
    expect(JSON.parse(locked.body.toString('utf8'))).toMatchObject({ error: 'admin_required' })

    const cookie = await unlock(port)
    const allowed = await browse(port, scratch, { ...REMOTE, cookie })
    expect(allowed.status).toBe(200)
  })

  it('never asks the local operator to unlock, even under password_unlock', async () => {
    const { port } = await harness('password_unlock')
    expect((await browse(port, scratch)).status).toBe(200)
  })

  it('honours adminProtection=false exactly like every other management write', async () => {
    // The operator turned the unlock requirement off: a remote session that
    // passed the gate may manage, so directory browsing must agree with the
    // settings endpoint instead of refusing on its own rule.
    const { port } = await harness('password_unlock', false)
    const response = await browse(port, scratch, REMOTE)
    expect(response.status).toBe(200)
  })

  it('never lets adminProtection=false widen local_only', async () => {
    // `local_only` is the one policy that means "the machine's operator only";
    // the protection switch must not become a back door around it.
    const { port } = await harness('local_only', false)
    const response = await browse(port, scratch, REMOTE)
    expect(response.status).toBe(403)
    expect(JSON.parse(response.body.toString('utf8'))).toMatchObject({ error: 'read_only_remote' })
  })

  it('honours DSH’s native fence before anything else', async () => {
    const { port, fence } = await harness()
    fence.rejection = 403
    const response = await browse(port, scratch)
    expect(response.status).toBe(403)
    expect(JSON.parse(response.body.toString('utf8'))).toMatchObject({ error: 'forbidden' })
  })

  it('refuses a blocked and a relative path with the right status', async () => {
    const { port } = await harness()
    const blocked = await browse(port, '/etc')
    expect(blocked.status).toBe(403)
    expect(JSON.parse(blocked.body.toString('utf8'))).toMatchObject({ ok: false, error: 'blocked' })

    const relative = await browse(port, 'project')
    expect(relative.status).toBe(400)
    expect(JSON.parse(relative.body.toString('utf8'))).toMatchObject({ ok: false, error: 'not_absolute' })

    const missing = await browse(port, join(scratch, 'nope'))
    expect(missing.status).toBe(404)
  })

  it('stops a runaway loop instead of walking the filesystem forever', async () => {
    const { port } = await harness()
    let last = 0
    for (let index = 0; index < 245; index += 1) {
      const response = await browse(port, scratch)
      last = response.status
      if (last === 429) break
    }
    expect(last).toBe(429)
  })
})
