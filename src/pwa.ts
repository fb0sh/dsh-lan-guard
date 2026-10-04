/**
 * dsh-lan-guard — the installability service worker, and why it has to exist.
 *
 * Chromium (and Edge on Android) will not offer "install as an app" for an
 * origin that has a valid manifest but no service worker with a `fetch`
 * handler: the browser then only offers "create shortcut", which opens in an
 * ordinary tab instead of a standalone window. DSH ships a manifest
 * (`/manifest.webmanifest`) and registers no service worker anywhere, so on a
 * phone the install entry comes back greyed out — the state the Android menu
 * reports as 「无法安装此应用」.
 *
 * This worker is deliberately EMPTY of behaviour: its `fetch` listener never
 * calls `respondWith`, so every request is answered by the browser's own
 * network stack, byte for byte, with the credentials and the streaming the gate
 * already relies on. It exists to satisfy the installability check, not to
 * intercept anything — a caching worker here would sit between a visitor and an
 * authenticated, cookie-carrying, streaming application.
 *
 * Two details are load-bearing:
 *
 * - it is served from the gate's own path prefix, so the response carries
 *   `Service-Worker-Allowed: /`. Without that header the worker's scope would
 *   default to its own directory, it would never control the page, and the
 *   install check would still fail;
 * - `navigator.serviceWorker` exists only in a SECURE CONTEXT, so an operator
 *   serving the gateway over plain HTTP gets no worker at all. The registration
 *   is a silent no-op there instead of an error.
 */

/** Marker attribute naming the injected registration script, for tests and de-duplication. */
/*
 * MARKER STYLE IS LOAD-BEARING: these markers sit INSIDE a script element, and
 * the HTML-comment opener is a legal SINGLE-LINE comment in JavaScript (Annex
 * B). A marker written that way therefore comments out the rest of the injected
 * line — which is the whole script, since each is emitted on one line.
 *
 * All three patches below shipped with that marker and silently did nothing:
 * the document-language fix and the service-worker registration never ran
 * (found 2026-10-04, by noticing that a new patch's side effect never happened
 * while its siblings' did). The patches that use a JS block comment were
 * unaffected, which is what hid this for so long.
 *
 * tests/pwa-scripts.test.ts now EXECUTES each script and asserts its effect,
 * instead of grepping for the marker text.
 */
export const PWA_MARKER = '/*dsh-lan-guard:pwa*/'

/** Marker attribute naming the injected document-language script. */
export const LANGUAGE_MARKER = '/*dsh-lan-guard:lang*/'

/**
 * The worker body.
 *
 * `skipWaiting` + `clients.claim` make the very first install control the page
 * that registered it, so the install entry becomes available on that same page
 * load rather than one navigation later. Both are safe here precisely because
 * the `fetch` handler does nothing: claiming a client cannot change how any
 * request is served.
 */
/**
 * The plugin-owned manifest and its icons.
 *
 * WHY THIS EXISTS: DSH's own `/manifest.webmanifest` declares a single icon,
 * `favicon.svg` with `sizes: "any"`. Chrome's documented install criteria
 * require "a 192px and a 512px icon", and an SVG-only manifest does not satisfy
 * that on Android — Edge offers only "create a shortcut" and reports "cannot
 * install this app" (reported 2026-10-04). Everything else about DSH's manifest
 * already qualifies, so this manifest mirrors it field for field and only
 * replaces the icon list with real PNGs rasterized from DSH's own favicon.
 *
 * It is served by the GATE, so the swap below is applied only on a page that
 * came through the gate: DSH's own loopback origin keeps DSH's own manifest.
 */
/** Idempotency marker for the manifest-link swap. */
export const PWA_MANIFEST_MARKER = '/*dsh-lan-guard:manifest*/'

/**
 * The manifest the gate serves.
 *
 * Field for field DSH's own, except for `icons`: the two PNGs are what the
 * install check actually reads, and DSH's SVG is kept as a third entry so a
 * browser that prefers vector art still gets it.
 *
 * @param icons - the gate-owned icon routes to advertise.
 * @returns the manifest as JSON text.
 */
