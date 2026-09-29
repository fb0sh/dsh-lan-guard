/**
 * Index-patch tests.
 *
 * The injected markup IS the mechanism: DSH's client connection plugin reads
 * `globalThis.__DSH_TRANSPORT__` when it applies (`ownsHost: true` makes the
 * page look like the host's own surface), the mobile shims cover APIs whose
 * absence makes DSH's stream path throw on older engines, and the watchdog is
 * the only thing that can recover a page whose WebSocket never opens after a
 * background resume. The injected scripts are therefore EXECUTED here against a
 * fake environment, because the failures they prevent are otherwise silent.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  MOBILE_COMPAT_MARKER,
  MOBILE_META_MARKER,
  MOBILE_SCROLL_MARKER,
  SOCKET_WATCHDOG_MARKER,
  TRANSPORT_GLOBAL,
  UNLOCK_MARKER,
  injectMobileCompat,
  injectMobileScrollFix,
  injectSettingsUnlock,
  injectSocketWatchdog,
  mobileCompatScript,
  mobileMetaMarkup,
  mobileScrollFixScript,
  registerIndexPatches,
  settingsUnlockScript,
  socketWatchdogScript,
} from '../src/settings/index-tap.ts'
import type { LanGuardLogger } from '../src/log.ts'

/** A logger that records what it was told. */
function recordingLogger(): { logger: LanGuardLogger; warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    logger: {
      info() {},
      debug() {},
      warn(message: string) { warnings.push(message) },
    },
  }
}

/** The executable body of one injected `<script>`. */
function scriptBody(script: string): string {
  expect(script.startsWith('<script>')).toBe(true)
  expect(script.endsWith('</script>')).toBe(true)
  return script.slice('<script>'.length, -'</script>'.length)
}

/** One fake WebSocket instance. */
class FakeSocket {
  readyState = 0
  readonly listeners = new Map<string, ((event: unknown) => void)[]>()
  closeCalls = 0

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  close(): void {
    this.closeCalls += 1
    this.readyState = 3
    this.emit('close')
  }
}

/** A fake environment the watchdog can be installed into. */
function watchdogEnv(options: { visibility?: 'visible' | 'hidden' } = {}): {
  self: Record<string, unknown>
  sockets: FakeSocket[]
  reloads: () => number
  visible: () => void
  hidden: () => void
  storage: Map<string, string>
} {
  const sockets: FakeSocket[] = []
  const listeners = new Map<string, ((event: unknown) => void)[]>()
  let state = options.visibility ?? 'visible'
  let reloadCount = 0
  const storage = new Map<string, string>()
  const self: Record<string, unknown> = {
    WebSocket: class {
      constructor(url: string) {
        const socket = new FakeSocket(url)
        sockets.push(socket)
        return socket as unknown as object
      }
    },
    location: { reload: () => { reloadCount += 1 } },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
    },
    document: {
      get visibilityState() { return state },
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        const list = listeners.get(type) ?? []
        list.push(listener)
        listeners.set(type, list)
      },
    },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    },
  }
  return {
    self,
    sockets,
    storage,
    reloads: () => reloadCount,
    visible: () => {
      state = 'visible'
      for (const listener of listeners.get('visibilitychange') ?? []) listener({})
    },
    hidden: () => {
      state = 'hidden'
      for (const listener of listeners.get('visibilitychange') ?? []) listener({})
    },
  }
}

/** Install the watchdog script into a fake environment. */
function installWatchdog(env: ReturnType<typeof watchdogEnv>): Record<string, unknown> {
  const patches: Record<string, unknown> = {}
  const body = scriptBody(socketWatchdogScript())
  const factory = new Function('self', 'globalThis', 'document', 'console', body)
  factory(env.self, patches, env.self.document, console)
  return patches
}

describe('settingsUnlockScript', () => {
  it('is one inline script that sets ownsHost through a merge', () => {
    const script = settingsUnlockScript()
    expect(script).toContain(UNLOCK_MARKER)
    expect(script).toContain(`globalThis.${TRANSPORT_GLOBAL}`)
    expect(script).toContain('ownsHost:true')
    // Merge, never replace: a future DSH release may put its own transport
    // facts there, and clobbering them would break the real carrier.
    expect(script).toContain('Object.assign({}')
    // A primitive sitting on the global must not throw or spread into chars.
    expect(script).toContain('typeof t==="object"')
    // Nothing that would close the element early.
    expect(scriptBody(script)).not.toContain('</script>')
  })
})

