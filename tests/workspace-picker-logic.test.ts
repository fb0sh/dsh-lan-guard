/**
 * Remote workspace picker — browser-half decision logic.
 *
 * These are the two questions the client half must never get wrong: whether
 * THIS browser can reach the host's OS dialog, and what a refusal means to the
 * person holding the phone. Both are pure, so they are tested without a DOM.
 */
import { describe, expect, it } from 'vitest'
import {
  BROWSE_PATH,
  BrowseRequestError,
  FLOW_PRIORITY,
  HERO_FLOW,
  SIDEBAR_FLOW,
  browseErrorNotice,
  directoryFlowDecision,
  isLoopbackHostname,
  readBrowseResponse,
  readClientEnvironment,
  registerDirectoryFlow,
  type ClientEnvironment,
  type FlowSlots,
} from '../src/client/picker-logic.ts'
import { en, standaloneTranslate, type Translate } from '../src/client/i18n.ts'

/** A remote browser: the LAN gateway case this whole feature exists for. */
function remote(overrides: Partial<ClientEnvironment> = {}): ClientEnvironment {
  return {
    hostname: '192.168.1.20',
    protocol: 'https:',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    hasDesktopPicker: false,
    hasNativeHost: false,
    ...overrides,
  }
}

describe('isLoopbackHostname', () => {
  it('recognises every loopback spelling and nothing else', () => {
    for (const name of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]', ' 127.0.0.1 ']) {
      expect(isLoopbackHostname(name)).toBe(true)
    }
    for (const name of ['192.168.1.20', '10.0.0.30', 'dsh.example.com', '127.0.0.1.evil.com']) {
      expect(isLoopbackHostname(name)).toBe(false)
    }
  })
})

describe('directoryFlowDecision', () => {
  it('gives the OS dialog to a browser sitting at this machine', () => {
    expect(directoryFlowDecision(remote({ hostname: '127.0.0.1' }))).toBe('native')
    expect(directoryFlowDecision(remote({ hostname: 'localhost' }))).toBe('native')
  })

  it('gives the OS dialog to a desktop shell even on a non-loopback hostname', () => {
    expect(directoryFlowDecision(remote({ hasDesktopPicker: true }))).toBe('native')
    expect(directoryFlowDecision(remote({ hasNativeHost: true }))).toBe('native')
    expect(directoryFlowDecision(remote({ userAgent: 'Mozilla/5.0 Electron/32.0' }))).toBe('native')
    expect(directoryFlowDecision(remote({ protocol: 'app:' }))).toBe('native')
  })

  it('gives the in-page browser to every remote device', () => {
    expect(directoryFlowDecision(remote())).toBe('browse')
    expect(directoryFlowDecision(remote({ hostname: '10.0.0.30', protocol: 'http:' }))).toBe('browse')
  })

  it('registers BELOW DSH’s own occupant, because a single slot renders the lowest priority', () => {
    expect(FLOW_PRIORITY).toBeLessThan(0)
  })

  it('points at the management route the host actually serves', () => {
    expect(BROWSE_PATH).toBe('/plugins/dsh-lan-guard/workspaces')
  })
})

describe('browseErrorNotice', () => {
  // The notices are message keys resolved by the caller's translator. The
  // assertions below run against the Chinese dictionary (the stand-in a host
  // without the locale service gets); the English side is covered by the
  // dictionary completeness type plus the i18n specs.
  const t = standaloneTranslate()

  it('explains the two authority refusals with the exact fix', () => {
    expect(browseErrorNotice('read_only_remote', t).detail).toContain('密码解锁')
    expect(browseErrorNotice('admin_required', t).detail).toContain('管理密码')
  })

  it('explains a blocked path, a missing one and an expired session', () => {
    expect(browseErrorNotice('blocked', t).detail).toContain('.ssh')
    expect(browseErrorNotice('not_found', t).title).toBe('目录不存在')
    expect(browseErrorNotice('forbidden', t).title).toBe('会话已失效')
    expect(browseErrorNotice('unauthorized', t).title).toBe('会话已失效')
  })

  it('always returns a non-empty notice, even for an unknown code', () => {
    const unknown = browseErrorNotice('something_new', t)
    expect(unknown.title).not.toBe('')
    // An unrecognised code is passed through verbatim rather than swallowed:
    // a new host code stays visible instead of becoming a generic message.
    expect(unknown.detail).toContain('something_new')
  })

  it('reads the same notice in English when the active locale is English', () => {
    const english: Translate = (key, params) => en[key].replace(/\{(\w+)\}/g,
      (match, name: string) => (params !== undefined && name in params ? String(params[name]) : match))
    expect(browseErrorNotice('not_found', english).title).toBe('Directory not found')
    expect(browseErrorNotice('unauthorized', english).title).toBe('Session expired')
  })
})

