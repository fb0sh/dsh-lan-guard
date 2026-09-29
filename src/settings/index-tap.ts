/**
 * dsh-lan-guard — the three patches this plugin injects into DSH's served index.
 *
 * The tap runs inside DSH's own web server (`WebServer.tapIndex`), BEFORE
 * compression, so no response body has to be buffered or rewritten on the proxy
 * path. Each patch has its own marker and is idempotent; the switches are read
 * on EVERY index render, so flipping one needs only a page refresh.
 *
 * 1. {@link injectSettingsUnlock} — `__DSH_TRANSPORT__.ownsHost = true`, which is
 *    what makes DSH treat a LAN page as the host's own surface (Settings →
 *    Models works from a phone). Research note: DSH's settings service computes
 *    `persistence = isLoopback ? "host" : "memory"` from the PAGE's own address,
 *    which a reverse proxy cannot change.
 *
 * 2. {@link injectMobileCompat} — the shims measured on 2026-09-28 as
 *    load-bearing for phones: `AbortSignal.any`/`timeout` (Safari < 17.4),
 *    `Promise.withResolvers` (< 17.4) and the `Iterator` global (< 18.4, which
 *    pdf.js dereferences at module top level and takes the whole plugin tree
 *    down with it). DSH's client calls `AbortSignal.any` in
 *    `openRemoteStream`, i.e. on the session-stream path; without it the throw
 *    is re-thrown by `Session.doOpen` and the chat sits on 「载入历史…」 forever,
 *    with no error text at all. Also adds the mobile/PWA metas. Every shim is
 *    installed only when missing, so a modern engine is untouched.
 *
 * 3. {@link injectSocketWatchdog} — closes sockets stuck in CONNECTING and, when
 *    a resume from the background leaves nothing open, reloads the page once.
 *    WebKit has a documented behaviour where `new WebSocket()` stays in
 *    CONNECTING forever after a background resume while HTTP keeps working, and
 *    DSH's own client has no connect timeout, so the page never recovers by
 *    itself.
 */
import type { LanGuardLogger } from '../log.ts'
import { noopLogger } from '../log.ts'

/** The page global DSH's connection client reads its transport facts from. */
export const TRANSPORT_GLOBAL = '__DSH_TRANSPORT__'

/** Page global listing which patches this page actually received (health panel). */
export const PATCHES_GLOBAL = '__DSH_LAN_GUARD__'

/** Marker proving this file already injected the settings unlock. */
export const UNLOCK_MARKER = '/*dsh-lan-guard:settings-unlock*/'

/** Marker proving the mobile compatibility shims were injected. */
export const MOBILE_COMPAT_MARKER = '/*dsh-lan-guard:mobile-compat*/'

/** Marker proving the mobile metas were injected. */
export const MOBILE_META_MARKER = '<!--dsh-lan-guard:mobile-meta-->'

/** Marker proving the socket watchdog was injected. */
export const SOCKET_WATCHDOG_MARKER = '/*dsh-lan-guard:socket-watchdog*/'

/** The subset of DSH's `webServer` service this module needs. */
export interface IndexTapLike {
  tapIndex(transform: (html: string) => string): () => void
}

/** The page-side switches an index render reads. */
export interface IndexPatchSwitches {
  /** Install the `ownsHost` unlock. */
  settingsUnlock(): boolean
  /** Install the mobile compatibility shims. */
  mobileCompat(): boolean
  /** Install the client-side socket watchdog. */
  socketWatchdog(): boolean
  /** Install the narrow-screen scroll correction. */
  mobileScrollFix(): boolean
}

/**
 * The exact head markup that makes the page look like the host's own surface.
 *
 * Written as ES5 with `Object.assign` so it cannot throw on a primitive or a
 * hostile value already sitting on the global, and it never overwrites a
 * property DSH itself put there.
 *
 * @returns one inline `<script>` element.
 */
export function settingsUnlockScript(): string {
  return `<script>${UNLOCK_MARKER}(function(){var t=globalThis.${TRANSPORT_GLOBAL};`
    + `globalThis.${TRANSPORT_GLOBAL}=Object.assign({},t!==null&&typeof t==="object"?t:{},{ownsHost:true});`
    + `globalThis.${PATCHES_GLOBAL}=Object.assign({},globalThis.${PATCHES_GLOBAL},{settingsUnlock:true});`
    + '})()</script>'
}