describe('injectSettingsUnlock', () => {
  const INDEX = '<!doctype html><html><head><base href="./"></head><body>app</body></html>'

  it('inserts the script immediately after the opening head tag', () => {
    const out = injectSettingsUnlock(INDEX)
    const headEnd = out.indexOf('>', out.indexOf('<head')) + 1
    expect(out.slice(headEnd, headEnd + 8)).toBe('<script>')
    expect(out).toContain('<base href="./">')
    expect(out).toContain('<body>app</body>')
  })

  it('is idempotent and degrades to a prepend when there is no head', () => {
    const once = injectSettingsUnlock(INDEX)
    expect(injectSettingsUnlock(once)).toBe(once)
    const headless = injectSettingsUnlock('<body>only</body>')
    expect(headless.startsWith('<script>')).toBe(true)
    expect(headless.endsWith('<body>only</body>')).toBe(true)
  })
})

describe('mobileCompatScript', () => {
  /** Build a fake environment for the shim installer (no modern statics). */
  function compatEnv(): {
    self: Record<string, unknown>
    promise: Record<string, unknown>
    patches: Record<string, unknown>
  } {
    class FakeSignal {
      aborted = false
      reason: unknown = undefined
      readonly listeners: ((event: unknown) => void)[] = []
      addEventListener(_type: string, listener: (event: unknown) => void): void {
        this.listeners.push(listener)
      }
      removeEventListener(_type: string, listener: (event: unknown) => void): void {
        const at = this.listeners.indexOf(listener)
        if (at !== -1) this.listeners.splice(at, 1)
      }
    }
    class FakeController {
      readonly signal = new FakeSignal()
      abort(reason?: unknown): void {
        if (this.signal.aborted) return
        this.signal.aborted = true
        this.signal.reason = reason
        for (const listener of [...this.signal.listeners]) listener({ target: this.signal })
      }
    }
    const self: Record<string, unknown> = { AbortSignal: FakeSignal, AbortController: FakeController }
    return { self, promise: {}, patches: {} }
  }

  /** Install the shims into a fake environment. */
  function installShims(env: ReturnType<typeof compatEnv>): void {
    const body = scriptBody(mobileCompatScript())
    const factory = new Function('self', 'globalThis', 'Promise', 'Object', 'Symbol', 'setTimeout', 'console', body)
    factory(env.self, env.patches, env.promise, Object, Symbol, setTimeout, console)
  }

  it('installs only the missing APIs', () => {
    const env = compatEnv()
    installShims(env)
    const Signal = env.self.AbortSignal as { any?: unknown; timeout?: unknown }
    expect(typeof Signal.any).toBe('function')
    expect(typeof Signal.timeout).toBe('function')
    expect(typeof env.promise.withResolvers).toBe('function')
  })

  it('leaves an engine that already has the APIs untouched', () => {
    const env = compatEnv()
    const any = (): string => 'native'
    ;(env.self.AbortSignal as { any?: unknown }).any = any
    const withResolvers = (): string => 'native'
    env.promise.withResolvers = withResolvers
    installShims(env)
    expect((env.self.AbortSignal as { any?: unknown }).any).toBe(any)
    expect(env.promise.withResolvers).toBe(withResolvers)
  })

  it('combines abort reasons from several signals', () => {
    const env = compatEnv()
    installShims(env)
    const Signal = env.self.AbortSignal as { any(signals: unknown[]): { aborted: boolean; reason: unknown } }
    const Controller = env.self.AbortController as new () => {
      signal: unknown
      abort(reason?: unknown): void
    }
    const first = new Controller()
    const second = new Controller()
    const combined = Signal.any([first.signal, second.signal])
    expect(combined.aborted).toBe(false)
    second.abort('because')
    expect(combined.aborted).toBe(true)
    expect(combined.reason).toBe('because')
  })
})

describe('injectMobileCompat', () => {
  const INDEX = '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<base href="./"></head><body>app</body></html>'

  it('replaces the viewport meta instead of adding a second one, and adds the PWA metas', () => {
    const out = injectMobileCompat(INDEX)
    expect(out.match(/name="viewport"/g)).toHaveLength(1)
    expect(out).toContain('viewport-fit=cover')
    expect(out).toContain(MOBILE_META_MARKER)
    expect(out).toContain('apple-mobile-web-app-capable')
    expect(out).toContain(MOBILE_COMPAT_MARKER)
    // Zoom is deliberately NOT disabled; this plugin's mobile contract is not
    // about removing the user's pinch gesture.
    expect(out).not.toContain('user-scalable=no')
  })

  it('is idempotent and works without a viewport tag', () => {
    const once = injectMobileCompat(INDEX)
    expect(injectMobileCompat(once)).toBe(once)
    const headless = injectMobileCompat('<html><head></head><body>x</body></html>')
    expect(headless).toContain(mobileMetaMarkup().slice(0, 32))
  })
})