describe('readBrowseResponse', () => {
  it('accepts a listing and defaults the arrays it did not receive', () => {
    const view = readBrowseResponse(200, { ok: true, path: '/tmp/x' })
    expect(view).toEqual({ path: '/tmp/x', crumbs: [], quick: [], entries: [], truncated: false })
  })

  it('carries the server’s stable code on a refusal', () => {
    try {
      readBrowseResponse(403, { ok: false, error: 'read_only_remote' })
      expect.unreachable('a refusal must throw')
    } catch (error) {
      expect(error).toBeInstanceOf(BrowseRequestError)
      expect((error as BrowseRequestError).code).toBe('read_only_remote')
    }
  })

  it('falls back to the HTTP status when the body is not JSON', () => {
    for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [502, 'http_502']] as const) {
      try {
        readBrowseResponse(status, null)
        expect.unreachable('a refusal must throw')
      } catch (error) {
        expect((error as BrowseRequestError).code).toBe(code)
      }
    }
  })
})

describe('registerDirectoryFlow', () => {
  /** A slot registry that records what was registered and drains generator callbacks. */
  function fakeSlots(): {
    slots: FlowSlots
    seats: string[]
    registered: { options: Record<string, unknown>; component: unknown }[]
  } {
    const seats: string[] = []
    const registered: { options: Record<string, unknown>; component: unknown }[] = []
    const drain = (value: unknown): void => {
      if (value !== null && typeof value === 'object' && Symbol.iterator in value) {
        for (const step of value as Iterable<unknown>) void step
      }
    }
    return {
      seats,
      registered,
      slots: {
        inject: (seat, callback) => {
          seats.push(seat)
          drain(callback())
          return () => {}
        },
        register: (options, component) => {
          registered.push({ options, component })
          return () => {}
        },
      },
    }
  }

  it('shadows the official occupant in BOTH holes at a lower priority', () => {
    const fake = fakeSlots()
    const component = { marker: 'occupant' }
    registerDirectoryFlow(fake.slots, component, {
      pick: async () => null,
      browse: async () => ({ path: '/', crumbs: [], quick: [], entries: [], truncated: false }),
      create: async () => '/',
    })
    expect(fake.seats).toEqual([HERO_FLOW, SIDEBAR_FLOW])
    expect(fake.registered.map(entry => entry.options.name)).toEqual([HERO_FLOW, SIDEBAR_FLOW])
    for (const entry of fake.registered) {
      // A `single` slot renders the lowest priority, so anything >= 0 would
      // either collide with DSH's own surface or never render.
      expect(entry.options.priority).toBe(FLOW_PRIORITY)
      expect(entry.component).toBe(component)
    }
  })

  it('hands the occupant the pick and browse calls the owner cannot provide', () => {
    const fake = fakeSlots()
    const pick = async (): Promise<string | null> => '/picked'
    const browse = async (): Promise<{ path: string; crumbs: []; quick: []; entries: []; truncated: boolean }> => ({
      path: '/',
      crumbs: [],
      quick: [],
      entries: [],
      truncated: false,
    })
    const create = async (): Promise<string> => '/'
    registerDirectoryFlow(fake.slots, {}, { pick, browse, create })
    const injected = fake.registered[0]?.options.inject
    expect(typeof injected).toBe('function')
    const props = (injected as () => { pick: unknown; browse: unknown; create: unknown })()
    expect(props.pick).toBe(pick)
    expect(props.browse).toBe(browse)
    // The create verb rides the same surface, so the occupant can always reach
    // it without a second lookup.
    expect(props.create).toBe(create)
  })
})

describe('readClientEnvironment', () => {
  it('reads the page facts without throwing when there is no DOM', () => {
    const env = readClientEnvironment()
    expect(typeof env.hostname).toBe('string')
    expect(typeof env.protocol).toBe('string')
    expect(env.hasDesktopPicker).toBe(false)
    expect(env.hasNativeHost).toBe(false)
  })

  it('picks up the desktop markers when the shell installs them', () => {
    const scope = globalThis as unknown as Record<string, unknown>
    scope.__DSH_NATIVE_HOST__ = true
    try {
      expect(readClientEnvironment().hasNativeHost).toBe(true)
      expect(directoryFlowDecision(readClientEnvironment())).toBe('native')
    } finally {
      delete scope.__DSH_NATIVE_HOST__
    }
  })
})
