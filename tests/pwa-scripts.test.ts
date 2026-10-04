/**
 * The injected index scripts, EXECUTED rather than grepped.
 *
 * Every patch in `src/pwa.ts` and `src/settings/index-tap.ts` is an inline
 * `<script>` whose text is emitted on a single line, prefixed with a marker.
 * That marker used to be an HTML comment — and the HTML-comment opener is a
 * legal SINGLE-LINE comment in JavaScript (Annex B), so it commented out the
 * entire script. Three patches (the document-language fix, the service-worker
 * registration and the manifest swap) shipped that way and did nothing at all,
 * while their siblings worked because they happened to use a JS block comment.
 *
 * Grepping the marker could never catch that: the marker was present and the
 * text looked right. These specs therefore build a stub environment and RUN the
 * script, asserting the effect the patch exists to have.
 */
import { describe, expect, it } from 'vitest'
import {
  documentLanguageScript,
  pwaInstallScript,
  pwaManifestScript,
} from '../src/pwa.ts'
import { PWA_MANIFEST_PATH, PWA_ICON_192_PATH } from '../src/auth/gate.ts'
import { SERVICE_WORKER_PATH } from '../src/auth/gate.ts'

/** The JavaScript inside one emitted `<script>` element. */
function scriptBody(script: string): string {
  const match = /^<script>([\s\S]*)<\/script>$/.exec(script)
  if (match?.[1] === undefined) throw new Error(`not one script element: ${script.slice(0, 40)}`)
  return match[1]
}

/** A `document` stub that records attribute writes and captures listeners. */
function stubDocument(link: { href: string } | null): {
  doc: Record<string, unknown>
  fire: (name: string) => void
  href: () => string | null
} {
  const listeners = new Map<string, (() => void)[]>()
  const attributes: Record<string, string> = link === null ? {} : { href: link.href }
  const element = link === null ? null : {
    getAttribute: (name: string): string | null => attributes[name] ?? null,
    setAttribute: (name: string, value: string): void => { attributes[name] = value },
  }
  return {
    doc: {
      readyState: 'loading',
      documentElement: { getAttribute: () => 'en', setAttribute: () => undefined },
      querySelector: (selector: string): unknown => (selector.includes('manifest') ? element : null),
      addEventListener: (name: string, fn: () => void): void => {
        listeners.set(name, [...(listeners.get(name) ?? []), fn])
      },
    },
    fire: (name: string): void => { for (const fn of listeners.get(name) ?? []) fn() },
    href: (): string | null => attributes.href ?? null,
  }
}

/** Run one injected script against a stub environment. */
function run(body: string, globals: Record<string, unknown>): void {
  const names = Object.keys(globals)
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function(...names, body)(...names.map(name => globals[name]))
}

describe('the injected scripts actually run', () => {
  it('swaps the manifest link on a gated origin, and only there', () => {
    const gated = stubDocument({ href: './manifest.webmanifest' })
    run(scriptBody(pwaManifestScript(PWA_MANIFEST_PATH)), {
      location: { hostname: '10.66.66.2' }, document: gated.doc,
    })
    // Deferred to DOMContentLoaded because the tap injects ahead of the link.
    expect(gated.href()).toBe('./manifest.webmanifest')
    gated.fire('DOMContentLoaded')
    expect(gated.href()).toBe(PWA_MANIFEST_PATH)

    // On DSH's own origin the plugin's manifest route does not exist, so the
    // swap must leave a working install alone.
    const loopback = stubDocument({ href: './manifest.webmanifest' })
    run(scriptBody(pwaManifestScript(PWA_MANIFEST_PATH)), {
      location: { hostname: '127.0.0.1' }, document: loopback.doc,
    })
    loopback.fire('DOMContentLoaded')
    expect(loopback.href()).toBe('./manifest.webmanifest')
  })

  it('registers the worker at the gate path with a root scope', () => {
    const calls: { path: string; scope: string }[] = []
    run(scriptBody(pwaInstallScript(SERVICE_WORKER_PATH)), {
      location: { hostname: '10.66.66.2' },
      navigator: {
        serviceWorker: {
          register: (path: string, options: { scope: string }) => {
            calls.push({ path, scope: options.scope })
            return Promise.resolve()
          },
        },
      },
    })
    expect(calls).toEqual([{ path: SERVICE_WORKER_PATH, scope: '/' }])
  })

  it('never registers the worker on the loopback origin', () => {
    const calls: unknown[] = []
    for (const hostname of ['127.0.0.1', 'localhost', '[::1]']) {
      run(scriptBody(pwaInstallScript(SERVICE_WORKER_PATH)), {
        location: { hostname },
        navigator: { serviceWorker: { register: (...args: unknown[]) => { calls.push(args); return Promise.resolve() } } },
      })
    }
    expect(calls).toEqual([])
  })

  it('corrects the shell language from the browser, and only when unset', () => {
    const written: string[] = []
    const element = (current: string | null) => ({
      getAttribute: () => current,
      setAttribute: (_name: string, value: string) => { written.push(value) },
    })
    run(scriptBody(documentLanguageScript()), {
      document: { documentElement: element('en') },
      navigator: { language: 'zh-CN' },
    })
    expect(written).toEqual(['zh-CN'])

    // A real declaration wins: DSH's own locale layer sets this after boot, and
    // overwriting it would fight the user's explicit choice.
    written.length = 0
    run(scriptBody(documentLanguageScript()), {
      document: { documentElement: element('zh-CN') },
      navigator: { language: 'en-US' },
    })
    expect(written).toEqual([])
  })
})

describe('script markers are safe inside a script element', () => {
  const SCRIPTS: [string, string][] = [
    ['language', documentLanguageScript()],
    ['service worker', pwaInstallScript(SERVICE_WORKER_PATH)],
    ['manifest', pwaManifestScript(PWA_MANIFEST_PATH)],
  ]

  for (const [name, script] of SCRIPTS) {
    it(`${name}: the marker is a JS comment, not an HTML one`, () => {
      // The HTML-comment opener starts a single-line JS comment, so a marker
      // written that way swallows the whole line — the entire script.
      expect(scriptBody(script)).not.toMatch(/^<!--/)
    })
  }

  it('the manifest script is what advertises the plugin icons', () => {
    expect(PWA_ICON_192_PATH).toContain('/__dsh_lan_guard__/')
  })
})