describe('socketWatchdogScript', () => {
  it('injects a self-describing script after the head', () => {
    const out = injectSocketWatchdog('<!doctype html><html><head></head><body>x</body></html>')
    expect(out).toContain(SOCKET_WATCHDOG_MARKER)
    expect(scriptBody(socketWatchdogScript())).not.toContain('</script>')
    expect(injectSocketWatchdog(out)).toBe(out)
  })

  it('closes a socket stuck in CONNECTING after the connect timeout', () => {
    vi.useFakeTimers()
    try {
      const env = watchdogEnv()
      installWatchdog(env)
      const Ctor = env.self.WebSocket as new (url: string) => unknown
      void new Ctor('ws://example/one')
      expect(env.sockets).toHaveLength(1)
      vi.advanceTimersByTime(8_100)
      expect(env.sockets[0]?.closeCalls).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never reloads while a socket is OPEN', () => {
    vi.useFakeTimers()
    try {
      const env = watchdogEnv()
      installWatchdog(env)
      const Ctor = env.self.WebSocket as new (url: string) => unknown
      void new Ctor('ws://example/open')
      const socket = env.sockets[0] as FakeSocket
      socket.readyState = 1
      socket.emit('open')
      vi.advanceTimersByTime(60_000)
      expect(env.reloads()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never reloads a page that created no socket at all', () => {
    vi.useFakeTimers()
    try {
      const env = watchdogEnv()
      installWatchdog(env)
      vi.advanceTimersByTime(120_000)
      expect(env.reloads()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reloads once when a resumed page has no open socket, then backs off', () => {
    vi.useFakeTimers()
    try {
      const env = watchdogEnv()
      installWatchdog(env)
      const Ctor = env.self.WebSocket as new (url: string) => unknown
      void new Ctor('ws://example/stuck')
      const socket = env.sockets[0] as FakeSocket
      socket.readyState = 3 // died while the page was in the background

      env.hidden()
      vi.advanceTimersByTime(30_000)
      env.visible()
      // The resume path waits out its grace period before judging.
      vi.advanceTimersByTime(11_000)
      expect(env.reloads()).toBe(1)
      expect(env.storage.get('dshLanGuardReloads')).toBe('1')

      // Cooldown: the next watchdog ticks must not reload again.
      vi.advanceTimersByTime(15_000)
      expect(env.reloads()).toBe(1)

      // After the cooldown the escalation may try again.
      vi.advanceTimersByTime(30_000)
      expect(env.reloads()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops reloading once the per-tab cap is reached', () => {
    vi.useFakeTimers()
    try {
      const env = watchdogEnv()
      env.storage.set('dshLanGuardReloads', '3')
      installWatchdog(env)
      const Ctor = env.self.WebSocket as new (url: string) => unknown
      void new Ctor('ws://example/stuck')
      env.hidden()
      vi.advanceTimersByTime(30_000)
      env.visible()
      vi.advanceTimersByTime(200_000)
      expect(env.reloads()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not reload while the page is hidden', () => {
    vi.useFakeTimers()
    try {
      const env = watchdogEnv({ visibility: 'hidden' })
      installWatchdog(env)
      const Ctor = env.self.WebSocket as new (url: string) => unknown
      void new Ctor('ws://example/hidden')
      vi.advanceTimersByTime(200_000)
      expect(env.reloads()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})


describe('injectMobileScrollFix', () => {
  const INDEX = '<!doctype html><html><head></head><body>x</body></html>'

  it('injects a deliberately conservative narrow-screen correction', () => {
    const out = injectMobileScrollFix(INDEX)
    expect(out).toContain(MOBILE_SCROLL_MARKER)
    const body = scriptBody(mobileScrollFixScript())
    expect(body).not.toContain('</script>')
    // It must ask these questions before touching anything: is the page as a
    // whole unable to scroll, is this a narrow screen, is this a phone, and is
    // there actually a layer clipping overflowing content?
    expect(body).toContain('pageScrolls()')
    expect(body).toContain('max-width: 1023px')
    expect(body).toContain('iPhone|iPad|iPod|Android')
    expect(body).toContain('clipping()')
    // Diagnostic mode is opt-in per page load and never blocks the UI.
    expect(body).toContain('lgdiag')
    // 0.4.3 strategy: fix the HEIGHT CHAIN (dsh-mobile's approach) instead of
    // patching overflow on a content layer. The container the official code
    // believes in must become the real scroller, or nothing is changed at all.
    expect(body).toContain('min-height')
    expect(body).toContain('100dvh')
    expect(body).toContain('data-conversation-scroll')
    expect(body).toContain('convScrolls')
    // Failure must revert completely (page stays stock).
    expect(body).toContain('removeProperty')
    expect(body).toContain('ineffective -> reverted')
    // Drawer/scrim safety (the 0.4.2 regression).
    expect(body).toContain('overlayOpen')
    expect(body).toContain('aria-modal=true')
    // And it must NOT do the things that caused the reported regressions:
    // Touch interception (decisive phone-side finding 2026-09-28): the official
    // scroll layer IS scrollable, yet fingers cannot drag — fullscreen
    // decorative layers swallow touches on iOS. Let pure containers through.
    expect(body).toContain('touchPassThrough')
    expect(body).toContain('pointer-events","none')
    expect(body).toContain('querySelector("button,input,textarea,select,[contenteditable]")')
    expect(body).not.toContain('overflow-y","auto')
    expect(body).not.toContain('lg-to-bottom')
    expect(body).not.toContain('-webkit-overflow-scrolling')
    expect(body).toContain('pointer-events:none')
    // Idempotent.
    expect(injectMobileScrollFix(out)).toBe(out)
  })

  it('is applied by the registrar only while its switch is on', () => {
    let on = false
    let transform: (html: string) => string = () => INDEX
    registerIndexPatches({
      webServer: { tapIndex: (fn: (html: string) => string) => { transform = fn; return () => {} } },
      switches: {
        settingsUnlock: () => false,
        mobileCompat: () => false,
        socketWatchdog: () => false,
        mobileScrollFix: () => on,
      },
    })
    expect(transform(INDEX)).toBe(INDEX)
    on = true
    expect(transform(INDEX)).toContain(MOBILE_SCROLL_MARKER)
  })
})

describe('registerIndexPatches', () => {
  const INDEX = '<!doctype html><html><head><base href="./"></head><body>app</body></html>'

  it('degrades to a warning when the host exposes no tapIndex', () => {
    const { logger, warnings } = recordingLogger()
    const switches = { settingsUnlock: () => true, mobileCompat: () => true, socketWatchdog: () => true, mobileScrollFix: () => true }
    expect(registerIndexPatches({ webServer: {}, switches, logger })).toBeUndefined()
    expect(registerIndexPatches({ webServer: undefined, switches, logger })).toBeUndefined()
    expect(warnings).toHaveLength(2)
  })

  it('applies each patch only while its switch is on, and reads the switch per render', () => {
    let settingsUnlock = false
    let mobileCompat = false
    let socketWatchdog = false
    let transform: (html: string) => string = () => INDEX
    const webServer = { tapIndex: (fn: (html: string) => string) => { transform = fn; return () => {} } }
    registerIndexPatches({
      webServer,
      switches: {
        settingsUnlock: () => settingsUnlock,
        mobileCompat: () => mobileCompat,
        socketWatchdog: () => socketWatchdog,
        mobileScrollFix: () => false,
      },
    })

    expect(transform(INDEX)).toBe(INDEX)

    settingsUnlock = true
    expect(transform(INDEX)).toContain(UNLOCK_MARKER)
    expect(transform(INDEX)).not.toContain(MOBILE_COMPAT_MARKER)

    mobileCompat = true
    socketWatchdog = true
    const all = transform(INDEX)
    expect(all).toContain(UNLOCK_MARKER)
    expect(all).toContain(MOBILE_COMPAT_MARKER)
    expect(all).toContain(SOCKET_WATCHDOG_MARKER)
    // Idempotent even when all three are on and the same document renders twice.
    expect(transform(all)).toBe(all)
  })

  it('disposes the tap', () => {
    let disposed = false
    const webServer = { tapIndex: () => () => { disposed = true } }
    const dispose = registerIndexPatches({
      webServer,
      switches: { settingsUnlock: () => true, mobileCompat: () => true, socketWatchdog: () => true, mobileScrollFix: () => true },
    })
    dispose?.()
    expect(disposed).toBe(true)
  })
})