/** Marker proving the mobile scroll fix was injected. */
export const MOBILE_SCROLL_MARKER = '/*dsh-lan-guard:mobile-scroll*/'

/**
 * The narrow-screen scroll correction (2026-09-28 user report: "聊天区无法上下滑动").
 *
 * Measured facts behind it:
 *
 * - On the SAME iPhone viewport in desktop Chrome the chat column scrolls fine
 *   (a wheel scroll reveals «加载更早»), so the relay and the app are not broken;
 *   the failure is iOS-specific layout/touch behaviour inside DSH's own shell —
 *   whose root layer is `dsh-sc-layer` (`position:fixed`, full height,
 *   `overflow-y:hidden`).
 * - On a phone the symptom is "content is visible, the bottom half is covered by
 *   the fixed composer/goal/quick-reply floats, and the column cannot be dragged".
 *
 * The script is deliberately conservative and ONLY acts when the page as a whole
 * cannot scroll AND it finds a layer that is clipping overflowing content. Then
 * it turns exactly those layers into touch-scrollable ones. A page that can
 * already scroll (every desktop browser, and a healthy phone) is never touched.
 *
 * `?lgdiag=1` appends an on-screen report (and clears itself on reload); that is
 * the diagnostic that made this fix possible without a Mac attached to the
 * phone.
 *
 * @returns one inline `<script>` element.
 */
/**
 * 窄屏高度链修正（2026-09-28 第三次修订，照抄 dsh-mobile 的做法）。
 *
 * 事实（真机 + 官方源码 + 竞品对照）：
 *
 * - 官方外壳在窄屏 iOS 下把内容裁在 `pI_x6G_frame`（实测 clientH 844 /
 *   scrollH 1688），而 conversation 认定的滚动层 `[data-conversation-scroll]`
 *   始终 754/754：内容根本没进它的流。结果：手指拖不动、官方「回到底部」
 *   按钮点了没反应、打开会话也不会自动停到最新消息。
 * - dsh-mobile 能做对，靠的是**高度链**而不是滚动补丁：
 *   `html,body,#root{height:100%;overflow:hidden}` +
 *   shell `height:100dvh` + 主区 `min-height:0`（flex 子项允许收缩）。
 *
 * 因此本脚本只做同一件事，并且**绝不改任何 overflow-y、绝不新建滚动容器、
 * 绝不加自己的按钮**：
 *
 * 1. 给 `html/body/#root` 一个确定高度（`100%`，支持时 `100dvh`）并锁住页面滚动；
 * 2. 沿着「被裁且内容溢出」的那一层，给链上所有 flex/grid 容器补 `min-height:0`；
 * 3. 立刻验证官方认定的滚动层是否真的能滚了：能 → 保留；不能 → **全部撤销**，
 *    页面回到与官方逐字节一致的状态（宁可不动，也不引入第二个滚动层）。
 *
 * 抽屉/遮罩打开时同样先撤销自己（0.4.2 的遮罩事故教训）。
 *
 * @returns one inline `<script>` element.
 */
