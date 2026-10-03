/**
 * dsh-lan-guard — the language of the gate's own pages.
 *
 * The login and pairing pages are served by the PROXY, before any client
 * JavaScript runs, so they cannot use the browser-side `locale` service the
 * settings section uses. They read the SAME preference from the other end: DSH
 * stores the language the official settings page writes in its `locale`
 * settings namespace, and the host half reads that namespace here.
 *
 * The resolution order mirrors DSH's own rule for a browser with no stored
 * preference ("the first supported language the browser requests, falling back
 * to English"), so a fresh visitor sees the same language the app behind the
 * gate is about to open in.
 */
import type { LanGuardLogger } from '../log.ts'

/** The languages these pages carry. */
export type GateLocale = 'zh' | 'en'

/**
 * The language a request that names none at all is served in.
 *
 * Chinese, because this is the PROGRAMMATIC case, not a browser's: every real
 * browser sends `Accept-Language`, so reaching this default means the request
 * came from a test client or a script — and the plugin's own pages have always
 * been Chinese there. An explicit header that names neither language still
 * falls back to English below, which is DSH's rule.
 */
const LANGUAGE_UNKNOWN: GateLocale = 'zh'

/** DSH's locale settings namespace, and the field holding the preference. */
export const LOCALE_NAMESPACE = 'locale'
export const LOCALE_PREFERENCE_FIELD = 'preference'

/** The subset of DSH's `settings` service this module reads. */
export interface SettingsReaderLike {
  describe(): readonly { ns: string; value?: unknown }[]
}

/** Chinese copy for the gate pages; the key set is the source of truth. */
export const gateZh = {
  'login.title': '局域网访问',
  'login.password': '访问密码',
  'login.submit': '进入 DSH',
  'login.mode.password': '本设备需要输入访问密码。',
  'login.mode.token': '本设备使用免密链接访问；链接失效时请向管理员索取新的二维码。',
  'login.mode.both': '输入访问密码，或使用管理员提供的免密链接。',
  'login.pairingHint': '首次访问：通过后需为设备命名，便于在「已授权设备」中识别与单独吊销。',
  'login.footer': '本页由 dsh-lan-guard 提供。密码经 HTTPS 或局域网传输，请仅在可信网络中使用。',
  'notice.invalid': '<p class="notice error">密码错误，请重试。</p>',
  'notice.locked': '尝试次数过多，该地址已被临时锁定{when}。',
  'notice.lockedWhen': '，请在约 {seconds} 秒后重试',
  'notice.lockedNow': '，请稍后重试',
  'notice.noPassword':
    '<p class="notice warn"><strong>尚未设置访问密码。</strong><br>'
    + '未设置密码时门禁拒绝所有设备。'
    + '请在本机 DSH 的「设置 → 局域网访问」中设置访问密码。</p>',
  'notice.csrf': '<p class="notice error">请求来源校验未通过，请从本页重新登录。</p>',
  'notice.tokenOnly':
    '<p class="notice warn">当前验证方式为<strong>仅安全 Token</strong>，不接受密码登录。'
    + '请使用管理员提供的免密链接或二维码。</p>',
  'notice.linkInactive':
    '<p class="notice error">该免密链接无效，或当前「仅密码」模式不接受免密链接。<br>'
    + '请输入访问密码；如需启用链接，请在本机将验证方式改为「扫码免密 + 密码」。</p>',
  'notice.pending':
    '<p class="notice"><strong>本设备正在等待管理员批准。</strong><br>'
    + '请在本机打开 设置 → 局域网访问 → 已授权设备 并选择「批准」，然后刷新本页。</p>',
  'notice.removed':
    '<p class="notice error"><strong>本设备已被移除访问权限。</strong><br>'
    + '请在「已授权设备」中选择「解除拉黑」，同一设备将立即恢复。</p>',
  'pair.title': '确认这台设备',
  'pair.sub': '为设备命名，便于在「已授权设备」中识别与单独吊销。',
  'pair.source': '来源地址：{ip}',
  'pair.label': '设备名称',
  'pair.submit': '确认并进入 DSH',
  'pair.hint': '可在设置页吊销本设备；吊销后需重新确认。',
  'pair.invalid': '<p class="notice error">设备名称不能为空。</p>',
  'pair.csrf': '<p class="notice error">请求来源校验未通过，请重新提交。</p>',
} as const

/** One gate message key. */
export type GateKey = keyof typeof gateZh

