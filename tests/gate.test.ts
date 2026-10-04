/**
 * Gate integration tests.
 *
 * These run the REAL proxy with the REAL gate in front of a fake upstream, and
 * drive it over HTTP and a raw WebSocket upgrade — the same paths a phone uses.
 * `allowLoopback: false` is deliberate: the suite connects from loopback, so
 * the gate must be exercised rather than bypassed.
 */
import { randomBytes } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startLanGuard, type LanGuardRuntime } from '../src/index.ts'
import { GATE_PREFIX, SERVICE_WORKER_PATH } from '../src/auth/gate.ts'
import { renderPairingPage } from '../src/auth/login-page.ts'
import { PWA_ICON_192_PATH, PWA_ICON_512_PATH, PWA_MANIFEST_PATH } from '../src/auth/gate.ts'
import type { LanGuardLogger } from '../src/log.ts'
import { startFakeDsh, type FakeDsh } from './helpers/fake-dsh.ts'
import { requestTo, type RawResponse } from './helpers/http-client.ts'
import { tmpDataDir } from './helpers/tmp.ts'

const PASSWORD = 'correct horse battery staple'

let fake: FakeDsh | undefined
let runtime: LanGuardRuntime | undefined

afterEach(async () => {
  await runtime?.close()
  await fake?.close()
  runtime = undefined
  fake = undefined
})

/** A logger that records nothing. */
function silentLogger(): LanGuardLogger {
  return { info() {}, warn() {}, debug() {} }
}

/**
 * Bring up a gated proxy over a fake upstream.
 *
 * @param config - plugin config overrides.
 * @param password - the access password to install, or '' for none.
 * @param settingsReader - a stand-in for DSH's settings service. Only the locale
 *   resolution reads it; the language specs below use it to prove the gate's own
 *   pages follow the preference the official settings page writes.
 */
async function harness(
  config: Record<string, unknown> = {},
  password = PASSWORD,
  settingsReader?: { describe(): readonly { ns: string; value?: unknown }[] },
): Promise<{
  fake: FakeDsh
  runtime: LanGuardRuntime
  port: number
}> {
  const upstream = await startFakeDsh()
  const started = await startLanGuard({
    authenticatedUrl: upstream.authenticatedUrl,
    logger: silentLogger(),
    ...(settingsReader === undefined ? {} : { settingsReader }),
  }, {
    dataDir: await tmpDataDir(),
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamOrigin: upstream.origin,
    // These specs speak plain HTTP, so the listener must not serve TLS; the
    // TLS path has its own specs.
    tls: { mode: 'off' },
    ...config,
    // Pairing has its own specs; the rest of the suite focuses on the gate.
    auth: { allowLoopback: false, requirePairing: false, ...((config.auth as object | undefined) ?? {}) },
  })
  if (started === undefined) throw new Error('plugin did not start')
  if (password !== '') await started.auth.setPassword(password)
  fake = upstream
  runtime = started
  return { fake: upstream, runtime: started, port: started.proxy.port }
}

/** Extract one cookie pair from a response. */
function cookiePair(response: RawResponse, name: string): string {
  const raw = response.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
  for (const entry of list) {
    if (entry.startsWith(`${name}=`)) return entry.split(';')[0] ?? ''
  }
  throw new Error(`cookie ${name} not found`)
}

/** Log in and return the session cookie pair. */
async function login(port: number, password = PASSWORD, headers: Record<string, string> = {}): Promise<RawResponse> {
  return await requestTo(port, {
    method: 'POST',
    path: '/__dsh_lan_guard__/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: `password=${encodeURIComponent(password)}&next=%2F`,
  })
}

/** Perform a raw WebSocket handshake. */
function upgradeTo(port: number, headers: Record<string, string> = {}): Promise<{ statusLine: string; socket: Socket }> {
  const key = randomBytes(16).toString('base64')
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let buffer = ''
    let settled = false
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1')
      if (settled || !buffer.includes('\r\n\r\n')) return
      settled = true
      resolve({ statusLine: buffer.split('\r\n')[0] ?? '', socket })
    })
    socket.on('error', reject)
    socket.on('close', () => {
      if (!settled) {
        settled = true
        resolve({ statusLine: 'closed', socket })
      }
    })
    socket.on('connect', () => {
      const lines = [
        'GET /api/remote.mux HTTP/1.1',
        `host: 127.0.0.1:${String(port)}`,
        'upgrade: websocket',
        'connection: Upgrade',
        `sec-websocket-key: ${key}`,
        'sec-websocket-version: 13',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        '', '',
      ]
      socket.write(lines.join('\r\n'))
    })
  })
}