export function mobileScrollFixScript(): string {
  return `<script>${MOBILE_SCROLL_MARKER}(function(){try{`
    + 'var diag=/[?&]lgdiag/.test(self.location.search);var out=[];'
    + 'function log(s){out.push(s);if(diag)draw()}'
    + 'function draw(){try{var p=document.getElementById("lgsc");'
    + 'if(!p){p=document.createElement("pre");p.id="lgsc";p.style.cssText='
    + '"position:fixed;left:0;top:0;right:0;height:46%;z-index:2147483647;background:rgba(0,0,0,.92);'
    + 'color:#0f0;font:10px/1.3 monospace;padding:6px;margin:0;overflow:auto;white-space:pre-wrap;pointer-events:none";'
    + '(document.body||document.documentElement).appendChild(p)}'
    + 'p.textContent="[lan-guard 手机滚动诊断]"+String.fromCharCode(10)+out.join(String.fromCharCode(10))}catch(e){}}'
    + 'var touched=[];'
    + 'function set(el,prop,val){if(!el)return;try{el.style.setProperty(prop,val,"important");'
    + 'touched.push([el,prop])}catch(e){}}'
    + 'function undoAll(){for(var i=0;i<touched.length;i++){try{touched[i][0].style.removeProperty(touched[i][1])}catch(e){}}touched=[]}'
    + 'function conv(){try{return document.querySelector("[data-conversation-scroll]")}catch(e){return null}}'
    + 'function convScrolls(){var c=conv();return !!c&&c.scrollHeight>c.clientHeight+8}'
    + 'function pageScrolls(){var d=document.documentElement,b=document.body;'
    + 'return (d&&d.scrollHeight>d.clientHeight+8)||(b&&b.scrollHeight>b.clientHeight+8)}'
    + 'function clipping(){var r=[];var all=document.querySelectorAll("div");var lim=Math.min(all.length,5000);'
    + 'for(var i=0;i<lim;i++){var el=all[i];var cs=getComputedStyle(el);'
    + 'if(cs.overflowY!=="hidden"&&cs.overflowY!=="clip")continue;'
    + 'if(el.clientHeight<150)continue;if(el.scrollHeight<=el.clientHeight+8)continue;r.push(el)}'
    + 'r.sort(function(a,b){return (b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight)});return r}'
    + 'function overlayOpen(){'
    + 'try{if(document.querySelector("[aria-modal=true],[role=dialog],[data-conversation-overlay]"))return true;'
    + 'var el=document.elementFromPoint(Math.round(innerWidth*0.92),Math.round(innerHeight*0.45));'
    + 'while(el&&el!==document.body){var cs=getComputedStyle(el);'
    + 'if((cs.position==="fixed"||cs.position==="absolute")&&cs.pointerEvents!=="none"){'
    + 'var r=el.getBoundingClientRect();'
    + 'if(r.width>innerWidth*0.85&&r.height>innerHeight*0.7)return true}'
    + 'el=el.parentElement}}catch(e){}return false}'
    + 'function fix(){'
    + 'var list=clipping();var clip=list[0];'
    + 'log("clipping="+list.length+(clip?(" first="+String(typeof clip.className==="string"?clip.className:"")+" "+clip.clientHeight+"/"+clip.scrollHeight):""));'
    + 'var root=document.getElementById("root");'
    + 'set(document.documentElement,"height","100%");'
    + 'set(document.body,"height","100%");set(document.body,"overflow","hidden");'
    + 'set(root,"height","100dvh");set(root,"min-height","0");set(root,"overflow","hidden");'
    + 'var n=clip,d=0;'
    + 'while(n&&n!==document.body&&d<8){var cs=getComputedStyle(n);'
    + 'if(cs.display.indexOf("flex")>=0||cs.display.indexOf("grid")>=0)set(n,"min-height","0");'
    + 'n=n.parentElement;d++}'
    + 'var ok=convScrolls();'
    + 'log("chainFix convScroll="+(conv()?(conv().clientHeight+"/"+conv().scrollHeight):"n/a")+" scrollable="+ok);'
    + 'if(!ok){undoAll();log("ineffective -> reverted (stock page)")}'
    + 'return ok}'
    + 'var done=false,tries=0;'
    + 'function run(){if(done)return;'
    + 'var narrow=self.matchMedia?self.matchMedia("(max-width: 1023px)").matches:false;'
    + 'var mobile=/iPhone|iPad|iPod|Android/i.test(navigator.userAgent||"");'
    + 'log("narrow="+narrow+" mobile="+mobile+" innerH="+innerHeight+" vv="+(self.visualViewport?self.visualViewport.height:"-")+" pageScrolls="+pageScrolls());'
    + 'if(!narrow||!mobile){done=true;return}'
    + 'if(overlayOpen()){undoAll();log("overlay/dialog open -> reverted");return}'
    + 'if(convScrolls()){log("official scroll layer already works");done=true;return}'
    + 'if(fix())done=true}'
    + 'run();'
    + 'var t=setInterval(function(){tries++;run();if(done||tries>30)clearInterval(t)},1500);'
    + '}catch(e){}})()</script>'
}