/** English — a total map over the Chinese key set. */
export const gateEn: Record<GateKey, string> = {
  'login.title': 'LAN access',
  'login.password': 'Access password',
  'login.submit': 'Enter DSH',
  'login.mode.password': 'This device needs the access password.',
  'login.mode.token': 'This device uses the passwordless link; ask the administrator for a new QR code if it expired.',
  'login.mode.both': 'Enter the access password, or use the passwordless link from the administrator.',
  'login.pairingHint': 'First visit: naming the device follows, so it can be recognised and revoked individually.',
  'login.footer': 'Served by dsh-lan-guard. The password travels over HTTPS or the local network; use only on a trusted network.',
  'notice.invalid': '<p class="notice error">Incorrect password. Try again.</p>',
  'notice.locked': 'Too many attempts; this address is locked for now{when}.',
  'notice.lockedWhen': '. Try again in about {seconds} seconds',
  'notice.lockedNow': '. Try again shortly',
  'notice.noPassword':
    '<p class="notice warn"><strong>No access password is set.</strong><br>'
    + 'Without one the gate refuses every device. '
    + 'Set it on this machine under Settings → LAN access.</p>',
  'notice.csrf': '<p class="notice error">The origin check failed. Sign in again from this page.</p>',
  'notice.tokenOnly':
    '<p class="notice warn">The verification method is <strong>secure token only</strong>, which takes no password. '
    + 'Use the passwordless link or QR code from the administrator.</p>',
  'notice.linkInactive':
    '<p class="notice error">This passwordless link is invalid, or the current "password only" mode does not accept one.<br>'
    + 'Enter the access password; to enable the link, switch the verification method to "Passwordless QR + password" on this machine.</p>',
  'notice.pending':
    '<p class="notice"><strong>This device is waiting for approval.</strong><br>'
    + 'On this machine, open Settings → LAN access → Devices and choose "Approve", then refresh this page.</p>',
  'notice.removed':
    '<p class="notice error"><strong>This device has been removed.</strong><br>'
    + 'Choose "Unblock" under Devices and the same device is restored immediately.</p>',
  'pair.title': 'Confirm this device',
  'pair.sub': 'Name the device so it can be recognised and revoked individually.',
  'pair.source': 'Source address: {ip}',
  'pair.label': 'Device name',
  'pair.submit': 'Confirm and enter DSH',
  'pair.hint': 'Revoke this device from the settings page; it must confirm again afterwards.',
  'pair.invalid': '<p class="notice error">The device name cannot be empty.</p>',
  'pair.csrf': '<p class="notice error">The origin check failed. Submit again.</p>',
}

/** A translate function over the gate dictionary. */
export type GateTranslate = (key: GateKey, params?: Record<string, string | number>) => string

/**
 * Build the translator for one language.
 *
 * @param locale - the resolved language.
 * @returns a translate function over that dictionary.
 */
export function gateTranslate(locale: GateLocale): GateTranslate {
  const dictionary: Record<GateKey, string> = locale === 'en' ? gateEn : gateZh
  return (key, params) => {
    const template = dictionary[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      (name in params ? String(params[name]) : match))
  }
}

/**
 * Pick a language from the visitor's `Accept-Language`.
 *
 * Deliberately crude, and deliberately the same rule DSH applies to a browser it
 * has never seen: the first supported language the browser asks for, English
 * when it asks for neither. Chinese is matched on any `zh` tag, so `zh-CN`,
 * `zh-Hans` and `zh-TW` all land on the Chinese dictionary — a Traditional
 * reader is closer to the Simplified copy than to the English one.
 *
 * @param header - the raw header value, or undefined when absent.
 * @returns the language to serve.
 */
export function localeFromAcceptLanguage(header: string | undefined): GateLocale {
  if (header === undefined || header.trim() === '') return LANGUAGE_UNKNOWN
  for (const part of header.split(',')) {
    const tag = part.split(';')[0]?.trim().toLowerCase() ?? ''
    if (tag.startsWith('zh')) return 'zh'
    if (tag.startsWith('en')) return 'en'
  }
  return 'en'
}

/**
 * Read the language DSH's own settings page stored.
 *
 * @param settings - the host settings service, when the plugin has one.
 * @returns the stored preference, or undefined when it is unset or unreadable.
 */
export function localeFromSettings(settings: SettingsReaderLike | undefined): GateLocale | undefined {
  try {
    const row = settings?.describe().find(entry => entry.ns === LOCALE_NAMESPACE)
    const value = row?.value
    if (value === null || typeof value !== 'object') return undefined
    const preference = (value as Record<string, unknown>)[LOCALE_PREFERENCE_FIELD]
    if (typeof preference !== 'string') return undefined
    const tag = preference.trim().toLowerCase()
    if (tag.startsWith('zh')) return 'zh'
    if (tag.startsWith('en')) return 'en'
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the language for one gate request.
 *
 * The stored preference wins; only a browser with none falls back to what it
 * asks for. A failed read is a debug line, never a refusal: the pages must
 * render even when the settings service is unavailable.
 *
 * @param options.settings - the host settings service, when available.
 * @param options.acceptLanguage - the request's header.
 * @param options.logger - logger for the degradation path.
 * @returns the language to serve this request in.
 */
export function resolveGateLocale(options: {
  settings?: SettingsReaderLike | undefined
  acceptLanguage?: string | undefined
  logger?: LanGuardLogger | undefined
}): GateLocale {
  const stored = localeFromSettings(options.settings)
  if (stored !== undefined) return stored
  if (options.settings === undefined) {
    options.logger?.debug?.('locale: settings service unavailable; following Accept-Language')
  }
  return localeFromAcceptLanguage(options.acceptLanguage)
}