describe('unauthenticated access', () => {
  it('serves the login page for an HTML navigation', async () => {
    const { port } = await harness()
    const response = await requestTo(port, { path: '/', headers: { accept: 'text/html' } })
    expect(response.status).toBe(401)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body.toString()).toContain('访问密码')
    expect(response.body.toString()).not.toContain('fake dsh index')
  })

  it('answers /api/* with 401 JSON, never a login page', async () => {
    const { port } = await harness()
    const response = await requestTo(port, { path: '/api/remote.invoke', headers: { accept: '*/*' } })
    expect(response.status).toBe(401)
    expect(response.headers['content-type']).toContain('application/json')
    expect(JSON.parse(response.body.toString())).toEqual({ ok: false, error: 'unauthorized' })
  })

  it('refuses static assets with a JSON error too', async () => {
    const { port } = await harness()
    const response = await requestTo(port, { path: '/assets/index-abc.js' })
    expect(response.status).toBe(401)
  })

  it('never forwards an unauthenticated request upstream', async () => {
    const { fake: upstream, port } = await harness()
    await requestTo(port, { path: '/', headers: { accept: 'text/html' } })
    expect(upstream.observed.filter(entry => !entry.url.includes('token='))).toHaveLength(0)
  })

  it('404s its own unknown paths instead of forwarding them', async () => {
    const { fake: upstream, port } = await harness()
    const response = await requestTo(port, { path: '/__dsh_lan_guard__/whatever' })
    expect(response.status).toBe(404)
    expect(upstream.observed.filter(entry => !entry.url.includes('token='))).toHaveLength(0)
  })
})

describe('installability service worker', () => {
  it('is served publicly, from the gate path, scoped to the whole origin', async () => {
    const { port } = await harness()
    // No session, no cookie: the browser fetches the worker at registration
    // time, and the script itself carries no state and no credential.
    const response = await requestTo(port, { path: SERVICE_WORKER_PATH })
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('application/javascript')
    // Without this header the worker's scope would be its own directory, it
    // would never control the page, and Chromium would keep refusing to
    // install — which is the whole reason the route exists.
    expect(response.headers['service-worker-allowed']).toBe('/')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.body.toString()).toContain("addEventListener('fetch'")
    expect(response.headers['content-type']).not.toContain('text/html')
  })

  it('never intercepts a request', async () => {
    const { port } = await harness()
    const body = (await requestTo(port, { path: SERVICE_WORKER_PATH })).body.toString()
    // respondWith is what would put the worker between a visitor and an
    // authenticated, cookie-carrying, streaming app. It must never appear.
    expect(body).not.toContain('respondWith')
    expect(body).not.toContain('caches')
  })

  it('refuses a write, like every other gate asset', async () => {
    const { port } = await harness()
    const response = await requestTo(port, { method: 'POST', path: SERVICE_WORKER_PATH })
    expect(response.status).toBe(405)
    expect(JSON.parse(response.body.toString())).toEqual({ ok: false, error: 'method_not_allowed' })
  })

  it('answers the rest of the gate prefix with a JSON 404', async () => {
    const { port } = await harness()
    const response = await requestTo(port, { path: `${GATE_PREFIX}/nope` })
    expect(response.status).toBe(404)
    expect(JSON.parse(response.body.toString())).toEqual({ ok: false, error: 'not_found' })
  })
})