/**
 * Insert the narrow-screen scroll correction.
 *
 * @param html - the index body as DSH rendered it.
 * @returns the body with the correction inserted.
 */
export function injectMobileScrollFix(html: string): string {
  if (html.includes(MOBILE_SCROLL_MARKER)) return html
  return insertAfterHead(html, mobileScrollFixScript())
}

/**
 * The mobile compatibility shims, in one inline script.
 *
 * Every branch is guarded by a `typeof` check, so a browser that already has
 * the API (or a future DSH that installs its own shim first) is untouched, and
 * the whole thing is wrapped in `try` so a hostile environment cannot break the
 * remaining scripts.
 *
 * @returns one inline `<script>` element.
 */
export function mobileCompatScript(): string {
  return `<script>${MOBILE_COMPAT_MARKER}(function(){try{`
    // AbortSignal.any — Safari 17.4+. DSH's stream open calls it on every
    // logical stream, so its absence breaks the session transcript.
    + 'var S=self.AbortSignal;'
    + 'if(S&&typeof S.any!=="function"){S.any=function(signals){'
    + 'var list=Array.prototype.slice.call(signals||[]);var c=new self.AbortController();'
    + 'var i;for(i=0;i<list.length;i++){if(list[i]&&list[i].aborted){'
    + 'try{c.abort(list[i].reason)}catch(e){c.abort()}return c.signal}}'
    + 'var off=function(ev){var src=ev&&ev.target?ev.target:ev;'
    + 'for(var j=0;j<list.length;j++){try{list[j].removeEventListener("abort",off)}catch(e){}}'
    + 'try{c.abort(src?src.reason:undefined)}catch(e){c.abort()}};'
    + 'for(i=0;i<list.length;i++){try{list[i].addEventListener("abort",off,{once:true})}catch(e){}}'
    + 'return c.signal}}'
    // AbortSignal.timeout — Safari 16+; cheap to have everywhere.
    + 'if(S&&typeof S.timeout!=="function"){S.timeout=function(ms){var c=new self.AbortController();'
    + 'setTimeout(function(){try{c.abort(new Error("The operation timed out."))}catch(e){c.abort()}},'
    + 'Math.max(0,Number(ms)||0));return c.signal}}'
    // Promise.withResolvers — Safari 17.4+; DSH's boot inline script uses it and
    // several client plugins call it at runtime.
    + 'if(typeof Promise!=="undefined"&&typeof Promise.withResolvers!=="function"){'
    + 'Promise.withResolvers=function(){var resolve,reject;'
    + 'var promise=new Promise(function(res,rej){resolve=res;reject=rej});'
    + 'return{promise:promise,resolve:resolve,reject:reject}}}'
    // Iterator — Safari 18.4+. pdf.js patches Iterator.prototype at module top
    // level; without the global it throws and the whole plugin tree fails.
    // Grafting the real %IteratorPrototype% keeps that patch meaningful.
    + 'if(typeof self.Iterator==="undefined"){var proto=null;'
    + 'try{proto=Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()))}catch(e){proto=null}'
    + 'var Shim=function Iterator(){};if(proto){Shim.prototype=proto}self.Iterator=Shim}'
    + `globalThis.${PATCHES_GLOBAL}=Object.assign({},globalThis.${PATCHES_GLOBAL},{mobileCompat:true});`
    + '}catch(e){}})()</script>'
}

/** The mobile/PWA metas DSH's own index does not carry. */
export function mobileMetaMarkup(): string {
  return `${MOBILE_META_MARKER}`
    + '<meta name="apple-mobile-web-app-capable" content="yes">'
    + '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">'
    + '<meta name="apple-mobile-web-app-title" content="DSH">'
    + '<meta name="theme-color" content="#1e1e2e">'
}

/**
 * The client-side socket watchdog, in one inline script.
 *
 * Behaviour, in order of aggressiveness:
 *
 * 1. every `WebSocket` the page creates is tracked, and one still CONNECTING
 *    after 8 s is closed so DSH's own retry loop advances instead of hanging;
 * 2. on `visibilitychange` → visible and on a bfcache `pageshow`, the page gets
 *    a 10 s grace period; if by then at least one socket exists and none is
 *    OPEN, the page is reloaded once;
 * 3. reloads are capped (3 in a row, counted in sessionStorage so a reload loop
 *    cannot bootstrap itself) and rate-limited with a doubling cooldown; one
 *    successful socket open clears the escalation.
 *
 * A page that never created a socket (the app failed to boot for some other
 * reason) is never reloaded.
 *
 * @returns one inline `<script>` element.
 */
