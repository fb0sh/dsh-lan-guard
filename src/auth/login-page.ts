/**
 * dsh-lan-guard — the visitor login page.
 *
 * Three states must be visually distinct, because two of them look like a
 * working gate but are not:
 *
 * - `invalid` — a wrong password;
 * - `locked` — this IP is locked out, with the honest remaining time;
 * - `no-password` — NO password is configured, so the gate cannot let anyone
 *   in. Showing a plain "wrong password" here would be the "any password
 *   works" illusion the spec forbids.
 *
 * The page carries no credential, no token and no state beyond what the URL
 * already exposes. DSH's own stylesheet is NOT loaded on the proxy origin, so
 * the official palette is inlined in {@link LOGIN_CSS} (read out of DSH
 * 0.2.0-rc.2's theme) and the markup is styled as the official dialog surface.
 */
import type { AuthMode } from '../config.ts'
import { gateTranslate, type GateLocale, type GateTranslate } from './gate-i18n.ts'

/** Which state the login page should render. */
export type LoginState =
  | 'prompt' | 'invalid' | 'locked' | 'no-password' | 'csrf' | 'token-only'
  | 'device-removed' | 'pending-approval' | 'link-inactive'

/** Options for {@link renderLoginPage}. */
export interface LoginPageOptions {
  state: LoginState
  mode: AuthMode
  /** Absolute lockout end, for the honest remaining-time message. */
  lockedUntilMs?: number
  /** Clock injection for tests. */
  now?: number
  /** Where to go after a successful login (already validated as a local path). */
  next?: string
  /**
   * The language this request is served in.
   *
   * Resolved by the gate from DSH's own `locale` setting — the one the official
   * settings page writes — falling back to the visitor's `Accept-Language`.
   * Defaults to Chinese so a direct call can never render half-translated.
   */
  locale?: GateLocale
  /**
   * Whether a first-time device must ALSO name itself after logging in (pairing).
   *
   * Surfaced as a hint on the password page: the two gates are sequential, so
   * "password first, then a name" must be expected rather than a surprise
   * (user report 2026-09-26: "手机端扫码时只让我输密码，不让我输名称").
   */
  pairingRequired?: boolean
}

/**
 * States in which submitting the password can still get the visitor in.
 *
 * The pairing hint is only shown where a login is actually reachable: a removed
 * device, a gate with no password, and token-only mode are not.
 */
const LOGIN_CAPABLE_STATES: readonly LoginState[] = [
  'prompt', 'invalid', 'locked', 'csrf', 'link-inactive',
]

/**
 * Render the device-pairing page (P4-g).
 *
 * Shown to a device that has just passed the password/link gate but carries no
 * device identity: naming it is what makes the "已授权设备" list meaningful and
 * what makes a later revoke effective (user request 2026-09-24, modelled on
 * dsh-mobile's pairing screen).
 */
export function renderPairingPage(options: {
  defaultLabel: string
  ip: string
  error?: 'invalid' | 'csrf'
  /** The language the gate resolved for this request. */
  locale?: GateLocale
}): string {
  const locale = options.locale ?? 'zh'
  const t = gateTranslate(locale)
  const notice = options.error === 'csrf'
    ? t('pair.csrf')
    : options.error === 'invalid'
      ? t('pair.invalid')
      : ''
  return `<!doctype html>
<html lang="${locale === 'en' ? 'en' : 'zh-CN'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(t('pair.title'))} · DSH</title>
<style>${LOGIN_CSS}</style>
</head>
<body>
<main class="card">
  <h1>${escapeHtml(t('pair.title'))}</h1>
  <p class="sub">${escapeHtml(t('pair.sub'))}</p>
  ${notice}
  <div class="lg-mono-static">${escapeHtml(t('pair.source', { ip: options.ip }))}</div>
  <form method="post" action="/__dsh_lan_guard__/pair" autocomplete="off">
    <label for="label">${escapeHtml(t('pair.label'))}</label>
    <input id="label" name="label" type="text" value="${escapeHtml(options.defaultLabel)}" autofocus required>
    <button type="submit">${escapeHtml(t('pair.submit'))}</button>
  </form>
  <p class="hint">${escapeHtml(t('pair.hint'))}</p>
</main>
</body>
</html>
`
}