describe('gate page language', () => {
  it('follows the preference the official settings page stored', async () => {
    const { port } = await harness({}, PASSWORD, {
      describe: () => [{ ns: 'locale', value: { preference: 'en' } }],
    })
    const page = await requestTo(port, {
      path: '/',
      // The browser asks for Chinese; the STORED preference still wins, because
      // that is the setting the user actually chose.
      headers: { accept: 'text/html', 'accept-language': 'zh-CN,zh;q=0.9' },
    })
    expect(page.headers['content-type']).toContain('text/html')
    expect(page.body.toString()).toContain('Access password')
    expect(page.body.toString()).toContain('Enter DSH')
    expect(page.body.toString()).not.toContain('访问密码')
  })

  it('serves Chinese when that is the stored preference', async () => {
    const { port } = await harness({}, PASSWORD, {
      describe: () => [{ ns: 'locale', value: { preference: 'zh' } }],
    })
    const page = await requestTo(port, {
      path: '/',
      headers: { accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' },
    })
    expect(page.body.toString()).toContain('访问密码')
    expect(page.body.toString()).not.toContain('Access password')
  })

  it('declares the matching document language', async () => {
    const english = await harness({}, PASSWORD, {
      describe: () => [{ ns: 'locale', value: { preference: 'en' } }],
    })
    const englishPage = await requestTo(english.port, { path: '/', headers: { accept: 'text/html' } })
    expect(englishPage.body.toString()).toContain('<html lang="en">')

    await runtime?.close()
    runtime = undefined
    const chinese = await harness({}, PASSWORD, {
      describe: () => [{ ns: 'locale', value: { preference: 'zh' } }],
    })
    const chinesePage = await requestTo(chinese.port, { path: '/', headers: { accept: 'text/html' } })
    expect(chinesePage.body.toString()).toContain('<html lang="zh-CN">')
  })

  it('follows the browser only while no preference is stored', async () => {
    // DSH's own rule for a browser it has never seen: the first supported
    // language it asks for.
    const { port } = await harness({}, PASSWORD, { describe: () => [] })
    const english = await requestTo(port, {
      path: '/',
      headers: { accept: 'text/html', 'accept-language': 'en-GB,en;q=0.8' },
    })
    expect(english.body.toString()).toContain('Access password')

    const chinese = await requestTo(port, {
      path: '/',
      headers: { accept: 'text/html', 'accept-language': 'zh-Hans-CN,zh;q=0.9' },
    })
    expect(chinese.body.toString()).toContain('访问密码')
  })

  it('keeps rendering when the settings service cannot be read', async () => {
    // A refusal to read settings must never take the gate's pages down.
    const { port } = await harness({}, PASSWORD, {
      describe: () => {
        throw new Error('settings unavailable')
      },
    })
    const page = await requestTo(port, {
      path: '/',
      headers: { accept: 'text/html', 'accept-language': 'en' },
    })
    expect(page.status).toBe(401)
    expect(page.body.toString()).toContain('Access password')
  })

  it('translates the pairing hint on the login form', async () => {
    const { port } = await harness({ auth: { requirePairing: true } }, PASSWORD, {
      describe: () => [{ ns: 'locale', value: { preference: 'en' } }],
    })
    const page = await requestTo(port, { path: '/', headers: { accept: 'text/html' } })
    // The second gate has to be announced in the same language as the first —
    // a half-translated page is worse than an untranslated one.
    expect(page.body.toString()).toContain('First visit: naming the device follows')
  })

  it('translates the pairing page itself', () => {
    // Reached only after a successful login, so it is asserted on the renderer
    // the gate calls rather than through a second HTTP round trip.
    const html = renderPairingPage({ defaultLabel: 'My phone', ip: '192.168.1.9', locale: 'en' })
    expect(html).toContain('Confirm this device')
    expect(html).toContain('Confirm and enter DSH')
    expect(html).toContain('Source address: 192.168.1.9')
    expect(html).not.toContain('确认')
    expect(html).toContain('<html lang="en">')
  })
})


describe('installability assets', () => {
  // Chrome's documented install criteria: "icons - must include a 192px and a
  // 512px icon". DSH's own manifest declares a single SVG with `sizes: "any"`,
  // which is why an Android browser offered only "create a shortcut" and
  // reported "cannot install this app" (reported 2026-10-04). The gate serves a
  // manifest that mirrors DSH's and replaces the icon list.
  it('serves a manifest whose icons meet the documented criteria', async () => {
    const { port } = await harness()
    const response = await requestTo(port, { path: PWA_MANIFEST_PATH })
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('application/manifest+json')
    const manifest = JSON.parse(response.body.toString()) as {
      name: string
      short_name: string
      start_url: string
      scope: string
      display: string
      icons: { src: string; sizes: string; type: string }[]
    }
    // Everything DSH already satisfied is mirrored, so the installed app is
    // still "DSH" rather than a renamed copy of it.
    expect(manifest.name).toBe('DeepSeek Harness')
    expect(manifest.short_name).toBe('DSH')
    // ABSOLUTE on purpose: this manifest lives at a deep gate path, and a
    // relative start_url resolves against the manifest's own URL — `"./"` sent
    // the installed app to `/__dsh_lan_guard__/`, the gate's 404.
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
    expect(manifest.display).toBe('fullscreen')
    const sizes = manifest.icons.map(icon => icon.sizes)
    expect(sizes).toContain('192x192')
    expect(sizes).toContain('512x512')
    expect(manifest.icons.filter(icon => icon.type === 'image/png')).toHaveLength(2)
  })

  it('serves both icons as real PNGs of the size the manifest claims', async () => {
    const { port } = await harness()
    for (const [path, size] of [[PWA_ICON_192_PATH, 192], [PWA_ICON_512_PATH, 512]] as const) {
      const icon = await requestTo(port, { path })
      expect(icon.status, path).toBe(200)
      expect(icon.headers['content-type']).toBe('image/png')
      // PNG signature, then the IHDR dimensions at a fixed offset: proof these
      // are the declared size and not a placeholder the check would reject.
      expect(icon.body.subarray(0, 8))
        .toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      expect(icon.body.readUInt32BE(16)).toBe(size)
      expect(icon.body.readUInt32BE(20)).toBe(size)
    }
  })

  it('serves them without a session, so the install check never sees a 401', async () => {
    // The browser fetches these before any sign-in; a gate refusal reads as an
    // unexplained "cannot install this app".
    const { port } = await harness()
    for (const path of [PWA_MANIFEST_PATH, PWA_ICON_192_PATH, PWA_ICON_512_PATH]) {
      const response = await requestTo(port, { path })
      expect(response.status, path).toBe(200)
    }
  })

  it('forwards DSH\'s own manifest and favicon without a session', async () => {
    // The browser fetches these with credentials omitted. Gating them made the
    // manifest fetch fail with 401, so the install check saw no manifest at all
    // — which is why DSH's own unproxied origin could install and this could
    // not (reported 2026-10-04).
    const { port } = await harness()
    for (const path of ['/manifest.webmanifest', '/favicon.svg']) {
      const response = await requestTo(port, { path })
      expect(response.status, path).toBe(200)
    }
  })

  it('refuses a write method on them', async () => {
    const { port } = await harness()
    const response = await requestTo(port, { path: PWA_MANIFEST_PATH, method: 'POST' })
    expect(response.status).toBe(405)
  })
})

describe('password login', () => {
  it('rejects a wrong password and shows the error state', async () => {
    const { port } = await harness()
    const response = await login(port, 'wrong')
    expect(response.status).toBe(401)
    expect(response.body.toString()).toContain('密码错误')
  })

  it('accepts the right password, sets a session cookie and then forwards', async () => {
    const { port } = await harness()
    const response = await login(port)
    expect(response.status).toBe(302)
    expect(response.headers.location).toBe('/')
    const session = cookiePair(response, 'dsh_lan_guard_session')

    const page = await requestTo(port, { path: '/', headers: { accept: 'text/html', cookie: session } })
    expect(page.status).toBe(200)
    expect(page.body.toString()).toContain('fake dsh index')
  })

  it('never echoes the password back in the page', async () => {
    const { port } = await harness()
    const response = await login(port, 'wrong-but-secret')
    expect(response.body.toString()).not.toContain('wrong-but-secret')
  })

  it('locks the IP after the configured failures and says so', async () => {
    const { port } = await harness({ auth: { maxFailedAttempts: 2, lockoutMs: 60_000 } })
    await login(port, 'wrong')
    const locked = await login(port, 'wrong')
    expect(locked.status).toBe(429)
    expect(locked.body.toString()).toContain('尝试次数过多')

    // Even the correct password is refused while the lockout holds.
    const blocked = await login(port)
    expect(blocked.status).toBe(429)
  })

  it('refuses the login form when the CSRF check fails', async () => {
    const { port } = await harness()
    const response = await login(port, PASSWORD, { 'sec-fetch-site': 'cross-site' })
    expect(response.status).toBe(403)
    expect(response.body.toString()).toContain('请求来源校验未通过')
  })

  it('accepts an opaque Origin (in-app browsers post `Origin: null`)', async () => {
    // This is the real phone failure: the form post was answered with the CSRF
    // page instead of "wrong password" (user report 2026-09-24).
    const { port } = await harness()
    const response = await login(port, 'definitely-wrong', { origin: 'null', 'sec-fetch-site': 'same-origin' })
    expect(response.status).toBe(401)
    expect(response.body.toString()).toContain('密码错误')
    expect(response.body.toString()).not.toContain('请求来源校验未通过')
  })

  it('still refuses an explicit cross-site post', async () => {
    const { port } = await harness()
    const response = await login(port, PASSWORD, { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' })
    expect(response.status).toBe(403)
    expect(response.body.toString()).toContain('请求来源校验未通过')
  })

  it('never lets anyone in while no password is configured', async () => {
    const { port } = await harness({}, '')
    const page = await requestTo(port, { path: '/', headers: { accept: 'text/html' } })
    expect(page.status).toBe(403)
    expect(page.body.toString()).toContain('尚未设置访问密码')

    // A guessed password must not create a session.
    const attempt = await login(port, 'anything')
    expect(attempt.status).toBe(403)
    const after = await requestTo(port, { path: '/', headers: { accept: 'text/html' } })
    expect(after.status).toBe(403)
  })
})

describe('passwordless link', () => {
  it('exchanges ?auth= for a session and redirects to the clean URL', async () => {
    const { runtime: started, port } = await harness()
    const token = await started.auth.ensureSecretToken()
    const response = await requestTo(port, { path: `/?auth=${token}`, headers: { accept: 'text/html' } })
    expect(response.status).toBe(302)
    expect(response.headers.location).toBe('/')
    const session = cookiePair(response, 'dsh_lan_guard_session')

    const page = await requestTo(port, { path: '/', headers: { accept: 'text/html', cookie: session } })
    expect(page.status).toBe(200)
  })

  it('strips the token from the redirect target', async () => {
    const { runtime: started, port } = await harness()
    const token = await started.auth.ensureSecretToken()
    const response = await requestTo(port, { path: `/settings?auth=${token}&tab=1`, headers: { accept: 'text/html' } })
    expect(response.status).toBe(302)
    expect(response.headers.location).toBe('/settings?tab=1')
  })

  it('refuses an unknown token', async () => {
    const { port } = await harness()
    const response = await requestTo(port, { path: '/?auth=dsh_deadbeef', headers: { accept: 'text/html' } })
    expect(response.status).toBe(401)
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it('ignores the link in password-only mode', async () => {
    const { runtime: started, port } = await harness({ auth: { mode: 'password' } })
    const token = await started.auth.ensureSecretToken()
    const response = await requestTo(port, { path: `/?auth=${token}`, headers: { accept: 'text/html' } })
    expect(response.status).toBe(401)
  })

  it('refuses password login in token-only mode', async () => {
    const { port } = await harness({ auth: { mode: 'token' } })
    const response = await login(port)
    expect(response.status).toBe(403)
    expect(response.body.toString()).toContain('仅安全 Token')
  })

  it('accepts a paired device link and rejects it once revoked', async () => {
    const { runtime: started, port } = await harness()
    const { device, token } = await started.devices.add('我的 iPhone')

    const response = await requestTo(port, { path: `/?auth=${token}`, headers: { accept: 'text/html' } })
    expect(response.status).toBe(302)
    const session = cookiePair(response, 'dsh_lan_guard_session')
    expect((await requestTo(port, { path: '/', headers: { accept: 'text/html', cookie: session } })).status).toBe(200)

    await started.devices.revoke(device.id)
    const revoked = await requestTo(port, { path: `/?auth=${token}`, headers: { accept: 'text/html' } })
    expect(revoked.status).toBe(401)
    expect(revoked.headers['set-cookie']).toBeUndefined()
  })

  it('never forwards the auth parameter upstream', async () => {
    const { fake: upstream, runtime: started, port } = await harness()
    const token = await started.auth.ensureSecretToken()
    await requestTo(port, { path: `/?auth=${token}` })
    expect(upstream.observed.some(entry => entry.url.includes('auth='))).toBe(false)
  })
})

describe('device pairing (P4-g)', () => {
  it('asks an unnamed device to pair, then recognises it by its cookie', async () => {
    const { port } = await harness({ auth: { requirePairing: true } })
    const session = cookiePair(await login(port), 'dsh_lan_guard_session')

    // A valid session but no device identity -> the pairing page, not DSH.
    const page = await requestTo(port, { path: '/', headers: { accept: 'text/html', cookie: session } })
    expect(page.status).toBe(200)
    expect(page.body.toString()).toContain('确认这台设备')
    expect(page.body.toString()).not.toContain('fake dsh index')

    const paired = await requestTo(port, {
      method: 'POST',
      path: '/__dsh_lan_guard__/pair',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        host: `127.0.0.1:${String(port)}`,
        cookie: session,
      },
      body: 'label=%E6%88%91%E7%9A%84+iPhone',
    })
    expect(paired.status).toBe(302)
    const deviceCookie = cookiePair(paired, 'dsh_lan_guard_device')

    const allowed = await requestTo(port, {
      path: '/',
      headers: { accept: 'text/html', cookie: deviceCookie },
    })
    expect(allowed.status).toBe(200)
    expect(allowed.body.toString()).toContain('fake dsh index')
  })

  it('refuses a revoked device by its cookie', async () => {
    const { runtime: started, port } = await harness({ auth: { requirePairing: true } })
    const { device, token } = await started.devices.add('旧手机')
    const cookie = `dsh_lan_guard_device=${token}`

    expect((await requestTo(port, { path: '/', headers: { accept: 'text/html', cookie } })).status).toBe(200)

    await started.devices.revoke(device.id)
    const refused = await requestTo(port, { path: '/', headers: { accept: 'text/html', cookie } })
    expect(refused.status).toBe(403)
    expect(refused.body.toString()).toContain('已被移除访问权限')
  })

  it('answers API calls with 428 while pairing is pending', async () => {
    const { port } = await harness({ auth: { requirePairing: true } })
    const session = cookiePair(await login(port), 'dsh_lan_guard_session')
    const response = await requestTo(port, { path: '/api/x', headers: { accept: '*/*', cookie: session } })
    expect(response.status).toBe(428)
    expect(JSON.parse(response.body.toString()).error).toBe('pairing_required')
  })
})

describe('websocket gate', () => {
  it('refuses an unauthenticated upgrade', async () => {
    const { port } = await harness()
    const result = await upgradeTo(port)
    expect(result.statusLine).toContain('401')
    result.socket.destroy()
  })

  it('allows an upgrade that carries a session cookie', async () => {
    const { port } = await harness()
    const response = await login(port)
    const session = cookiePair(response, 'dsh_lan_guard_session')
    const result = await upgradeTo(port, { cookie: session })
    expect(result.statusLine).toBe('HTTP/1.1 101 Switching Protocols')
    result.socket.destroy()
  })

  it('survives sockets dropped during authentication', async () => {
    const { port } = await harness()
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error)
    }
    process.on('uncaughtException', onUnhandled)
    try {
      for (let index = 0; index < 8; index += 1) {
        const socket = connect(port, '127.0.0.1')
        await new Promise<void>(resolve => socket.on('connect', () => resolve()))
        socket.write(
          'GET /api/remote.mux HTTP/1.1\r\nhost: 127.0.0.1\r\nupgrade: websocket\r\n'
          + 'connection: Upgrade\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\n\r\n',
        )
        socket.destroy()
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    } finally {
      process.off('uncaughtException', onUnhandled)
    }
    expect(unhandled).toEqual([])
  })
})

describe('loopback exemption', () => {
  it('lets a loopback visitor through when allowLoopback is set', async () => {
    const upstream = await startFakeDsh()
    const started = await startLanGuard({
      authenticatedUrl: upstream.authenticatedUrl,
      logger: silentLogger(),
    }, {
      dataDir: await tmpDataDir(),
      listenHost: '127.0.0.1',
    listenPort: 0,
      upstreamOrigin: upstream.origin,
      tls: { mode: 'off' },
      auth: { allowLoopback: true },
    })
    if (started === undefined) throw new Error('plugin did not start')
    fake = upstream
    runtime = started
    const response = await requestTo(started.proxy.port, { path: '/', headers: { accept: 'text/html' } })
    expect(response.status).toBe(200)
  })
})

describe('F9 device approval and permanent ban', () => {
  it('shows the waiting page to a pending device, then lets it in once approved', async () => {
    const { runtime: started, port } = await harness({ auth: { requirePairing: true, requireApproval: true } })
    const session = cookiePair(await login(port), 'dsh_lan_guard_session')
    const paired = await requestTo(port, {
      method: 'POST',
      path: '/__dsh_lan_guard__/pair',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        host: `127.0.0.1:${String(port)}`,
        cookie: session,
      },
      body: 'label=%E5%BE%85%E6%89%B9%E5%87%86%E6%89%8B%E6%9C%BA',
    })
    expect(paired.status).toBe(302)
    const cookie = cookiePair(paired, 'dsh_lan_guard_device')

    const waiting = await requestTo(port, { path: '/', headers: { accept: 'text/html', cookie } })
    expect(waiting.status).toBe(403)
    expect(waiting.body.toString()).toContain('等待管理员批准')
    // API calls get a machine-readable code instead of the page.
    const api = await requestTo(port, { path: '/api/x', headers: { accept: '*/*', cookie } })
    expect(JSON.parse(api.body.toString()).error).toBe('pending_approval')

    const id = started.devices.list()[0]?.id ?? ''
    expect(await started.devices.setStatus(id, 'approved')).toBe(true)
    const allowed = await requestTo(port, { path: '/', headers: { accept: 'text/html', cookie } })
    expect(allowed.status).toBe(200)
    expect(allowed.body.toString()).toContain('fake dsh index')
  })

  it('refuses a blocked device even though it still holds a valid cookie', async () => {
    const { runtime: started, port } = await harness({ auth: { requirePairing: true } })
    const { device, token } = await started.devices.add('旧手机')
    await started.devices.setStatus(device.id, 'blocked')
    const refused = await requestTo(port, {
      path: '/',
      headers: { accept: 'text/html', cookie: `dsh_lan_guard_device=${token}` },
    })
    expect(refused.status).toBe(403)
    expect(refused.body.toString()).toContain('已被移除访问权限')
  })
})

describe('blank page regression: ?auth= must not skip pairing', () => {
  it('shows the pairing page and keeps answering 428 for assets until the device pairs', async () => {
    const { port } = await harness({ auth: { mode: 'password', requirePairing: true } })
    const session = cookiePair(await login(port), 'dsh_lan_guard_session')

    // The visitor opened the shared link: the app HTML must NOT be delivered
    // before the device has named itself, otherwise the bundles below are
    // answered with 428 and the page renders blank.
    const page = await requestTo(port, {
      path: '/?auth=dsh_deadbeefdeadbeefdeadbeefdeadbeefdead',
      headers: { accept: 'text/html', cookie: session },
    })
    expect(page.status).toBe(200)
    expect(page.body.toString()).toContain('确认这台设备')
    expect(page.body.toString()).not.toContain('fake dsh index')

    const asset = await requestTo(port, {
      path: '/plugins?names=x',
      headers: { accept: '*/*', cookie: session },
    })
    expect(asset.status).toBe(428)
    expect(JSON.parse(asset.body.toString()).error).toBe('pairing_required')
  })
})

describe('first-visit guidance: the second gate is announced', () => {
  it('tells a visitor that naming follows the password', async () => {
    const { port } = await harness({ auth: { requirePairing: true } })
    const page = await requestTo(port, { path: '/', headers: { accept: 'text/html' } })
    expect(page.status).toBe(401)
    expect(page.body.toString()).toContain('首次访问')
    expect(page.body.toString()).toContain('需为设备命名')
  })

  it('announces it on the inert-link page too, where a login is still possible', async () => {
    const { port } = await harness({ auth: { mode: 'password', requirePairing: true } })
    const page = await requestTo(port, {
      path: '/?auth=dsh_deadbeefdeadbeefdeadbeefdeadbeefdead',
      headers: { accept: 'text/html' },
    })
    expect(page.status).toBe(401)
    expect(page.body.toString()).toContain('免密链接无效')
    expect(page.body.toString()).toContain('需为设备命名')
  })

  it('stays silent when pairing is switched off, so it never promises a name page', async () => {
    const { port } = await harness({ auth: { requirePairing: false } })
    const page = await requestTo(port, { path: '/', headers: { accept: 'text/html' } })
    expect(page.status).toBe(401)
    expect(page.body.toString()).toContain('访问密码')
    expect(page.body.toString()).not.toContain('需为设备命名')
  })

  it('stays silent where a login cannot proceed at all', async () => {
    // A gate with no password refuses everyone: naming is not the next step.
    const { port } = await harness({ auth: { requirePairing: true } }, '')
    const page = await requestTo(port, { path: '/', headers: { accept: 'text/html' } })
    expect(page.status).toBe(403)
    expect(page.body.toString()).toContain('尚未设置访问密码')
    expect(page.body.toString()).not.toContain('需为设备命名')
  })
})

describe('login form enablement', () => {
  /** One element's tag text, whitespace-normalised across template lines. */
  function tag(html: string, pattern: RegExp): string {
    return pattern.exec(html.replace(/\s+/g, ' '))?.[0] ?? ''
  }

  it('keeps the password form usable on the inert-link page', async () => {
    // A phone that scanned a rotated/truncated link lands here; the notice tells
    // it to type the password, so the form must actually accept one (2026-09-26).
    const { port } = await harness({ auth: { mode: 'password', requirePairing: true } })
    const page = await requestTo(port, {
      path: '/?auth=dsh_deadbeefdeadbeefdeadbeefdeadbeefdead',
      headers: { accept: 'text/html' },
    })
    expect(page.status).toBe(401)
    const html = page.body.toString()
    expect(html).toContain('免密链接无效')
    expect(tag(html, /<input id="password"[^>]*>/)).not.toContain('disabled')
    expect(tag(html, /<button type="submit"[^>]*>/)).not.toContain('disabled')

    // ...and the password really does work from there.
    const loggedIn = await login(port, PASSWORD, { host: `127.0.0.1:${String(port)}` })
    expect(loggedIn.status).toBe(302)
  })

  it('still disables the form where logging in cannot help', async () => {
    // No password configured: the gate refuses everyone, so an enabled form
    // would be a lie. This keeps `blocked` meaningful rather than deleted.
    const { port } = await harness({ auth: { requirePairing: true } }, '')
    const page = await requestTo(port, { path: '/', headers: { accept: 'text/html' } })
    expect(page.status).toBe(403)
    const html = page.body.toString()
    expect(html).toContain('尚未设置访问密码')
    expect(tag(html, /<input id="password"[^>]*>/)).toContain('disabled')
  })
})

describe('a device cookie that names no record must not strand a browser', () => {
  /** Pair a device, then delete its record — leaving a stale cookie behind. */
  async function staleCookieAfterDelete(
    started: LanGuardRuntime,
  ): Promise<{ cookie: string; deviceId: string }> {
    const { device, token } = await started.devices.add('旧手机')
    const cookie = `dsh_lan_guard_device=${token}`
    // Sanity: while the record exists the cookie is a working identity.
    const allowed = await requestTo(started.proxy.port, { path: '/', headers: { cookie } })
    expect(allowed.status).toBe(200)
    await started.devices.remove(device.id)
    return { cookie, deviceId: device.id }
  }

  it('recovers through a freshly issued passwordless link', async () => {
    const { runtime: started, port } = await harness({ auth: { requirePairing: true } })
    const { cookie } = await staleCookieAfterDelete(started)

    // Before the fix this was a permanent 403 "已被移除访问权限": the removal
    // page is produced BEFORE `?auth=` is read, so no link could ever help.
    const token = await started.auth.ensureSecretToken()
    const exchange = await requestTo(port, {
      path: `/?auth=${token}`,
      headers: { accept: 'text/html', cookie },
    })
    expect(exchange.status).toBe(302)
    const session = cookiePair(exchange, 'dsh_lan_guard_session')

    // Authenticated but unnamed -> the naming page, then a NEW identity.
    const page = await requestTo(port, {
      path: '/',
      headers: { accept: 'text/html', cookie: `${session}; ${cookie}` },
    })
    expect(page.status).toBe(200)
    expect(page.body.toString()).toContain('确认这台设备')

    const paired = await requestTo(port, {
      method: 'POST',
      path: '/__dsh_lan_guard__/pair',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        host: `127.0.0.1:${String(port)}`,
        cookie: `${session}; ${cookie}`,
      },
      body: 'label=%E6%96%B0%E6%89%8B%E6%9C%BA',
    })
    expect(paired.status).toBe(302)
    const fresh = cookiePair(paired, 'dsh_lan_guard_device')
    expect(fresh).not.toBe(cookie)
    const back = await requestTo(port, { path: '/', headers: { cookie: fresh } })
    expect(back.status).toBe(200)
    expect(back.body.toString()).toContain('fake dsh index')
    expect(started.devices.activeCount).toBe(1)
  })

  it('recovers through the password form', async () => {
    const { runtime: started, port } = await harness({ auth: { requirePairing: true } })
    const { cookie } = await staleCookieAfterDelete(started)

    // The stale cookie must not shadow the login page either.
    const page = await requestTo(port, { path: '/', headers: { accept: 'text/html', cookie } })
    expect(page.status).toBe(401)
    expect(page.body.toString()).toContain('访问密码')

    const response = await login(port, PASSWORD, { cookie })
    expect(response.status).toBe(302)
    const session = cookiePair(response, 'dsh_lan_guard_session')
    const naming = await requestTo(port, {
      path: '/',
      headers: { accept: 'text/html', cookie: `${session}; ${cookie}` },
    })
    expect(naming.body.toString()).toContain('确认这台设备')
  })

  it('does not refuse the websocket upgrade of a browser holding a stale cookie', async () => {
    const { runtime: started, port } = await harness({ auth: { requirePairing: true } })
    const { cookie } = await staleCookieAfterDelete(started)

    // No session at all: the verdict is 401 unauthorized, NOT 403 device_revoked
    // — proof the stale cookie was treated as absent rather than as a refusal.
    const result = await upgradeTo(port, { cookie })
    expect(result.statusLine).toContain('401')
    expect(result.statusLine).not.toContain('403')
    result.socket.destroy()
  })

  it('still refuses a REVOKED record, which the operator cut off on purpose', async () => {
    const { runtime: started, port } = await harness({ auth: { requirePairing: true } })
    const { device, token } = await started.devices.add('被吊销的手机')
    const cookie = `dsh_lan_guard_device=${token}`
    await started.devices.revoke(device.id)

    const refused = await requestTo(port, { path: '/', headers: { accept: 'text/html', cookie } })
    expect(refused.status).toBe(403)
    expect(refused.body.toString()).toContain('已被移除访问权限')
    // The notice must no longer send anyone down the deleted-record dead end.
    expect(refused.body.toString()).not.toContain('清除本浏览器的本站数据')

    // Revoking keeps the record, so the upgrade is refused too.
    const upgrade = await upgradeTo(port, { cookie })
    expect(upgrade.statusLine).toContain('403')
    upgrade.socket.destroy()
  })

  it('still refuses a BLOCKED record', async () => {
    const { runtime: started, port } = await harness({ auth: { requirePairing: true } })
    const { device, token } = await started.devices.add('被拉黑的手机')
    const cookie = `dsh_lan_guard_device=${token}`
    await started.devices.setStatus(device.id, 'blocked')

    const refused = await requestTo(port, { path: '/', headers: { accept: 'text/html', cookie } })
    expect(refused.status).toBe(403)
    expect(refused.body.toString()).toContain('已被移除访问权限')
  })
})