export function socketWatchdogScript(): string {
  return `<script>${SOCKET_WATCHDOG_MARKER}(function(){try{`
    + 'var W=self.WebSocket;if(typeof W!=="function")return;'
    + `var flags=globalThis.${PATCHES_GLOBAL};`
    + 'if(flags&&flags.socketWatchdog===true)return;'
    + `globalThis.${PATCHES_GLOBAL}=Object.assign({},flags,{socketWatchdog:true});`
    + 'var CONNECT_TIMEOUT_MS=8000,STUCK_AFTER_MS=15000,RESUME_GRACE_MS=10000;'
    + 'var COOLDOWN_BASE_MS=20000,COOLDOWN_MAX_MS=300000,MAX_RELOADS=3;'
    + 'var sockets=[],firstSeenAt=0,lastOpenAt=0,hiddenAt=0,visibleSince=Date.now();'
    + 'var lastReloadAt=0,cooldown=COOLDOWN_BASE_MS;'
    + 'function readReloads(){try{return Number(self.sessionStorage.getItem("dshLanGuardReloads")||"0")||0}catch(e){return 0}}'
    + 'function writeReloads(n){try{self.sessionStorage.setItem("dshLanGuardReloads",String(n))}catch(e){}}'
    + 'var reloads=readReloads();'
    + 'function track(ws){'
    + 'sockets.push(ws);if(sockets.length>32)sockets.shift();'
    + 'if(firstSeenAt===0)firstSeenAt=Date.now();'
    + 'var timer=setTimeout(function(){try{if(ws.readyState===0)ws.close()}catch(e){}},CONNECT_TIMEOUT_MS);'
    + 'ws.addEventListener("open",function(){lastOpenAt=Date.now();reloads=0;writeReloads(0);cooldown=COOLDOWN_BASE_MS});'
    + 'ws.addEventListener("close",function(){clearTimeout(timer)});'
    + 'return ws}'
    + 'function Wrapped(url,protocols){var ws=protocols===undefined?new W(url):new W(url,protocols);return track(ws)}'
    + 'Wrapped.prototype=W.prototype;Wrapped.CONNECTING=0;Wrapped.OPEN=1;Wrapped.CLOSING=2;Wrapped.CLOSED=3;'
    + 'self.WebSocket=Wrapped;'
    + 'function openCount(){var n=0;for(var i=0;i<sockets.length;i++){if(sockets[i].readyState===1)n+=1}return n}'
    + 'function judge(reason){'
    + 'try{var doc=self.document;'
    + 'if(doc&&doc.visibilityState==="hidden")return;'
    + 'if(sockets.length===0)return;'
    + 'if(openCount()>0)return;'
    + 'var t=Date.now();'
    + 'if(t-visibleSince<RESUME_GRACE_MS)return;'
    + 'if(t-Math.max(lastOpenAt,firstSeenAt)<STUCK_AFTER_MS)return;'
    + 'if(lastReloadAt!==0&&t-lastReloadAt<cooldown)return;'
    + 'if(reloads>=MAX_RELOADS)return;'
    + 'reloads+=1;writeReloads(reloads);lastReloadAt=t;cooldown=Math.min(COOLDOWN_MAX_MS,cooldown*2);'
    + 'try{console.warn("[dsh-lan-guard] reloading: the session socket is not open ("+reason+")")}catch(e){}'
    + 'self.location.reload()}catch(e){}}'
    + 'setInterval(function(){judge("watchdog")},2000);'
    + 'var doc=self.document;'
    + 'if(doc&&typeof doc.addEventListener==="function"){'
    + 'doc.addEventListener("visibilitychange",function(){'
    + 'if(doc.visibilityState==="hidden"){hiddenAt=Date.now();return}'
    + 'if(hiddenAt!==0&&Date.now()-hiddenAt>1000){visibleSince=Date.now()}'
    + 'setTimeout(function(){judge("resume")},RESUME_GRACE_MS+500)})}'
    + 'if(typeof self.addEventListener==="function"){'
    + 'self.addEventListener("pageshow",function(event){'
    + 'if(event&&event.persisted){visibleSince=Date.now();setTimeout(function(){judge("bfcache")},RESUME_GRACE_MS+500)}})}'
    + '}catch(e){}})()</script>'
}