/** Escape text for HTML text nodes and attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Human-readable remaining lockout time. */
function remainingSeconds(lockedUntilMs: number | undefined, now: number): number {
  if (lockedUntilMs === undefined) return 0
  return Math.max(0, Math.ceil((lockedUntilMs - now) / 1_000))
}

const LOGIN_CSS = `
/*
 * The gate's own pages, drawn in DSH's design language.
 *
 * They are served on the PROXY origin, so DSH's stylesheet is NOT loaded here
 * and the official \`--dsw-*\` variables do not exist at runtime — unlike the
 * settings section, which can simply reference them. The palette below is
 * therefore the official one INLINED: every value is the resolved alias token
 * read out of DSH 0.2.0-rc.2's own theme (light from \`body\`, dark from
 * \`body[data-ds-dark-theme]\`), so a phone that has just come through the gate
 * sees the same surfaces, strokes and type scale as the app behind it.
 *
 * The naming stays \`--dsw-*\` on purpose: the local block is what a future DSH
 * release replaces wholesale, and a renamed local variable would quietly keep
 * the old colour.
 */
:root{color-scheme:light dark;
  --dsw-alias-bg-base:#fff;
  --dsw-alias-bg-layer-2:#fff;
  --dsw-alias-bg-layer-3:#fff;
  --dsw-alias-bg-module-platform:#f5f6f7;
  --dsw-alias-label-primary:#0f1115;
  --dsw-alias-label-secondary:#61666b;
  --dsw-alias-label-tertiary:#81858c;
  --dsw-alias-label-primary-foreground:#fff;
  --dsw-alias-border-l2:#0000001a;
  --dsw-alias-border-l4:#00000029;
  --dsw-alias-button-primary-fill:#0f1115;
  --dsw-alias-button-primary-hover:#43454a;
  --dsw-alias-state-error-primary:#ec1313;
  --dsw-alias-state-warn-primary:#f59e0b;
  --dsw-alias-state-business-primary:#4176e6;
  --dsw-radius-sm:8px;
  --dsw-radius-md:12px;
  --dsw-radius-panel:28px;
  --dsw-elevation-prominent:0 0 0 .5px #00000029, 0 3px 8px 0 #0000000a, 0 0 20px 0 #0000000d}
@media (prefers-color-scheme:dark){:root{
  --dsw-alias-bg-base:#151517;
  --dsw-alias-bg-layer-2:#2c2c2e;
  --dsw-alias-bg-layer-3:#353638;
  --dsw-alias-bg-module-platform:#353638;
  --dsw-alias-label-primary:#f9fafb;
  --dsw-alias-label-secondary:#cfd3d6;
  --dsw-alias-label-tertiary:#adb2b8;
  --dsw-alias-label-primary-foreground:#0f1115;
  --dsw-alias-border-l2:#ffffff1f;
  --dsw-alias-border-l4:#fff3;
  --dsw-alias-button-primary-fill:#f9fafb;
  --dsw-alias-button-primary-hover:#ebeef2;
  --dsw-alias-state-error-primary:#f25a5a;
  --dsw-alias-state-warn-primary:#f59e0b;
  --dsw-alias-state-business-primary:#7aaaff;
  --dsw-elevation-prominent:0 0 0 .5px #fff3, 0 3px 8px 0 #0000000a, 0 0 20px 0 #0000000d}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  padding:max(24px,env(safe-area-inset-top)) 24px max(24px,env(safe-area-inset-bottom));
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif}
/* The official dialog surface: panel radius on the secondary layer under the
   prominent elevation (ui-primitives Modal). */
.card{width:min(420px,100%);background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-panel);
  padding:24px;box-shadow:var(--dsw-elevation-prominent)}
h1{margin:0 0 6px;font-size:16px;font-weight:500;line-height:24px}
.sub{margin:0 0 20px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary)}
label{display:block;font-size:13px;font-weight:500;line-height:1.5;margin:0 0 6px}
input[type=password],input[type=text]{width:100%;height:36px;padding:0 12px;font:inherit;font-size:14px;
  border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
button{width:100%;height:36px;margin-top:16px;border:0;border-radius:var(--dsw-radius-md);
  font:inherit;font-size:14px;font-weight:500;cursor:pointer;
  background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
button:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
button:disabled{opacity:.4;cursor:not-allowed}
/*
 * A notice is copy with a semantic ACCENT, not a filled bar: the semantic
 * colour marks the edge while the text stays on the high-contrast label token.
 * Measured against DSH 0.2.0-rc.2, semantic-on-its-own-tint is 3.60:1 in the
 * light palette — below AA for text — while label-primary is 16.04:1.
 */
.notice{margin:0 0 16px;padding:2px 0 2px 10px;font-size:13px;line-height:20px;
  border-left:2px solid var(--dsw-alias-label-tertiary)}
.notice.error{border-left-color:var(--dsw-alias-state-error-primary)}
.notice.warn{border-left-color:var(--dsw-alias-state-warn-primary)}
.hint{margin:16px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}
.lg-mono-static{margin:0 0 16px;padding:8px 12px;border:0.5px solid var(--dsw-alias-border-l4);
  border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
/* Coarse pointers get the official 44px target floor. */
@media (hover:none) and (pointer:coarse){
  input[type=password],input[type=text],button{height:44px}
}
`.trim()

