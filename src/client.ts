/**
 * dsh-lan-guard — the browser half: one section inside DSH's OFFICIAL settings
 * page.
 *
 * Hard constraints from the spec, all of them load-bearing:
 *
 * - It registers the official `settings.section` seat and replaces NOTHING.
 *   Layout seats (`sidebar`, `rightbar`, `shell.leading`) and layout root
 *   hooks are out of bounds.
 * - Pure `React.createElement` — no JSX, no extra front-end build step.
 * - Styles are inline CSS using the official `--dsw-alias-*` variables, so the
 *   light/dark theme follows automatically (dsh-mobile once shipped a
 *   reference to a non-existent alias and lost the dark theme entirely).
 * - Responsive at two breakpoints: coarse pointers get ≥44px targets, and
 *   ≤620px collapses to a single column.
 * - Passwords and tokens are NEVER echoed: the page only shows whether they
 *   are set, and every write goes through the host endpoint with
 *   `credentials: 'same-origin'`.
 *
 * The section reads and writes `/plugins/dsh-lan-guard/config` on DSH's own
 * origin — the management surface, guarded by DSH's native fence. That is a
 * different auth surface from the proxy port's visitor gate.
 */
import { createElement, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { applyDirectoryFlow } from './client/workspace-flow.ts'
import { CONFIG_PATH as CONFIG_PATH_FROM_PICKER } from './client/picker-logic.ts'

/** Plugin id: also the Loader entry id and the settings namespace. */
const PLUGIN_ID = 'dsh-lan-guard'
/** The official additive settings seat. */
const SEAT = 'settings.section'
/** The management endpoint on DSH's own origin. */
const CONFIG_PATH = CONFIG_PATH_FROM_PICKER

/** The four credential modes offered by the big-card selector. */
const MODE_CHOICES: readonly { id: string; title: string; detail: string }[] = [
  { id: 'token_and_password', title: '扫码免密 + 密码', detail: '既能扫码免密进入，也能手动输入访问密码' },
  { id: 'password', title: '仅密码', detail: '所有设备都必须输入访问密码' },
  { id: 'token', title: '仅安全 Token', detail: '只接受免密链接，不接受密码登录' },
]

/** Admin unlock policies. */
const POLICY_CHOICES: readonly { id: string; title: string; detail: string }[] = [
  { id: 'password_unlock', title: '密码解锁', detail: '任何设备打开设置页都需要管理员密码解锁' },
  { id: 'local_only', title: '仅本机', detail: '只有本机回环访问可以管理，其他设备只读' },
  { id: 'open', title: '不锁定', detail: '不额外解锁，任何能打开设置页的人都能修改' },
]

/** The three tabs of the section (user decision 2026-09-24). */
const TABS = [
  { id: 'access', label: '扫码访问' },
  { id: 'security', label: '安全认证' },
  { id: 'devices', label: '已授权设备' },
  { id: 'connection', label: '连接与证书' },
] as const

/** One tab id. */
type TabId = (typeof TABS)[number]['id']

/** The snapshot the host returns. */
/** What `/update` returns (SPEC F8). */
interface UpdateStatus {
  current: string
  latest: string | null
  hasUpdate: boolean
  checkedAtMs: number | null
  error: string | null
}

interface ConfigSnapshot {
  ok: boolean
  preferences: {
    enabled: boolean
    listenPort: number
    listenHost: string
    networkInterface: string
    settingsUnlock: boolean
    answerHeartbeat: boolean
    socketWatchdog: boolean
    mobileCompat: boolean
    mobileScrollFix: boolean
    mode: string
    adminPolicy: string
    adminProtection: boolean
    allowLoopback: boolean
    requirePairing: boolean
    requireApproval: boolean
  }
  listener: {
    listenHost: string
    listenPort: number
    configuredPort: number
    portFallback: boolean
    upstreamOrigin: string
  }
  authStatus: {
    pluginEnabled: boolean
    gateEnabled: boolean
    mode: string
    adminPolicy: string
    adminProtection: boolean
    allowLoopback: boolean
    localAccess: boolean
    adminRequired: boolean
    remoteReadOnly: boolean
    hasPassword: boolean
    hasAdminPassword: boolean
    hasSecretToken: boolean
    adminUnlocked: boolean
  }
  secretToken?: string
  devices: {
    id: string
    label: string
    status: 'pending' | 'approved' | 'blocked'
    decidedAtMs: number | null
    createdAtMs: number
    lastSeenAtMs: number | null
    lastIp: string | null
    revoked: boolean
  }[]
  pendingCount: number
  /** WebSocket relay counters (P5); absent on hosts that predate the panel. */
  connection?: {
    wsActive: number
    wsUpgrades: number
    wsRefused: number
    heartbeatAnswered: number
    recent: {
      atMs: number
      target: string
      upgraded: boolean
      status?: number
      durationMs: number
      bytesToVisitor: number
      bytesToUpstream: number
      sawCloseFrame: boolean
    }[]
  }
  access: {
    port: number
    portFallbackFrom: number | null
    secure: boolean
    tlsMode: string
    caFingerprint: string | null
    loopbackOnly: boolean
    addresses: {
      interface: string
      address: string
      url: string
      virtual: boolean
      virtualReason?: string
      selected: boolean
    }[]
    selectedUrl: string | null
    qrSvg: string | null
    tokenUrl?: string
    tokenQrSvg?: string
    unavailableReason?: string
  }
}

const CSS = `
/*
 * Typography: NOTHING is invented here. DSH 0.1.7 ships a font scale as font
 * shorthands — --dsw-font-{base-16,s-14,xs-13,xxs-12,xxxs-11} plus -strong-
 * variants — each pairing a size with its line-height (16/24, 14/22, 13/20,
 * 12/18, 11/14) and weight (400 regular, 500 strong). Sizes, weights and
 * line-heights therefore come from the official tokens; only colours use the
 * official --dsw-alias-* variables, and only the URL box overrides the family
 * (with the official code font).
 */
.lg-root{max-width:790px;display:flex;flex-direction:column;gap:18px;
  /* Liquid Glass (user request 2026-09-26). One material definition, every
     value DERIVED from official tokens through color-mix, so the same rules
     follow the light/dark palette with no theme branch and no invented token
     name (see the 2026-09-24 contrast incident). Each surface below still
     declares its solid token colour FIRST: if color-mix or backdrop-filter is
     unsupported the later declaration is dropped at parse time and the card
     stays a plain, fully legible token surface. */
  --lg-blur:blur(20px) saturate(180%);
  --lg-tint:color-mix(in srgb, var(--dsw-alias-bg-layer-1,#fff) 62%, transparent);
  --lg-tint-soft:color-mix(in srgb, var(--dsw-alias-bg-layer-3,#f1f2f4) 62%, transparent);
  --lg-edge:color-mix(in srgb, var(--dsw-alias-label-primary,#1f2329) 14%, transparent);
  --lg-sheen:linear-gradient(158deg, color-mix(in srgb, #fff 12%, transparent) 0%, transparent 46%);
  --lg-lift:0 10px 30px color-mix(in srgb, #000 20%, transparent),
           inset 0 1px 0 color-mix(in srgb, #fff 30%, transparent),
           inset 0 -1px 0 color-mix(in srgb, #000 7%, transparent);
  position:relative;isolation:isolate}
/* The light the glass refracts. Scoped to this plugin's own subtree and kept
   at inset:0 so it can never add overflow to the official settings dialog. */
.lg-root::before{content:'';position:absolute;inset:0;z-index:-1;pointer-events:none;border-radius:24px;
  background:
    radial-gradient(42% 36% at 14% 3%, color-mix(in srgb, var(--dsw-static-deepseek-500,#4176e6) 44%, transparent), transparent 70%),
    radial-gradient(38% 32% at 90% 14%, color-mix(in srgb, var(--dsw-alias-state-business-primary,#1a3f8f) 38%, transparent), transparent 72%),
    radial-gradient(50% 44% at 56% 100%, color-mix(in srgb, var(--dsw-alias-state-success-primary,#1b5e20) 30%, transparent), transparent 74%);
  filter:blur(10px)}
/*
 * Tab bar = the OFFICIAL segmented-control pattern (the 外观 浅色/深色/跟随系统
 * selector in 通用设置): every item keeps the SAME font and the SAME
 * label-primary colour; selection is a filled background (bg-layer-3) with a
 * stronger border. Dimming the unselected labels and dropping their weight was
 * my own invention and made 2 of 3 tabs look like they had not been themed
 * (user feedback 2026-09-24).
 */
.lg-tabs{display:flex;gap:8px;flex-wrap:wrap}
.lg-tab{font:var(--dsw-font-s-14,14px/22px sans-serif);cursor:pointer;
  color:var(--dsw-alias-label-primary,#1f2329);background:transparent;
  border:0.5px solid var(--dsw-alias-border-l2,#e5e6eb);border-radius:20px;padding:6px 14px;
  backdrop-filter:blur(10px) saturate(150%);-webkit-backdrop-filter:blur(10px) saturate(150%);
  box-shadow:inset 0 1px 0 color-mix(in srgb, #fff 22%, transparent)}
.lg-tab[aria-selected=true]{background:var(--dsw-alias-bg-layer-3,#f1f2f4);
  border-color:var(--dsw-alias-label-tertiary,#adb2b8);
  background-image:var(--lg-sheen);box-shadow:var(--lg-lift)}
.lg-tabbody{display:flex;flex-direction:column;gap:18px}
.lg-card{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e5e6eb);
  border-radius:20px;padding:16px 18px;
  background-color:var(--lg-tint);background-image:var(--lg-sheen);
  border-color:var(--lg-edge);
  backdrop-filter:var(--lg-blur);-webkit-backdrop-filter:var(--lg-blur);
  box-shadow:var(--lg-lift);position:relative}
/* Specular rim: a 1px gradient edge that is bright where the "light" enters
   and fades away from it — the part of Liquid Glass that reads as glass rather
   than as a plain translucent panel. Masked to the border ring only. */
.lg-card::after,.lg-choice::after{content:'';position:absolute;inset:0;border-radius:inherit;padding:1px;
  background:linear-gradient(152deg,
    color-mix(in srgb, #fff 55%, transparent) 0%,
    color-mix(in srgb, #fff 8%, transparent) 38%,
    transparent 62%,
    color-mix(in srgb, #fff 22%, transparent) 100%);
  -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite:exclude;pointer-events:none}
.lg-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.lg-title{font:var(--dsw-font-s-strong-14,500 14px/22px sans-serif);margin:0;
  color:var(--dsw-alias-label-primary,#1f2329)}
.lg-sub{font:var(--dsw-font-xxs-12,12px/18px sans-serif);margin:4px 0 0;
  color:var(--dsw-alias-label-secondary,#6b7280)}
.lg-pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 10px;
  font:var(--dsw-font-xxs-12,12px/18px sans-serif);white-space:nowrap;
  background:var(--dsw-alias-state-success-tertiary,#e8f5e9);color:var(--dsw-alias-state-success-primary,#1b5e20)}
.lg-pill.off{background:var(--dsw-alias-bg-layer-3,#f1f2f4);color:var(--dsw-alias-label-secondary,#6b7280)}
.lg-bar{display:flex;align-items:center;gap:10px;justify-content:space-between;flex-wrap:wrap;margin-top:16px;padding:8px 12px;
  border-radius:var(--dsw-radius-md,12px);font:var(--dsw-font-xs-13,13px/20px sans-serif);
  background:var(--dsw-alias-state-success-tertiary,#e8f5e9);color:var(--dsw-alias-state-success-primary,#1b5e20)}
/* The notice text shrinks and wraps INSIDE itself; the action keeps its
   intrinsic width and never breaks mid-label (user report 2026-09-26: the
   button read "去设置访 / 问密码"). */
/* A non-zero basis keeps the text from collapsing to nothing, so a tight
   container wraps the ACTION to its own line instead of squeezing it. */
.lg-bar>span:first-child{flex:1 1 16ch;min-width:0}
.lg-bar .lg-btn{flex:0 0 auto;white-space:nowrap;height:32px;padding:0 12px;
  font:var(--dsw-font-xs-13,13px/20px sans-serif);font-weight:400}
.lg-bar-compact{margin-top:0;padding:6px 10px}
/*
 * COLOUR RULE FOR EVERY STATUS SURFACE (toast, bar, chip).
 *
 * Measured against DSH 0.1.7's real palette, in BOTH themes (the alias values
 * come from @deepseek-ai/dsh-client-ui-theme):
 *
 *   business-primary on business-tertiary   light 3.60:1  dark 4.39:1   <- fails AA
 *   error-primary    on a 5% hover tint     light ~3:1    dark 3.68:1   <- fails AA
 *   label-primary    on the same surfaces   light 16:1    dark 9.8:1    <- passes
 *
 * Two consequences, applied everywhere below:
 *  1. TEXT is always --dsw-alias-label-primary. A semantic colour is used for
 *     the ICON and the BORDER, where 3:1 is the bar (WCAG 1.4.11), not 4.5:1.
 *  2. A hover TINT is never a surface. --dsw-alias-interactive-bg-hover-danger
 *     resolves to an 8-digit colour with alpha 0x0d (5%), so it is a wash over
 *     whatever sits behind it, not a background. Danger surfaces mix the
 *     semantic colour into bg-layer-1 instead, which stays opaque in both
 *     themes; the solid declaration comes first so an engine without color-mix
 *     keeps a plain, legible token surface.
 */
.lg-bar.info{background:var(--dsw-alias-state-business-tertiary,#e8f0fe);color:var(--dsw-alias-label-primary,#1f2329)}
.lg-bar.warn{background:var(--dsw-alias-state-warn-tertiary,#fffbeb);color:var(--dsw-alias-label-primary,#1f2329)}
.lg-bar.danger{background:var(--dsw-alias-bg-layer-2,#fef2f2);color:var(--dsw-alias-label-primary,#1f2329);
  background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#b91c1c) 12%, var(--dsw-alias-bg-layer-1,#fff))}
/*
 * Transient confirmations live in a FIXED top-right stack, not in the page
 * flow. A bar above the tabs pushed every control down for two seconds, so a
 * save made at the bottom of a long tab looked like the page had jumped and
 * gave no clue whether anything had been saved (user feedback 2026-09-26).
 * A fixed position costs no layout, and pointer-events keeps the empty stack
 * from swallowing clicks on whatever sits underneath it.
 *
 * The toast is a NOTIFICATION, not a pill: a content-sized pill around two
 * characters is easy to miss (same feedback round), so it has a real minimum
 * width, a leading icon, its own close button and a countdown bar. The bar's
 * duration is injected from TOAST_MS, so the animation and the dismissal timer
 * can never disagree.
 */
.lg-toasts{position:fixed;top:16px;right:16px;z-index:2147483001;display:flex;flex-direction:column;gap:8px;
  align-items:flex-end;pointer-events:none;max-width:min(360px,calc(100vw - 32px))}
.lg-toast{pointer-events:auto;box-sizing:border-box;position:relative;overflow:hidden;
  min-width:min(240px,calc(100vw - 32px));padding:12px 14px 14px;border-radius:12px;
  border:1px solid var(--dsw-alias-border-l2,#e5e6eb);box-shadow:0 8px 24px color-mix(in srgb, #000 18%, transparent);
  font:var(--dsw-font-s-14,14px/22px sans-serif);animation:lg-toast-in .16s ease-out}
@keyframes lg-toast-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.lg-toast{animation:none}}
.lg-toast-row{display:flex;align-items:center;gap:10px}
.lg-toast-icon{flex:0 0 auto;font-size:15px;line-height:1}
.lg-toast-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.lg-toast.info{background:var(--dsw-alias-state-business-tertiary,#e8f0fe);color:var(--dsw-alias-label-primary,#1f2329)}
.lg-toast.info .lg-toast-icon{color:var(--dsw-alias-state-business-primary,#1a3f8f)}
.lg-toast.danger{background:var(--dsw-alias-bg-layer-2,#fef2f2);color:var(--dsw-alias-label-primary,#1f2329);
  background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#b91c1c) 12%, var(--dsw-alias-bg-layer-1,#fff));
  border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary,#b91c1c) 38%, transparent)}
.lg-toast.danger .lg-toast-icon{color:var(--dsw-alias-state-error-primary,#b91c1c)}
.lg-toast-x{flex:0 0 auto;border:0;background:transparent;color:inherit;cursor:pointer;opacity:.7;
  font-size:14px;line-height:1;padding:4px 6px;border-radius:6px}
.lg-toast-x:hover{opacity:1}
/* Countdown for an auto-dismissing toast; the duration is set on the element. */
.lg-toast-bar{position:absolute;left:0;bottom:0;height:2px;width:100%;background:currentColor;opacity:.4;
  animation-name:lg-toast-shrink;animation-timing-function:linear;animation-fill-mode:forwards}
@keyframes lg-toast-shrink{from{width:100%}to{width:0}}
@media (prefers-reduced-motion:reduce){.lg-toast-bar{display:none}}
.lg-mono-sm{font:var(--dsw-font-xxs-12,12px/18px sans-serif)}
.lg-mono{margin-top:14px;padding:10px 12px;border-radius:12px;background:var(--dsw-alias-bg-base,#f1f2f4);
  border:1px solid var(--dsw-alias-border-l2,#e5e6eb);
  background-color:color-mix(in srgb, var(--dsw-alias-bg-base,#f1f2f4) 70%, transparent);
  border-color:var(--lg-edge);
  backdrop-filter:blur(12px) saturate(150%);-webkit-backdrop-filter:blur(12px) saturate(150%);
  box-shadow:inset 0 1px 2px color-mix(in srgb, #000 10%, transparent),
             inset 0 1px 0 color-mix(in srgb, #fff 18%, transparent);
  font:var(--dsw-font-xs-13,13px/20px sans-serif);
  font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);
  word-break:break-all;color:var(--dsw-alias-label-primary,#1f2329)}
/* Copyable values (the access URL, the upgrade command) are SINGLE-LINE fields:
   no hard wrapping, horizontal scrolling instead, so a long URL can no longer
   push the rest of the card down (user request 2026-09-26). Scrolling never
   truncates what you get — the copy button writes the source string, never the
   rendered text — and the thin scrollbar makes "there is more to the right"
   visible. Dragging inside the field selects and auto-scrolls, like a text box. */
.lg-mono-scroll{white-space:nowrap;overflow-x:auto;overflow-y:hidden;word-break:normal;
  cursor:text;scrollbar-width:thin}
.lg-mono-scroll::-webkit-scrollbar{height:6px}
.lg-mono-scroll::-webkit-scrollbar-track{background:transparent}
.lg-mono-scroll::-webkit-scrollbar-thumb{border-radius:999px;
  background:color-mix(in srgb, var(--dsw-alias-label-tertiary,#adb2b8) 55%, transparent)}
.lg-row{display:flex;gap:10px;margin-top:12px}
/* auto-fit: two options (TLS) fill the row evenly instead of leaving a third
   of the row empty, and three options (mode) still fit on one line. */
.lg-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin-top:12px}
.lg-choice{text-align:left;cursor:pointer;border-radius:var(--dsw-radius-md,12px);padding:12px 14px;background:var(--dsw-alias-bg-layer-1,#fff);
  border:1px solid var(--dsw-alias-border-l2,#e5e6eb);color:inherit;
  background-color:var(--lg-tint);background-image:var(--lg-sheen);border-color:var(--lg-edge);
  backdrop-filter:var(--lg-blur);-webkit-backdrop-filter:var(--lg-blur);box-shadow:var(--lg-lift);
  position:relative}
.lg-choice[aria-pressed=true]{border:2px solid var(--dsw-static-deepseek-500,#4f46e5);
  background:var(--dsw-alias-interactive-bg-hover,#eef0ff)}
.lg-choice h4{font:var(--dsw-font-s-strong-14,500 14px/22px sans-serif);margin:0 0 6px;
  color:var(--dsw-alias-label-primary,#1f2329)}
.lg-choice p{font:var(--dsw-font-xxs-12,12px/18px sans-serif);margin:0;
  color:var(--dsw-alias-label-secondary,#6b7280)}
.lg-field{display:flex;flex-direction:column;gap:6px;margin-top:14px}
.lg-label{font:var(--dsw-font-s-14,14px/22px sans-serif);color:var(--dsw-alias-label-secondary,#6b7280)}
.lg-input{box-sizing:border-box;height:36px;padding:0 14px;border-radius:var(--dsw-radius-md,12px);border:1px solid var(--dsw-alias-border-l2,#d0d3d9);
  font:var(--dsw-font-s-14,14px/22px sans-serif);
  background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2329);
  background-color:color-mix(in srgb, var(--dsw-alias-bg-base,#fff) 74%, transparent);
  border-color:var(--lg-edge);
  backdrop-filter:blur(12px) saturate(150%);-webkit-backdrop-filter:blur(12px) saturate(150%);
  box-shadow:inset 0 1px 2px color-mix(in srgb, #000 9%, transparent),
             inset 0 1px 0 color-mix(in srgb, #fff 20%, transparent)}
.lg-btn{box-sizing:border-box;height:36px;padding:0 14px;border:0;border-radius:var(--dsw-radius-md,12px);cursor:pointer;
  font:var(--dsw-font-s-14,14px/22px sans-serif);
  /* Brand blue + the official white token (both are official variables): the
     reference implementation's primary action colour, chosen by the user
     2026-09-24 over the theme-dependent near-white default. */
  background:var(--dsw-static-deepseek-500,#4176e6);
  color:var(--dsw-static-neutral-bluish-00,#fff);
  background-image:linear-gradient(180deg, color-mix(in srgb, #fff 22%, transparent), transparent 62%);
  box-shadow:0 6px 18px color-mix(in srgb, var(--dsw-static-deepseek-500,#4176e6) 32%, transparent),
             inset 0 1px 0 color-mix(in srgb, #fff 36%, transparent)}
.lg-btn.secondary{background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-primary,#1f2329);
  border:1px solid var(--dsw-alias-border-l2,#d0d3d9);
  background-color:var(--lg-tint-soft);background-image:var(--lg-sheen);border-color:var(--lg-edge);
  backdrop-filter:blur(12px) saturate(150%);-webkit-backdrop-filter:blur(12px) saturate(150%);
  box-shadow:inset 0 1px 0 color-mix(in srgb, #fff 26%, transparent)}
.lg-btn:disabled{opacity:.55;cursor:not-allowed}
.lg-btn.full{width:100%}
.lg-btn-small{height:28px;padding:0 10px;white-space:nowrap;flex-shrink:0;font:var(--dsw-font-xxs-12,12px/18px sans-serif)}
.lg-toggle{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px;
  font:var(--dsw-font-s-14,14px/22px sans-serif);color:var(--dsw-alias-label-primary,#1f2329)}
.lg-switch{width:48px;height:28px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#d0d3d9);
  background:var(--dsw-alias-bg-layer-3,#f1f2f4);position:relative;cursor:pointer;flex:0 0 auto}
.lg-switch[aria-checked=true]{background:var(--dsw-static-deepseek-500,#4176e6);border-color:transparent}
.lg-switch[aria-checked=true] span{background:var(--dsw-static-neutral-bluish-00,#fff)}
.lg-switch span{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;
  background:var(--dsw-alias-label-primary-foreground,#fff);transition:left .15s}
.lg-switch[aria-checked=true] span{left:23px}
/* The white plate HUGS the code (fit-content + auto margins) instead of
   stretching across the card, and the code is a compact 190px — matching the
   reference implementation's proportions (user feedback 2026-09-24). */
/* Deliberately OPAQUE: a QR code on a translucent plate loses contrast and
   may stop scanning. Never give this rule a glass treatment. */
.lg-qr{margin:14px auto 0;padding:10px;border-radius:12px;background:#fff;
  border:1px solid var(--dsw-alias-border-l2,#e5e6eb);width:fit-content}
.lg-qr svg{display:block;width:190px;height:190px}
.lg-hint{font:var(--dsw-font-xxs-12,12px/18px sans-serif);margin:14px 0 0;
  color:var(--dsw-alias-label-tertiary,#6b7280)}
.lg-lock{display:flex;flex-direction:column;align-items:center;text-align:center;padding:16px 20px 8px;gap:12px}
.lg-lock-emoji{font:var(--dsw-font-xl-24,600 24px/32px sans-serif)}
.lg-lock h3{font:var(--dsw-font-xl-24,600 24px/32px sans-serif);margin:0;
  color:var(--dsw-alias-label-primary,#1f2329)}
.lg-lockpill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:4px 12px;
  font:var(--dsw-font-xs-13,13px/20px sans-serif);
  background:var(--dsw-alias-state-success-tertiary,#e8f5e9);color:var(--dsw-alias-state-success-primary,#1b5e20)}
.lg-lock p{font:var(--dsw-font-s-14,14px/22px sans-serif);margin:0;max-width:560px;
  color:var(--dsw-alias-label-secondary,#6b7280)}
.lg-lock .lg-input{width:100%;text-align:left}
.lg-lock .lg-btn{margin-top:4px}
.lg-update{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.lg-chip{padding:3px 10px;border-radius:999px;background:var(--dsw-alias-state-success-tertiary,#ecfdf5);
  color:var(--dsw-alias-state-success-primary,#059669);font:var(--dsw-font-xxs-12,12px/18px sans-serif)}
.lg-chip.warn{background:var(--dsw-alias-state-business-tertiary,#eff6ff);
  color:var(--dsw-static-deepseek-500,#4176e6)}
.lg-link{color:var(--dsw-alias-label-secondary,#6b7280);text-decoration:none;
  font:var(--dsw-font-xxs-12,12px/18px sans-serif)}
.lg-link:hover{color:var(--dsw-alias-label-primary,#1f2329)}
.lg-update-panel{margin:0;padding:12px;border-radius:var(--dsw-radius-md,12px);
  background:var(--dsw-alias-layer-2,#f1f2f4);border:1px solid var(--dsw-alias-border-l2,#e5e6eb);
  background-color:var(--lg-tint-soft);background-image:var(--lg-sheen);border-color:var(--lg-edge);
  backdrop-filter:blur(14px) saturate(150%);-webkit-backdrop-filter:blur(14px) saturate(150%);
  box-shadow:inset 0 1px 0 color-mix(in srgb, #fff 24%, transparent)}
.lg-update-title{font:var(--dsw-font-s-strong-14,500 14px/22px sans-serif);
  color:var(--dsw-alias-label-primary,#1f2329);margin-bottom:8px}
.lg-sec-title{margin:18px 0 2px;font:var(--dsw-font-s-strong-14,500 14px/22px sans-serif);
  color:var(--dsw-alias-label-secondary,#adb2b8)}
.lg-chip.ok,.lg-chip.wait,.lg-chip.ban{margin-left:5px;flex-shrink:0}
.lg-chip.wait{background:var(--dsw-alias-state-warn-tertiary,#3a2f16);color:var(--dsw-alias-label-primary,#1f2329)}
.lg-chip.ban{background:var(--dsw-static-red-600-a08,#ec13131f);color:var(--dsw-static-red-400,#f25a5a)}
.lg-danger{color:var(--dsw-static-red-400,#f25a5a);border-color:var(--dsw-static-red-400,#f25a5a)}
.lg-device{display:block;margin-top:12px;padding:10px 12px;border-radius:var(--dsw-radius-md,12px);
  background:var(--dsw-alias-bg-base,#f1f2f4);border:1px solid var(--dsw-alias-border-l2,#e5e6eb);
  background-color:var(--lg-tint-soft);border-color:var(--lg-edge);
  backdrop-filter:blur(12px) saturate(150%);-webkit-backdrop-filter:blur(12px) saturate(150%);
  box-shadow:inset 0 1px 0 color-mix(in srgb, #fff 22%, transparent)}
.lg-device-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.lg-name-chip{display:inline-flex;align-items:center;min-width:0}
.lg-device-actions{display:inline-flex;align-items:center;gap:8px;flex-shrink:0}
.lg-device-meta{margin-top:6px;color:var(--dsw-alias-label-tertiary,#979da6);
  font:var(--dsw-font-xxs-12,12px/18px sans-serif)}
.lg-device-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font:var(--dsw-font-s-strong-14,500 14px/22px sans-serif);
  color:var(--dsw-alias-label-primary,#1f2329)}
  color:var(--dsw-alias-label-primary,#1f2329)}
.lg-recover{margin-top:8px;text-align:left;width:100%}
.lg-recover p{font:var(--dsw-font-xs-13,13px/20px sans-serif);margin:0 0 6px;
  color:var(--dsw-alias-label-tertiary,#6b7280)}
.lg-link{border:0;background:transparent;cursor:pointer;padding:2px 6px;
  font:var(--dsw-font-s-14,14px/22px sans-serif);color:var(--dsw-alias-state-error-primary,#b91c1c)}
@media (hover:none) and (pointer:coarse){.lg-btn,.lg-input,.lg-switch,.lg-tab{min-height:44px}}
@media (max-width:620px){.lg-grid{grid-template-columns:1fr}.lg-row{flex-direction:column}}
`.trim()

/** Fetch the settings snapshot. */
async function loadSnapshot(): Promise<ConfigSnapshot> {
  const response = await fetch(CONFIG_PATH, { credentials: 'same-origin', headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`settings request failed: ${String(response.status)}`)
  return await response.json() as ConfigSnapshot
}

/** Send a management write. */
async function postConfig(body: Record<string, unknown>): Promise<ConfigSnapshot> {
  const response = await fetch(CONFIG_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  const parsed = await response.json() as ConfigSnapshot & { error?: string }
  if (!response.ok) throw new Error(parsed.error ?? `settings write failed: ${String(response.status)}`)
  return parsed
}

/**
 * Turn a management refusal into something the operator can act on.
 *
 * The host answers with stable codes; showing `read_only_remote` to a person
 * holding a phone is not an explanation. Anything unrecognised is passed through
 * unchanged, so a new code is still visible instead of being swallowed.
 *
 * @param raw - the error text from the management endpoint.
 * @returns the line the toast shows.
 */
function settingsErrorText(raw: string): string {
  switch (raw) {
    case 'read_only_remote':
      return '当前策略是「仅本机」：远程设备只读，请在电脑上修改'
    case 'admin_required':
      return '需要先解锁管理控制台（「安全认证」里输入管理密码）'
    case 'admin_password_invalid':
      return '管理密码不正确'
    case 'csrf':
      return '请求被跨站校验拒绝，刷新页面后重试'
    case 'current_password_required':
      return '需要先填写当前密码'
    case 'gate_disabled_requires_loopback':
      return '关闭门禁时必须把监听范围改回「仅本机」'
    default:
      return raw
  }
}

/** One card. */
function Card(props: { title?: string; subtitle?: string; right?: ReactElement | null; children?: unknown }): ReactElement {  // A card without a title renders no header at all: the lock card is a single
  // centred block, and a header plus a centred heading duplicated the same
  // sentence (user feedback 2026-09-24).
  return createElement('section', { className: 'lg-card' }, [
    props.title === undefined
      ? null
      : createElement('div', { className: 'lg-head', key: 'head' }, [
        createElement('div', { key: 'titles' }, [
          createElement('h3', { className: 'lg-title', key: 't' }, props.title),
          props.subtitle === undefined
            ? null
            : createElement('p', { className: 'lg-sub', key: 's' }, props.subtitle),
        ]),
        props.right ?? null,
      ]),
    props.children as ReactElement,
  ])
}

/** The three-way big-card selector. */
function ChoiceGrid(props: {
  choices: readonly { id: string; title: string; detail: string }[]
  value: string
  onPick: (id: string) => void
  disabled?: boolean
}): ReactElement {
  return createElement('div', { className: 'lg-grid' }, props.choices.map(choice => createElement(
    'button',
    {
      key: choice.id,
      type: 'button',
      className: 'lg-choice',
      'aria-pressed': props.value === choice.id,
      disabled: props.disabled === true,
      onClick: () => props.onPick(choice.id),
    },
    [
      createElement('h4', { key: 't' }, choice.title),
      createElement('p', { key: 'd' }, choice.detail),
    ],
  )))
}

/**
 * The settings section component.
 *
 * Three tabs (user decision, 2026-09-24) and EXACTLY ONE QR code at any time —
 * the earlier design drew the normal-link QR before a password existed (a code
 * that could only lead to "no password configured") and then added a second
 * one after unlocking, which read as "two QR codes, no idea which one to scan".
 * The single code shown is always one that works:
 *
 * - no access password yet → no QR at all, just the step that unblocks it;
 * - password set, management console locked → the normal link (scan, then type
 *   the password), with a note that unlocking reveals the passwordless code;
 * - unlocked → the passwordless link (scan and you are in).
 */
function SettingsSection(): ReactElement {
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<TabId>('access')
  const [password, setPassword] = useState('')
  const [adminPassword, setAdminPassword] = useState('')
  const [unlockPassword, setUnlockPassword] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [showRecovery, setShowRecovery] = useState(false)
  const [portDraft, setPortDraft] = useState('')
  const [portCheck, setPortCheck] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [doctor, setDoctor] = useState<string[] | null>(null)
  const [doctorBusy, setDoctorBusy] = useState(false)

  // A transient confirmation: a permanent bar costs a whole row of the page
  // for information that is stale a second later (user feedback 2026-09-24).
  //
  // ONE timer, always replaced. Without clearing the previous timeout a second
  // save inside the window would be dismissed early by the FIRST timer — the
  // toast would vanish in a few hundred milliseconds, which is exactly the
  // "did it even save?" doubt this whole component exists to remove.
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearNoticeTimer = useCallback((): void => {
    if (noticeTimer.current !== null) {
      clearTimeout(noticeTimer.current)
      noticeTimer.current = null
    }
  }, [])
  const dismissNotice = useCallback((): void => {
    clearNoticeTimer()
    setNotice(null)
  }, [clearNoticeTimer])
  const flash = useCallback((message: string): void => {
    clearNoticeTimer()
    setNotice(message)
    noticeTimer.current = setTimeout(() => {
      noticeTimer.current = null
      setNotice(null)
    }, TOAST_MS)
  }, [clearNoticeTimer])
  useEffect(() => clearNoticeTimer, [clearNoticeTimer])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setSnapshot(await loadSnapshot())
      setError(null)
    } catch (failure) {
      setError((failure as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const write = useCallback(async (body: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    try {
      await postConfig(body)
      // Re-read instead of trusting the write's own snapshot: that snapshot is
      // computed BEFORE the response's Set-Cookie is stored, so an unlock would
      // otherwise report itself as still locked (and a lock as still unlocked).
      setSnapshot(await loadSnapshot())
      setError(null)
      flash('已保存')
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }, [flash])

  /** Approve / block / unblock a device (F9). */
  const deviceAction = useCallback(async (id: string, action: string): Promise<void> => {
    setBusy(true)
    try {
      await fetch('/plugins/dsh-lan-guard/devices', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ action, id }),
      })
      setSnapshot(await loadSnapshot())
      flash(action === 'approve' ? '已批准' : action === 'block' ? '已拉黑' : '已解除拉黑')
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }, [flash])

  /** Revoke one device. */
  const revokeDevice = useCallback(async (id: string): Promise<void> => {
    setBusy(true)
    try {
      await fetch('/plugins/dsh-lan-guard/devices', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ action: 'revoke', id }),
      })
      setSnapshot(await loadSnapshot())
      flash('已吊销')
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }, [flash])

  /** Ask the host what npm has (SPEC F8). Read-only; the host installs nothing. */
  const loadUpdate = useCallback(async (force: boolean): Promise<void> => {
    setUpdateBusy(true)
    try {
      const response = await fetch(`/plugins/dsh-lan-guard/update${force ? '?force=1' : ''}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      setUpdate(await response.json() as UpdateStatus)
    } catch {
      setUpdate({ current: '?', latest: null, hasUpdate: false, checkedAtMs: null, error: 'unreachable' })
    } finally {
      setUpdateBusy(false)
    }
  }, [])

  useEffect(() => {
    void loadUpdate(false)
  }, [loadUpdate])

  /** Ask the host whether a candidate port is free (loopback-only probe). */
  const checkPort = useCallback(async (candidate: string): Promise<void> => {
    const port = Number.parseInt(candidate, 10)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setPortCheck('请输入 1–65535 之间的端口号')
      return
    }
    setPortCheck('检查中…')
    try {
      const response = await fetch(`/plugins/dsh-lan-guard/port-check?port=${String(port)}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      const body = await response.json() as { available?: boolean }
      setPortCheck(body.available === true ? `端口 ${String(port)} 可用` : `端口 ${String(port)} 已被占用`)
    } catch {
      setPortCheck('检查失败')
    }
  }, [])

  /**
   * Run the on-page half of the connection health check (P5).
   *
   * Everything here is measured in the VISITOR's own browser, which is the only
   * place the interesting facts live: which APIs this engine lacks (that is what
   * leaves a session stuck on 「载入历史…」 with no error), whether the injected
   * patches are present, and how long a real WebSocket handshake to this origin
   * takes. The host's own counters come from the snapshot, not from here.
   */
  const runDoctor = useCallback(async (): Promise<void> => {
    setDoctorBusy(true)
    const lines: string[] = []
    try {
      const patches = (globalThis as { __DSH_LAN_GUARD__?: Record<string, unknown> }).__DSH_LAN_GUARD__ ?? {}
      lines.push(`页面补丁：官方设置页解锁 ${patches.settingsUnlock === true ? '✓' : '—'}`
        + ` · 移动端兼容垫片 ${patches.mobileCompat === true ? '✓' : '—'}`
        + ` · 断线看门狗 ${patches.socketWatchdog === true ? '✓' : '—'}`)
      const missing: string[] = []
      if (typeof AbortSignal.any !== 'function') missing.push('AbortSignal.any')
      if (typeof AbortSignal.timeout !== 'function') missing.push('AbortSignal.timeout')
      if (typeof (Promise as unknown as { withResolvers?: unknown }).withResolvers !== 'function') {
        missing.push('Promise.withResolvers')
      }
      if (typeof (globalThis as { Iterator?: unknown }).Iterator === 'undefined') missing.push('Iterator')
      lines.push(missing.length === 0
        ? '浏览器引擎能力：✓ 会话流需要的 API 齐全'
        : `浏览器引擎能力：缺 ${missing.join('、')}（垫片未生效时，会话记录会停在「载入历史…」且没有报错）`)
      lines.push(`页面来源：${location.origin}${location.origin.startsWith('https://127.0.0.1') || location.origin.startsWith('http://127.0.0.1') ? '（本机回环）' : '（经局域网入口）'}`)
      const agent = navigator.userAgent
      lines.push(`浏览器：${agent.slice(0, 120)}`)

      const started = Date.now()
      const outcome = await new Promise<string>((resolve) => {
        let socket: WebSocket
        try {
          socket = new WebSocket(`${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}/api/remote.mux`)
        } catch (failure) {
          resolve(`✗ 无法创建 WebSocket：${(failure as Error).message}`)
          return
        }
        const timer = setTimeout(() => {
          try { socket.close() } catch { /* already gone */ }
          resolve('✗ 12 秒内没有完成握手（WebKit 后台恢复后卡在 CONNECTING 的典型形状）')
        }, 12_000)
        socket.addEventListener('open', () => {
          clearTimeout(timer)
          resolve(`✓ 握手成功，用时 ${String(Date.now() - started)} ms`)
          try { socket.close() } catch { /* already gone */ }
        })
        socket.addEventListener('error', () => {
          clearTimeout(timer)
          resolve('✗ WebSocket 握手失败（门禁拒绝或证书不受信任）')
        })
        socket.addEventListener('close', (event) => {
          if (event.code === 1006) return // the abnormal path is already reported by open/error
        })
      })
      lines.push(`会话 WebSocket（${location.host}）：${outcome}`)
      const relay = snapshot?.connection
      if (relay !== undefined) {
        lines.push(`代理侧：在活连接 ${String(relay.wsActive)} · 累计升级 ${String(relay.wsUpgrades)}`
          + ` · 被拒 ${String(relay.wsRefused)} · 代答心跳 ${String(relay.heartbeatAnswered)} 次`)
        const last = relay.recent[0]
        if (last !== undefined) {
          lines.push(`最近一条：${last.upgraded ? '已升级' : `被拒 ${String(last.status ?? '?')}`}`
            + ` · 存活 ${String(Math.round(last.durationMs / 1000))}s`
            + ` · 上行 ${String(Math.round(last.bytesToUpstream / 1024))}KB / 下行 ${String(Math.round(last.bytesToVisitor / 1024))}KB`
            + `${last.upgraded && !last.sawCloseFrame ? ' · 异常断开（无 Close 帧）' : ''}`)
        }
      }
      setDoctor(lines)
    } finally {
      setDoctorBusy(false)
    }
  }, [snapshot])

  /** Submit the admin unlock, keeping the button an ENABLED primary action. */
  const submitUnlock = async (): Promise<void> => {
    if (unlockPassword === '') {
      setNotice('请输入访问密码')
      return
    }
    await write({ adminUnlock: unlockPassword })
    setUnlockPassword('')
  }

  if (error !== null && snapshot === null) {
    return createElement('div', { className: 'lg-root' }, [
      createElement('style', { key: 'css' }, CSS),
      createElement(Card, { key: 'card', title: '局域网访问', subtitle: '无法读取设置', children:
        createElement('p', { className: 'lg-hint' }, error) }),
    ])
  }
  if (snapshot === null) {
    return createElement('div', { className: 'lg-root' }, [
      createElement('style', { key: 'css' }, CSS),
      createElement('p', { className: 'lg-hint', key: 'loading' }, '正在读取局域网访问设置…'),
    ])
  }

  const { preferences, authStatus, listener, access } = snapshot
  const running = authStatus.pluginEnabled && authStatus.gateEnabled
  const hasPassword = authStatus.hasPassword
  const unlocked = authStatus.adminUnlocked || preferences.adminPolicy === 'open'
  // First-run bootstrap: with NO password configured there is nothing to
  // protect yet (the gate refuses every device), and the lock card would hide
  // the very form that sets the first password — a deadlock the real DSH
  // environment hit. Locking therefore only starts once a password exists.
  // The server is authoritative: it knows whether this request reached DSH
  // directly on loopback (physical unlock privilege) or through the LAN
  // gateway. Guessing here is what locked the console on the operator's own
  // machine (user feedback 2026-09-24).
  const locked = hasPassword && authStatus.adminRequired === true && !authStatus.adminUnlocked
  const readOnly = authStatus.remoteReadOnly
  // Exactly ONE address is shown, and it is the one the QR encodes, so the
  // page never presents two different links to the same console (user
  // feedback 2026-09-24).
  const scanIsPasswordless = access.tokenUrl !== undefined
  const scanUrl = access.tokenUrl ?? access.selectedUrl

  const copy = (value: string, label: string): void => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(value)
        setCopied(label)
        setTimeout(() => setCopied(null), 1500)
      } catch {
        setNotice('复制失败，请手动选择文本复制')
      }
    })()
  }

  const goSecurity = createElement('button', {
    key: 'go',
    type: 'button',
    className: 'lg-btn secondary',
    onClick: () => setTab('security'),
  }, '去设置访问密码')

  // ---- tab: access -------------------------------------------------------
  const qrBlock = !hasPassword
    ? createElement('div', { className: 'lg-bar warn', key: 'no-password' }, [
      createElement('span', { key: 't' }, '先设置访问密码，然后这里会出现可扫描的二维码。'),
      goSecurity,
    ])
    : access.unavailableReason !== undefined
      ? createElement('div', { className: 'lg-bar warn', key: 'no-url' }, access.unavailableReason)
      : unlocked && access.tokenQrSvg !== undefined
        ? createElement('div', { key: 'token-qr' }, [
          createElement('div', {
            key: 'svg',
            className: 'lg-qr',
            dangerouslySetInnerHTML: { __html: access.tokenQrSvg },
          }),
          createElement('p', { className: 'lg-hint', key: 'l' },
            '上面的地址就是二维码内容：扫码即登录（免密链接，等同于密码）。'
            + '首次访问还要给这台设备命名一次，之后才不用再问。'),
        ])
        : createElement('div', { key: 'normal-qr' }, [
          access.qrSvg === null
            ? null
            : createElement('div', {
              key: 'svg',
              className: 'lg-qr',
              dangerouslySetInnerHTML: { __html: access.qrSvg },
            }),
          createElement('p', { className: 'lg-hint', key: 'l' },
            hasPassword && !unlocked
              ? '扫码后在手机上输入访问密码，首次访问还要给这台设备命名一次。解锁管理控制台后会改为显示免密二维码。'
              : '扫码后在手机上输入访问密码，首次访问还要给这台设备命名一次。'),
        ])

  const accessTab = createElement('div', { className: 'lg-tabbody' }, [
    createElement(Card, {
      key: 'status',
      title: '局域网访问',
      subtitle: '同一 Wi-Fi 下的设备可直接扫码访问',
      right: createElement('span', { className: running ? 'lg-pill' : 'lg-pill off' }, running ? '运行中' : '已停止'),
      children: [
        createElement('div', { className: hasPassword ? 'lg-bar' : 'lg-bar warn', key: 'bar' }, [
          createElement('span', { key: 'txt' }, hasPassword
            ? (listener.listenHost === '127.0.0.1'
              ? '🛡️ 访问安全认证已生效（当前仅本机可访问）'
              : '🛡️ 访问安全认证已生效')
            : (listener.listenHost === '127.0.0.1'
              ? '⚠️ 尚未设置访问密码，门禁不会放行任何设备'
              // Exposed AND passwordless: the gate still refuses everyone, but
              // the operator must know the port is visible on the network.
              : `⚠️ 端口已对局域网开放（${String(listener.listenPort)}），但尚未设置访问密码：`
                + '门禁此刻拒绝所有设备，不会泄露数据；请先设置访问密码')),
          hasPassword ? null : goSecurity,
        ]),
        createElement('div', {
          className: 'lg-mono lg-mono-scroll',
          key: 'url',
          title: scanUrl ?? '',
        }, scanUrl ?? '—'),
        createElement('div', { className: 'lg-row', key: 'copy' }, [
          createElement('button', {
            key: 'c',
            type: 'button',
            className: 'lg-btn secondary',
            disabled: scanUrl === null,
            onClick: () => copy(scanUrl ?? '', 'link'),
          }, copied === 'link' ? '已复制' : '复制链接'),
          scanIsPasswordless
            ? createElement('button', {
              key: 'r',
              type: 'button',
              className: 'lg-btn secondary',
              disabled: busy,
              onClick: () => void write({ rotateToken: true }),
            }, '重新生成')
            : null,
        ].filter(Boolean) as ReactElement[]),
        qrBlock,
        createElement('p', { className: 'lg-hint', key: 'private' }, '请在私密环境下使用'),
        createElement('p', { className: 'lg-hint', key: 'pwa' },
          '📱 提示：手机浏览器扫码打开后，在菜单点击「添加到主屏幕」即可作为独立全屏 App 运行。'),
      ],
    }),
  ])

  // ---- shared lock card --------------------------------------------------
  const lockCard = createElement(Card, {
    key: 'lock',
    children: createElement('div', { className: 'lg-lock' }, [
      createElement('div', { className: 'lg-lock-emoji', key: 'icon' }, '🔒'),
      createElement('h3', { key: 't' }, '管理控制台已锁定'),
      createElement('span', { className: 'lg-lockpill', key: 'pill' }, '🔑 使用访问密码解锁'),
      createElement('p', { key: 'p' },
        authStatus.hasAdminPassword
          ? '为保护你的网络与平台安全，修改验证方式与证书设置前需要先解锁管理控制台。'
          : '为保护你的网络与平台安全，当前未设置独立管理密码，输入访问密码即可解锁。'),
      createElement('input', {
        key: 'i',
        className: 'lg-input',
        type: 'password',
        autoComplete: 'current-password',
        placeholder: '输入访问密码',
        value: unlockPassword,
        onChange: (event: { target: { value: string } }) => setUnlockPassword(event.target.value),
        onKeyDown: (event: { key: string }) => {
          if (event.key === 'Enter') void submitUnlock()
        },
      }),
      createElement('button', {
        key: 'b',
        type: 'button',
        className: 'lg-btn full',
        disabled: busy,
        onClick: () => void submitUnlock(),
      }, '解锁管理权限'),
      createElement('button', {
        key: 'forgot',
        type: 'button',
        className: 'lg-link',
        onClick: () => setShowRecovery(!showRecovery),
      }, '❓ 忘记访问密码？'),
      showRecovery
        ? createElement('div', { className: 'lg-recover', key: 'recover' }, [
          createElement('p', { key: 't' }, '🛟 找回与重置访问密码指引：'),
          createElement('p', { key: 'a' },
            '1. 电脑本机直连修改：在运行本程序的电脑上直接打开本控制台（127.0.0.1 享有免锁特权），可随时修改或清除密码。'),
          createElement('p', { key: 'b' },
            '2. 无头 / 服务器环境：删除插件私有目录（配置项 dataDir）下的 secrets.json 后重新设置；'
            + '删除后门禁会重新拒绝所有设备，直到你设置新密码。'),
        ])
        : null,
    ]),
  })

  // ---- tab: security -----------------------------------------------------
  const securityTab = createElement('div', { className: 'lg-tabbody' }, locked ? [lockCard] : [
    createElement(Card, {
      key: 'security',
      title: '安全认证',
      subtitle: '决定谁能通过代理端口进入 DSH',
      children: [
        createElement('p', { className: 'lg-hint', key: 'pw-explain' },
          '访问密码 = 手机等访客设备登录用；管理密码 = 解锁本设置页的管理台用（未设置时退回访问密码）。'),
        createElement(ChoiceGrid, {
          key: 'mode',
          choices: MODE_CHOICES,
          value: preferences.mode,
          disabled: busy,
          onPick: (id: string) => void write({ preferences: { mode: id } }),
        }),
        createElement('div', { className: 'lg-field', key: 'pw' }, [
          createElement('span', { className: 'lg-label', key: 'l' },
            authStatus.hasPassword ? '访问密码：已设置（不会回显）' : '访问密码：未设置'),
          createElement('input', {
            key: 'i',
            className: 'lg-input',
            type: 'password',
            autoComplete: 'new-password',
            placeholder: '输入新的访问密码（至少 8 位）',
            value: password,
            disabled: busy,
            onChange: (event: { target: { value: string } }) => setPassword(event.target.value),
          }),
          createElement('button', {
            key: 'b',
            type: 'button',
            className: 'lg-btn',
            disabled: busy || password === '',
            onClick: () => {
              void write({ setPassword: { next: password } }).then(() => setPassword(''))
            },
          }, '设置访问密码'),
        ]),
        createElement('div', { className: 'lg-field', key: 'admin' }, [
          createElement('span', { className: 'lg-label', key: 'l' },
            authStatus.hasAdminPassword ? '管理密码：已设置（不会回显）' : '管理密码：未设置（退回访问密码）'),
          createElement('input', {
            key: 'i',
            className: 'lg-input',
            type: 'password',
            autoComplete: 'new-password',
            placeholder: '输入新的管理密码（至少 8 位）',
            value: adminPassword,
            disabled: busy,
            onChange: (event: { target: { value: string } }) => setAdminPassword(event.target.value),
          }),
          createElement('button', {
            key: 'b',
            type: 'button',
            className: 'lg-btn secondary',
            disabled: busy || adminPassword === '',
            onClick: () => {
              void write({ setAdminPassword: { next: adminPassword } }).then(() => setAdminPassword(''))
            },
          }, '设置管理密码'),
        ]),
        createElement('div', { className: 'lg-toggle', key: 'loopback' }, [
          createElement('span', { key: 'l' }, '本机回环访问免密'),
          createElement('button', {
            key: 's',
            type: 'button',
            className: 'lg-switch',
            'aria-checked': preferences.allowLoopback,
            disabled: busy,
            onClick: () => void write({ preferences: { allowLoopback: !preferences.allowLoopback } }),
          }, createElement('span', null)),
        ]),
        // The management policy had NO control at all until 2026-09-26: the
        // host accepted the write and the README promised the switch, but
        // POLICY_CHOICES was dead code, so `adminPolicy` could only be changed
        // by hand-editing the profile patch. It is load-bearing for the remote
        // workspace picker, which needs `password_unlock` or `open` to serve a
        // LAN device at all.
        createElement('div', { className: 'lg-field', key: 'policy' }, [
          createElement('span', { className: 'lg-label', key: 'l' }, '远程设备管理权限'),
          createElement('p', { className: 'lg-hint', key: 'd' },
            '「仅本机」下局域网设备只读；想让它们在手机上浏览目录并添加工作区，选「密码解锁」（需先解锁）或「不锁定」。'),
          createElement(ChoiceGrid, {
            key: 'g',
            choices: POLICY_CHOICES,
            value: preferences.adminPolicy,
            disabled: busy,
            onPick: (id: string) => void write({ preferences: { adminPolicy: id } }),
          }),
        ]),
        createElement('div', { className: 'lg-toggle', key: 'admin-protection' }, [
          createElement('span', { key: 'l' }, '管理操作需要先解锁'),
          createElement('button', {
            key: 's',
            type: 'button',
            className: 'lg-switch',
            'aria-checked': preferences.adminProtection,
            disabled: busy,
            onClick: () => void write({ preferences: { adminProtection: !preferences.adminProtection } }),
          }, createElement('span', null)),
        ]),
        createElement('p', { className: 'lg-hint', key: 'h' },
          '密码仅以 PBKDF2-SHA256 哈希存储于插件私有目录，绝不写入配置文件，也不会回显。'),
      ],
    }),
  ])

  // ---- tab: devices (P4-g) ----------------------------------------------
  const when = (ms: number | null): string => (ms === null ? '—' : new Date(ms).toLocaleString('zh-CN'))
  const deviceGroups = [
    { key: 'pending', title: '待批准', list: snapshot.devices.filter(entry => entry.status === 'pending') },
    { key: 'approved', title: '已授权', list: snapshot.devices.filter(entry => entry.status === 'approved') },
    { key: 'blocked', title: '已拉黑', list: snapshot.devices.filter(entry => entry.status === 'blocked') },
  ]
  const statusChip = (status: string): ReactElement => createElement('span', {
    className: status === 'blocked' ? 'lg-chip ban' : status === 'pending' ? 'lg-chip wait' : 'lg-chip ok',
  }, status === 'blocked' ? '已拉黑' : status === 'pending' ? '待批准' : '已批准')
  const devButton = (label: string, action: string, id: string, danger: boolean): ReactElement =>
    createElement('button', {
      type: 'button',
      className: danger ? 'lg-btn secondary lg-btn-small lg-danger' : 'lg-btn lg-btn-small',
      disabled: busy,
      onClick: () => void deviceAction(id, action),
    }, label)
  const devicesTab = createElement('div', { className: 'lg-tabbody' }, locked ? [lockCard] : [
    createElement(Card, {
      key: 'devices',
      title: '已授权设备',
      subtitle: '每个设备一条独立身份，可逐个批准、吊销与拉黑',
      children: [
        createElement('p', { className: 'lg-hint', key: 'explain' },
          '手机第一次通过门禁时会显示配对页，让你给这台设备命名；命名后它就会出现在下面。'),
        createElement('div', { className: 'lg-toggle', key: 'pairing' }, [
          createElement('span', { key: 'l' }, '新设备需要命名确认'),
          createElement('button', {
            key: 's',
            type: 'button',
            className: 'lg-switch',
            'aria-checked': preferences.requirePairing,
            disabled: busy,
            onClick: () => void write({ preferences: { requirePairing: !preferences.requirePairing } }),
          }, createElement('span', null)),
        ]),
        createElement('div', { className: 'lg-toggle', key: 'approval' }, [
          createElement('span', { key: 'l' }, '新设备需要管理员批准'),
          createElement('button', {
            key: 's',
            type: 'button',
            className: 'lg-switch',
            'aria-checked': preferences.requireApproval,
            disabled: busy,
            onClick: () => void write({ preferences: { requireApproval: !preferences.requireApproval } }),
          }, createElement('span', null)),
        ]),
        createElement('p', { className: 'lg-hint', key: 'approval-hint' },
          '开启「管理员批准」后：手机完成命名 → 进入「待批准」，你在下面点「批准」它才能访问；'
          + '「拒绝并拉黑」作废的是这台设备的身份：它在这个浏览器里会被一直拒绝，'
          + '但清掉浏览器数据或换一个浏览器后，仍可用密码重新配对——要彻底挡住，请同时更换访问密码。'),
        snapshot.pendingCount > 0
          ? createElement('div', { className: 'lg-bar warn', key: 'pending-bar' },
            `🔔 有 ${String(snapshot.pendingCount)} 台新设备等待批准`)
          : null,
        snapshot.devices.length === 0
          ? createElement('p', { className: 'lg-hint', key: 'empty' }, '暂无已授权设备。')
          : createElement('div', { key: 'groups' }, deviceGroups
            .filter(group => group.list.length > 0)
            .map(group => createElement('div', { key: group.key }, [
              createElement('div', { key: 't', className: 'lg-sec-title' },
                `${group.title}（${String(group.list.length)}）`),
              ...group.list.map(device => createElement('div', { key: device.id, className: 'lg-device' }, [
                createElement('div', { key: 'head', className: 'lg-device-head' }, [
                  createElement('span', { key: 'nc', className: 'lg-name-chip' }, [
                    createElement('span', { key: 'n', className: 'lg-device-name' }, device.label),
                    statusChip(device.status),
                  ]),
                  createElement('span', { key: 'a', className: 'lg-device-actions' },
                    device.status === 'pending'
                      ? [devButton('批准', 'approve', device.id, false), devButton('拒绝并拉黑', 'block', device.id, true)]
                      : device.status === 'blocked'
                        ? [devButton('解除拉黑', 'unblock', device.id, false)]
                        : [devButton('吊销并拉黑', 'block', device.id, true)]),
                ]),
                createElement('div', { key: 'd', className: 'lg-device-meta' },
                  `创建 ${when(device.createdAtMs)} · 最近使用 ${when(device.lastSeenAtMs)}`
                  + ` · 来源 ${device.lastIp ?? '—'}`),
              ])),
            ]))),
      ],
    }),
  ])

  // ---- tab: connection ---------------------------------------------------
  const connectionTab = createElement('div', { className: 'lg-tabbody' }, locked ? [lockCard] : [
    // Mobile resilience (2026-09-28). Both halves are measured facts, not
    // guesses: DSH reaps a mux socket 6 s after its Pings stop being answered,
    // and a phone that leaves Safari cannot answer them; and WebKit can leave a
    // resumed page with a WebSocket that never opens again.
    createElement(Card, {
      key: 'mobile',
      title: '手机连接与自愈',
      subtitle: '长连接为什么会断，以及断了以后怎么恢复',
      children: [
        createElement('p', { className: 'lg-hint', key: 'why' },
          '会话记录（「载入历史…」那一段）只走 WebSocket：DSH 每 2 秒发一次心跳，'
          + '连续两次没被回应就断开——实测 6 秒。手机锁屏或切走时页面被系统挂起，回不了心跳，'
          + '于是会话就会「载入不全、甚至断开」。下面三项默认开启，逐项都可以关。'),
        createElement('div', { className: 'lg-field', key: 'heartbeat' }, [
          createElement('div', { className: 'lg-toggle', key: 't' }, [
            createElement('span', { key: 'l' }, '代理代答心跳'),
            createElement('button', {
              key: 's',
              type: 'button',
              className: 'lg-switch',
              'aria-checked': preferences.answerHeartbeat,
              disabled: busy,
              onClick: () => void write({ preferences: { answerHeartbeat: !preferences.answerHeartbeat } }),
            }, createElement('span', null)),
          ]),
          createElement('p', { className: 'lg-hint', key: 'h' },
            '手机挂起期间由代理替它回心跳，宿主就不再回收这条连接（已实测：停回心跳 6 秒被切断 vs 代答后 20 秒以上存活）。'
            + '手机自己回的心跳到达时是重复包，没有副作用。'),
        ]),
        createElement('div', { className: 'lg-field', key: 'watchdog' }, [
          createElement('div', { className: 'lg-toggle', key: 't' }, [
            createElement('span', { key: 'l' }, '断线看门狗（页面补丁）'),
            createElement('button', {
              key: 's',
              type: 'button',
              className: 'lg-switch',
              'aria-checked': preferences.socketWatchdog,
              disabled: busy,
              onClick: () => void write({ preferences: { socketWatchdog: !preferences.socketWatchdog } }),
            }, createElement('span', null)),
          ]),
          createElement('p', { className: 'lg-hint', key: 'h' },
            '卡在「连接中」超过 8 秒的 WebSocket 会被关掉；从后台回来 10 秒后仍然一条都没连上时，'
            + '页面自动重载一次（每标签最多连续 3 次，冷却 20 秒起）。只影响真的连不上的页面。'),
        ]),
        createElement('div', { className: 'lg-field', key: 'compat' }, [
          createElement('div', { className: 'lg-toggle', key: 't' }, [
            createElement('span', { key: 'l' }, '移动端兼容垫片'),
            createElement('button', {
              key: 's',
              type: 'button',
              className: 'lg-switch',
              'aria-checked': preferences.mobileCompat,
              disabled: busy,
              onClick: () => void write({ preferences: { mobileCompat: !preferences.mobileCompat } }),
            }, createElement('span', null)),
          ]),
          createElement('p', { className: 'lg-hint', key: 'h' },
            '为老引擎补 AbortSignal.any / AbortSignal.timeout / Promise.withResolvers / Iterator，'
            + '并补上移动端 meta。缺这些 API 时 DSH 客户端会在会话流里抛错，'
            + '而界面上只会一直显示「载入历史…」、连报错都没有。现代浏览器上这些分支不生效。'),
        ]),
        createElement('div', { className: 'lg-field', key: 'scrollfix' }, [
          createElement('div', { className: 'lg-toggle', key: 't' }, [
            createElement('span', { key: 'l' }, '手机滚动矫正（窄屏）'),
            createElement('button', {
              key: 's',
              type: 'button',
              className: 'lg-switch',
              'aria-checked': preferences.mobileScrollFix,
              disabled: busy,
              onClick: () => void write({ preferences: { mobileScrollFix: !preferences.mobileScrollFix } }),
            }, createElement('span', null)),
          ]),
          createElement('p', { className: 'lg-hint', key: 'h' },
            '手机上 DSH 自己的外壳会把对话列压在固定的输入框/目标条/快捷回复浮层后面，导致内容可见但**滑不动**'
            + '（同一视口在桌面 Chrome 里能滚，属 iOS 布局/触摸差异）。开启后，页面会在「整页不可滚 + 发现被裁剪的层」时'
            + '把那几层改成可触摸滚动；能正常滚动的页面一律不碰。打开页面时加 ?lgdiag=1 会显示一屏布局诊断。'),
        ]),
        createElement('div', { className: 'lg-row', key: 'doctor' }, [
          createElement('button', {
            key: 'b',
            type: 'button',
            className: 'lg-btn',
            disabled: doctorBusy,
            onClick: () => void runDoctor(),
          }, doctorBusy ? '体检中…' : '运行连接体检'),
        ]),
        createElement('p', { className: 'lg-hint', key: 'doctor-hint' },
          '体检在这个浏览器里跑：检查引擎缺哪些 API、页面拿到了哪些补丁，并对本页地址做一次真实的 WebSocket 握手。'),
        doctor === null
          ? null
          : createElement('div', { className: 'lg-mono lg-mono-sm', key: 'doctor-out' },
            doctor.map((line, index) => createElement('div', { key: `l${String(index)}` }, line))),
      ],
    }),
    createElement(Card, {
      key: 'connection',
      title: '连接与证书',
      subtitle: '监听范围、端口与传输安全',
      children: [
        createElement('div', { className: 'lg-mono', key: 'ports' },
          `代理端口 ${String(listener.listenPort)} → 上游 ${listener.upstreamOrigin}`),
        listener.portFallback
          ? createElement('div', { className: 'lg-bar warn', key: 'port-busy' },
            `配置的端口 ${String(listener.configuredPort ?? '?')} 已被占用，已自动改用 ${String(listener.listenPort)}。`
            + '可在下面改端口，或先关掉占用它的程序。')
          : null,
        // The bind scope comes first because it is the most consequential
        // setting on this page: it decides whether the LAN can reach the port
        // at all. Both choices keep the gate and TLS in force — this is not a
        // "security off" switch.
        createElement('div', { className: 'lg-field', key: 'scope' }, [
          createElement('span', { className: 'lg-label', key: 'l' }, '监听范围（修改后需重启 dsh 生效）'),
          createElement(ChoiceGrid, {
            key: 'g',
            choices: [
              {
                id: '0.0.0.0',
                title: '局域网（默认）',
                detail: '手机等同网段设备可访问；门禁与自签 HTTPS 全程生效',
              },
              {
                id: '127.0.0.1',
                title: '仅本机',
                detail: '只有这台电脑能访问；手机扫码会连不上（更保守）',
              },
            ],
            value: listener.listenHost,
            disabled: busy,
            onPick: (id: string) => void write({ preferences: { listenHost: id } }),
          }),
          listener.listenHost === '0.0.0.0' || listener.listenHost === '127.0.0.1'
            ? null
            : createElement('span', { className: 'lg-label', key: 'custom' },
              `当前为自定义监听地址 ${listener.listenHost}（在 profile patch 中设置）；选择上面任一项会覆盖它。`),
          listener.listenHost === '127.0.0.1'
            ? null
            : createElement('p', { className: 'lg-hint', key: 'scope-hint' },
              '对外可达不等于可以进入：未设访问密码时，门禁拒绝所有设备；已设密码则需通过门禁。'
              + '若只在固定网卡上公布，可在 profile patch 里把 listenHost 写成该网卡 IP。'),
        ]),
        // DSH's OFFICIAL settings surface is loopback-only: any page whose
        // address bar is not 127.0.0.1/localhost gets `persistence = "memory"`,
        // so Settings → Models reports "settings are unavailable in this
        // browser" on every LAN device. This switch puts DSH's own `ownsHost`
        // flag into the served index, which is what the desktop shell sets, so
        // those pages work through the gateway too.
        createElement('div', { className: 'lg-field', key: 'settings-unlock' }, [
          createElement('div', { className: 'lg-toggle', key: 't' }, [
            createElement('span', { key: 'l' }, '局域网设备可用官方设置页'),
            createElement('button', {
              key: 's',
              type: 'button',
              className: 'lg-switch',
              'aria-checked': preferences.settingsUnlock,
              disabled: busy,
              onClick: () => void write({ preferences: { settingsUnlock: !preferences.settingsUnlock } }),
            }, createElement('span', null)),
          ]),
          createElement('p', { className: 'lg-hint', key: 'h' },
            '开启后（默认开启），通过门禁的设备——手机也一样——刷新页面即可使用 DSH 官方「模型」等设置页；'
            + '关闭则恢复 DSH 默认：非本机访问会看到「settings are unavailable in this browser」。'
            + '这是界面解锁而非新增权限：设置接口本来就只由门禁把关，读取密钥仍由 DSH 脱敏。'),
          createElement('span', { className: 'lg-label', key: 'reload' }, '切换后刷新页面生效，无需重启 dsh。'),
        ]),
        createElement('div', { className: 'lg-field', key: 'port' }, [
          createElement('span', { className: 'lg-label', key: 'l' }, '代理端口（修改后需重启 dsh 生效）'),
          createElement('div', { className: 'lg-row', key: 'r' }, [
            createElement('input', {
              key: 'i',
              className: 'lg-input',
              type: 'number',
              min: 1,
              max: 65535,
              value: portDraft === '' ? String(listener.configuredPort ?? listener.listenPort) : portDraft,
              disabled: busy,
              onChange: (event: { target: { value: string } }) => {
                setPortDraft(event.target.value)
                setPortCheck(null)
              },
              onBlur: () => void checkPort(
                portDraft === '' ? String(listener.configuredPort ?? listener.listenPort) : portDraft,
              ),
            }),
            createElement('button', {
              key: 'b',
              type: 'button',
              className: 'lg-btn',
              disabled: busy || portDraft === ''
                || portDraft === String(listener.configuredPort ?? listener.listenPort),
              onClick: () => {
                void write({ preferences: { listenPort: Number.parseInt(portDraft, 10) } })
                  .then(() => { setPortDraft(''); setPortCheck(null) })
              },
            }, '保存端口'),
          ]),
          portCheck === null ? null : createElement('span', { className: 'lg-label', key: 'c' }, portCheck),
          createElement('span', { className: 'lg-label', key: 'h' },
            `默认 ${String(DEFAULT_PORT_HINT)}；被占用时会自动依次往后找可用端口（最多试 ${String(10)} 个）。`),
        ]),
        createElement('div', { className: 'lg-field', key: 'nic' }, [
          createElement('span', { className: 'lg-label', key: 'l' }, '对外公布的网卡'),
          createElement('select', {
            key: 's',
            className: 'lg-input',
            value: preferences.networkInterface,
            disabled: busy,
            onChange: (event: { target: { value: string } }) =>
              void write({ preferences: { networkInterface: event.target.value } }),
          }, [
            createElement('option', { key: 'auto', value: '' }, '自动选择（优先真实网卡）'),
            ...access.addresses.map(entry => createElement('option', {
              key: `${entry.interface}:${entry.address}`,
              value: entry.interface,
            }, `${entry.interface} · ${entry.address}${entry.virtual ? `（虚拟：${entry.virtualReason ?? '未知'}）` : ''}`)),
          ]),
        ]),
        createElement('p', { className: 'lg-hint', key: 'nic-hint' },
          '二维码与访问地址随此处选择即时刷新；虚拟网卡通常无法被手机访问。'),
        createElement(ChoiceGrid, {
          key: 'tls',
          choices: [
            { id: 'self-signed', title: '自签 HTTPS（默认）', detail: '手机需一次性信任自签 CA' },
            { id: 'off', title: '关闭 HTTPS', detail: '局域网内明文传输，仅建议在完全可信的网络中使用' },
          ],
          value: 'self-signed',
          disabled: busy,
          onPick: () => setNotice('TLS 切换在 P3 提供'),
        }),
        access.tlsMode === 'off'
          ? createElement('div', { className: 'lg-bar danger', key: 'tls-off' }, [
            createElement('span', { key: 't' },
              '⚠️ 已关闭 HTTPS：局域网内为明文传输，门禁密码与上游 cookie 可能被同网段嗅探；'
              + '浏览器部分能力（剪贴板、Service Worker）不可用。仅建议在完全可信的私有网络中使用。'),
          ])
          : null,
        access.caFingerprint === null
          ? null
          : createElement('div', { className: 'lg-mono lg-mono-sm', key: 'ca' },
            `自签 CA 指纹（SHA-256）：${access.caFingerprint}`),
        access.caFingerprint === null
          ? null
          : createElement('p', { className: 'lg-hint', key: 'ca-hint' },
            '手机首次访问需先安装并信任该 CA（README 中有指引）；CA 身份跨重启不变，换 IP 只重签叶证书。'),
        createElement('p', { className: 'lg-hint', key: 'nets' },
          `检测到 ${String(access.addresses.length)} 个可用地址${access.addresses.some(a => a.virtual) ? '（含虚拟网卡，已降权）' : ''}。`),
      ],
    }),
  ])

  // Only meaningful for a REMOTE session that had to unlock; the operator's own
  // machine is never locked, so the banner there is pure noise.
  const unlockBanner = authStatus.adminUnlocked && !locked && authStatus.localAccess === false
    ? createElement('div', { className: 'lg-bar info lg-bar-compact', key: 'unlocked' }, [
      createElement('span', { key: 't' }, '🔓 已解锁：本次会话内可直接修改下方设置'),
      createElement('button', {
        key: 'b',
        type: 'button',
        className: 'lg-btn secondary lg-btn-small',
        onClick: () => void write({ adminLock: true }),
      }, '重新锁定'),
    ])
    : null

  const readOnlyBanner = readOnly
    ? createElement('div', { className: 'lg-bar warn', key: 'readonly' },
      '当前为远程访问（只读）：请在运行本程序的电脑上打开本控制台修改——127.0.0.1 享有免锁特权。')
    : null

  // Update detection chip + panel (SPEC F8). Read-only: the host never installs
  // anything; it reports and offers a copyable command.
  const repoUrl = 'https://github.com/idoall/dsh-lan-guard'
  const updateChip = createElement('div', { className: 'lg-update', key: 'update' }, [
    createElement('span', {
      key: 'v',
      className: update !== null && update.hasUpdate ? 'lg-chip warn' : 'lg-chip',
    }, update === null
      ? '检查更新…'
      : update.error !== null
        ? `v${update.current} · 检查失败`
        : update.hasUpdate
          ? `v${update.current} ➔ v${String(update.latest)}`
          : `v${update.current} ✓ 最新`),
    createElement('button', {
      key: 'b',
      type: 'button',
      className: 'lg-btn secondary lg-btn-small',
      disabled: updateBusy,
      onClick: () => void loadUpdate(true),
    }, updateBusy ? '检查中…' : '检查更新'),
    createElement('a', { key: 'g', className: 'lg-link', href: repoUrl, target: '_blank', rel: 'noreferrer' }, 'GitHub'),
    createElement('a', {
      key: 'c',
      className: 'lg-link',
      href: `${repoUrl}/blob/main/CHANGELOG.md`,
      target: '_blank',
      rel: 'noreferrer',
    }, '更新日志'),
    createElement('a', {
      key: 'i',
      className: 'lg-link',
      href: `${repoUrl}/issues`,
      target: '_blank',
      rel: 'noreferrer',
    }, '反馈 Issue'),
  ])

  const updatePanel = update === null || !update.hasUpdate
    ? null
    : createElement('div', { className: 'lg-update-panel', key: 'updatepanel' }, [
      createElement('div', { key: 't', className: 'lg-update-title' },
        `发现新版本 v${String(update.latest)}（当前 v${update.current}）`),
      createElement('div', {
        key: 'c',
        className: 'lg-mono lg-mono-scroll',
        title: `dsh plugin --profile web add dsh-lan-guard@${String(update.latest)}`,
      }, `dsh plugin --profile web add dsh-lan-guard@${String(update.latest)}`),
      createElement('div', { className: 'lg-row', key: 'r' }, [
        createElement('button', {
          key: 'cp',
          type: 'button',
          className: 'lg-btn secondary',
          onClick: () => copy(`dsh plugin --profile web add dsh-lan-guard@${String(update.latest)}`, 'update'),
        }, copied === 'update' ? '已复制' : '复制命令'),
      ]),
      createElement('p', { key: 'h', className: 'lg-hint' },
        '本插件不会自动安装，也不会重启 dsh：执行上面的命令后，需要你手动重启一次 dsh 才生效。'),
    ])

  const tabBar = createElement('div', { className: 'lg-tabs', role: 'tablist', key: 'tabs' },
    TABS.map(entry => createElement('button', {
      key: entry.id,
      type: 'button',
      role: 'tab',
      className: 'lg-tab',
      'aria-selected': tab === entry.id,
      onClick: () => setTab(entry.id),
    }, entry.label)))

  return createElement('div', { className: 'lg-root' }, [
    createElement('style', { key: 'css' }, CSS),
    // Feedback is a fixed top-right toast: it costs no layout, so a save at the
    // bottom of a long tab no longer makes the page jump.
    (error === null && notice === null)
      ? null
      : createElement('div', { className: 'lg-toasts', key: 'toasts' }, [
        error === null ? null : createElement('div', {
          className: 'lg-toast danger',
          role: 'alert',
          key: 'err',
        }, [
          createElement('div', { className: 'lg-toast-row', key: 'row' }, [
            createElement('span', { className: 'lg-toast-icon', key: 'i' }, '⚠'),
            createElement('span', { className: 'lg-toast-text', key: 't' }, settingsErrorText(error)),
            createElement('button', {
              key: 'x',
              type: 'button',
              className: 'lg-toast-x',
              'aria-label': '关闭',
              onClick: () => {
                setError(null)
              },
            }, '✕'),
          ]),
        ]),
        notice === null ? null : createElement('div', {
          className: 'lg-toast info',
          role: 'status',
          key: 'ok',
        }, [
          createElement('div', { className: 'lg-toast-row', key: 'row' }, [
            createElement('span', { className: 'lg-toast-icon', key: 'i' }, '✓'),
            createElement('span', { className: 'lg-toast-text', key: 't' }, notice),
            createElement('button', {
              key: 'x',
              type: 'button',
              className: 'lg-toast-x',
              'aria-label': '关闭',
              onClick: dismissNotice,
            }, '✕'),
          ]),
          // The countdown bar is decorative: the close button is the accessible
          // way out, so screen readers get no second "progress" element.
          createElement('span', {
            className: 'lg-toast-bar',
            key: 'bar',
            'aria-hidden': true,
            style: { animationDuration: `${String(TOAST_MS)}ms` },
          }),
        ]),
      ].filter(Boolean) as ReactElement[]),
    unlockBanner,
    readOnlyBanner,
    updateChip,
    updatePanel,
    tabBar,
    tab === 'access'
      ? accessTab
      : tab === 'security' ? securityTab : tab === 'devices' ? devicesTab : connectionTab,
  ].filter(Boolean) as ReactElement[])
}

/** Default port shown as a hint in the port field. */
const DEFAULT_PORT_HINT = 3081

/**
 * How long a transient confirmation stays on screen.
 *
 * The single source of truth: the countdown bar's `animation-duration` is
 * injected from this value, so the bar can never outlive (or predecease) the
 * dismissal timer.
 */
const TOAST_MS = 2600

/**
 * Register the settings section.
 *
 * @param ctx - the client plugin context (injects `slots`).
 */
export function apply(ctx: {
  slots: {
    inject(seat: string, callback: () => unknown): unknown
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  get?(name: string): unknown
  effect?(callback: () => () => void): unknown
}): void {
  ctx.slots.inject(SEAT, () => ctx.slots.register(
    { name: SEAT, id: PLUGIN_ID, order: 100, label: '局域网访问' },
    SettingsSection,
  ))
  // The remote workspace picker: an independent second client contribution.
  // It shadows the official directory-flow occupant for REMOTE browsers only
  // (see client/workspace-flow.ts), so a phone can add a workspace even though
  // DSH resolved its own picker to the HOST's OS dialog.
  applyDirectoryFlow(ctx)
}

module.exports = {
  name: PLUGIN_ID,
  inject: ['slots'],
  apply,
}