/**
 * Insert the unlock script into one index document.
 *
 * @param html - the index body as DSH rendered it.
 * @returns the body with the script inserted.
 */
export function injectSettingsUnlock(html: string): string {
  if (html.includes(UNLOCK_MARKER)) return html
  return insertAfterHead(html, settingsUnlockScript())
}

/**
 * Insert the mobile metas (and rewrite the viewport meta) plus the shims.
 *
 * The existing viewport meta is REPLACED rather than duplicated: with two
 * viewport metas the winner differs between engines, and `viewport-fit=cover`
 * (the notch) is the only part DSH's own tag lacks. Zoom stays enabled — this
 * plugin's mobile contract is about target sizes and horizontal scrolling, not
 * about taking the user's pinch gesture away.
 *
 * @param html - the index body as DSH rendered it.
 * @returns the body with the metas and shims inserted.
 */
export function injectMobileCompat(html: string): string {
  if (html.includes(MOBILE_COMPAT_MARKER)) return html
  return insertAfterHead(injectMobileMetas(html), mobileCompatScript())
}

/**
 * Insert the socket watchdog.
 *
 * @param html - the index body as DSH rendered it.
 * @returns the body with the watchdog inserted.
 */
export function injectSocketWatchdog(html: string): string {
  if (html.includes(SOCKET_WATCHDOG_MARKER)) return html
  return insertAfterHead(html, socketWatchdogScript())
}

/** Add the mobile metas and upgrade the viewport tag, idempotently. */
function injectMobileMetas(html: string): string {
  if (html.includes(MOBILE_META_MARKER)) return html
  const viewport = /<meta\s+name=["']viewport["'][^>]*>/i
  const replacement = '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">'
    + mobileMetaMarkup()
  if (viewport.test(html)) return html.replace(viewport, replacement)
  return insertAfterHead(html, replacement)
}

/** Insert markup immediately after the opening `<head>`, or prepend it. */
function insertAfterHead(html: string, markup: string): string {
  const open = /<head(?:\s[^>]*)?>/i.exec(html)
  if (open === null) return `${markup}${html}`
  const at = open.index + open[0].length
  return `${html.slice(0, at)}${markup}${html.slice(at)}`
}

/** Options for {@link registerIndexPatches}. */
export interface RegisterIndexPatchesOptions {
  /** DSH's web server service (or a stub). */
  webServer?: { tapIndex?: unknown } | undefined
  /** The live switches, read on every index render. */
  switches: IndexPatchSwitches
  /** Logger; a missing seam is a warning, not a failure. */
  logger?: LanGuardLogger
}

/**
 * Install the index tap, when the host exposes one.
 *
 * @param options - see {@link RegisterIndexPatchesOptions}.
 * @returns the disposer removing the tap, or `undefined` when unsupported.
 */
export function registerIndexPatches(options: RegisterIndexPatchesOptions): (() => void) | undefined {
  const logger = options.logger ?? noopLogger
  const tapIndex = options.webServer?.tapIndex
  if (typeof tapIndex !== 'function') {
    // An older or narrower host: degrade to today's behaviour (no LAN settings
    // unlock, no mobile shims) instead of failing the whole plugin.
    logger.warn('webServer.tapIndex is unavailable; the index patches were not installed')
    return undefined
  }
  const tap = tapIndex as (transform: (html: string) => string) => () => void
  return tap.call(options.webServer, (html: string) => {
    let out = html
    if (options.switches.mobileCompat()) out = injectMobileCompat(out)
    if (options.switches.mobileScrollFix()) out = injectMobileScrollFix(out)
    if (options.switches.socketWatchdog()) out = injectSocketWatchdog(out)
    if (options.switches.settingsUnlock()) out = injectSettingsUnlock(out)
    return out
  })
}