/** Build the state-specific notice block. */
function notice(state: LoginState, lockedUntilMs: number | undefined, now: number, t: GateTranslate): string {
  if (state === 'invalid') {
    return t('notice.invalid')
  }
  if (state === 'locked') {
    const seconds = remainingSeconds(lockedUntilMs, now)
    return t('notice.locked', {
      when: seconds > 0 ? t('notice.lockedWhen', { seconds }) : t('notice.lockedNow'),
    })
  }
  if (state === 'csrf') {
    return t('notice.csrf')
  }
  if (state === 'link-inactive') {
    return t('notice.linkInactive')
  }
  if (state === 'pending-approval') {
    return t('notice.pending')
  }
  if (state === 'device-removed') {
    // Reached only for a REVOKED or BLOCKED record. A record that was DELETED no
    // longer lands here: the gate now treats a cookie that names no record as
    // absent browser state and lets the auth flow recover it, so the old
    // "清除本浏览器的本站数据" advice went with that dead end.
    // "解除拉黑" really does restore the same browser (unblocking keeps the
    // record, so the same cookie works again immediately).
    return t('notice.removed')
  }
  if (state === 'token-only') {
    return t('notice.tokenOnly')
  }
  if (state === 'no-password') {
    return t('notice.noPassword')
  }
  return ''
}

/**
 * Render the login page.
 *
 * @param options - the state, the auth mode and optional lockout/redirect data.
 * @returns a complete HTML document.
 */
export function renderLoginPage(options: LoginPageOptions): string {
  const locale = options.locale ?? 'zh'
  const t = gateTranslate(locale)
  const now = options.now ?? Date.now()
  // `link-inactive` is deliberately NOT in this list: it only means the LINK is
  // dead, while the password form still works. Disabling it stranded real
  // phones on a page whose own notice says "请输入访问密码" (found 2026-09-26).
  const blocked = options.state === 'locked' || options.state === 'no-password'
    || options.state === 'device-removed' || options.state === 'pending-approval'
  const next = options.next !== undefined && options.next.startsWith('/') ? options.next : '/'
  // Say the second gate out loud BEFORE the password is submitted: the visitor
  // otherwise reads "扫码即登录" and is surprised by the naming page.
  const pairingHint = options.pairingRequired === true && LOGIN_CAPABLE_STATES.includes(options.state)
    ? `<p class="hint">${escapeHtml(t('login.pairingHint'))}</p>`
    : ''
  const modeHint = options.mode === 'password'
    ? t('login.mode.password')
    : options.mode === 'token'
      ? t('login.mode.token')
      : t('login.mode.both')

  return `<!doctype html>
<html lang="${locale === 'en' ? 'en' : 'zh-CN'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(t('login.title'))} · DSH</title>
<style>${LOGIN_CSS}</style>
</head>
<body>
<main class="card">
  <h1>${escapeHtml(t('login.title'))}</h1>
  <p class="sub">${escapeHtml(modeHint)}</p>
  ${notice(options.state, options.lockedUntilMs, now, t)}
  ${pairingHint}
  <form method="post" action="/__dsh_lan_guard__/login" autocomplete="off">
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <label for="password">${escapeHtml(t('login.password'))}</label>
    <input id="password" name="password" type="password" autocomplete="current-password"
      autofocus ${blocked ? 'disabled' : ''} required>
    <button type="submit" ${blocked ? 'disabled' : ''}>${escapeHtml(t('login.submit'))}</button>
  </form>
  <p class="hint">${escapeHtml(t('login.footer'))}</p>
</main>
</body>
</html>
`
}