export function pwaManifest(icons: { icon192: string; icon512: string }): string {
  return JSON.stringify({
    name: 'DeepSeek Harness',
    short_name: 'DSH',
    start_url: './',
    scope: './',
    display: 'fullscreen',
    icons: [
      { src: icons.icon192, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: icons.icon512, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  })
}

/**
 * The manifest-link swap.
 *
 * Runs on the VISITOR's page, so it can tell which origin served it — the index
 * tap cannot, because it only ever sees the HTML. Loopback returns early for the
 * same reason {@link pwaInstallScript} does: that origin is DSH's own, where
 * this plugin's manifest path does not exist and the swap would break a working
 * install.
 *
 * Deferred to `DOMContentLoaded` because the tap injects at the top of `<head>`,
 * ahead of the `<link rel="manifest">` it has to find. Installability is decided
 * after load, so the swap still lands in time.
 *
 * @param manifestPath - the gate-owned manifest route to point the link at.
 * @returns one inline `<script>` element.
 */
export function pwaManifestScript(manifestPath: string): string {
  return `<script>${PWA_MANIFEST_MARKER}(function(){try{`
    + 'var h=location.hostname;'
    + 'if(h==="127.0.0.1"||h==="localhost"||h==="[::1]")return;'
    + `var p=${JSON.stringify(manifestPath)};`
    + 'var swap=function(){'
    + `var l=document.querySelector('link[rel="manifest"]');`
    + 'if(l&&l.getAttribute("href")!==p)l.setAttribute("href",p);'
    + '};'
    + 'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",swap);'
    + 'else swap();'
    + '}catch(e){}})()</script>'
  }

export const SERVICE_WORKER_BODY = `/* dsh-lan-guard: installability worker — intentionally empty.
 * Its fetch listener exists so the browser can offer "install as an app"; it
 * never short-circuits a request and never consults a cache, so every request
 * is still handled by the browser itself. See src/pwa.ts in dsh-lan-guard. */
self.addEventListener('install', function () { self.skipWaiting() })
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()) })
self.addEventListener('fetch', function () {})
`

/**
 * The document-language patch.
 *
 * DSH's `index.html` hard-codes `<html lang="en">`, and its locale layer only
 * rewrites the attribute once the SPA boots and the locale setting resolves.
 * Chrome and Edge decide whether to offer "translate this page" from the
 * document's declared language when the page loads, so a Chinese phone opening
 * a Chinese UI is still offered 英语 → 中文, and the bar stays for the whole
 * session because the offer is never re-evaluated.
 *
 * The visitor's own browser language is the right first guess: it mirrors DSH's
 * documented rule for a browser it has never seen ("a fresh browser uses the
 * first supported language the browser requests"). DSH's locale layer then
 * overwrites it with the real locale, so an English-configured instance still
 * ends up declaring `en`.
 *
 * @returns one inline `<script>` element, inserted as early as possible.
 */
export function documentLanguageScript(): string {
  return `<script>${LANGUAGE_MARKER}(function(){try{`
    // Only ever correct the shell's own hard-coded default: once DSH (or a
    // future DSH) declares a real language, that value is authoritative.
    + 'var d=document.documentElement;'
    + 'if(!d||d.getAttribute("lang")!=="en")return;'
    + 'var n=navigator.language;'
    + 'if(typeof n==="string"&&n!=="")d.setAttribute("lang",n);'
    + '}catch(e){}})()</script>'
}

/**
 * The registration patch.
 *
 * Skipped when the page is not being served through the gateway: the same index
 * patch runs on DSH's own loopback origin, where `/__dsh_lan_guard__/sw.js` does
 * not exist, and a failed registration would only be console noise.
 *
 * @param path - the gate-owned path the worker is served from.
 * @returns one inline `<script>` element.
 */
export function pwaInstallScript(path: string): string {
  return `<script>${PWA_MARKER}(function(){try{`
    + 'if(!("serviceWorker" in navigator))return;'
    + 'var h=location.hostname;'
    + 'if(h==="127.0.0.1"||h==="localhost"||h==="[::1]")return;'
    // The scope is spelled out so a future default change cannot narrow it, and
    // the promise is swallowed: an installability nicety must never surface as
    // an unhandled rejection in a visitor's console.
    + `navigator.serviceWorker.register(${JSON.stringify(path)},{scope:"/"}).catch(function(){});`
    + '}catch(e){}})()</script>'
}
