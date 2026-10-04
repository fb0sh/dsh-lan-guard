/**
 * dsh-lan-guard — browser-half decision logic for the workspace picker.
 *
 * Kept free of React and of the DOM so it can be unit-tested in a node
 * environment: everything here is a pure function of facts the caller samples.
 *
 * The two decisions this module owns:
 *
 * 1. WHICH interaction this browser gets. The official directory-picker seam is
 *    resolved once per PROCESS, so DSH's own answer is "native" whenever its web
 *    server binds loopback — even for a phone on the LAN. The browser half
 *    therefore shadows the official flow occupant and answers the question per
 *    CLIENT: a browser sitting at this machine keeps the OS folder dialog, a
 *    remote one gets the in-page browser.
 * 2. WHAT a failure means to the person holding the phone. Every refusal the
 *    management route can return maps to one sentence plus the exact way to fix
 *    it; a silent no-op is what this whole feature exists to remove.
 */

/** The management route that serves one directory level. */
export const BROWSE_PATH = '/plugins/dsh-lan-guard/workspaces'

/**
 * The management endpoint on DSH's own origin.
 *
 * Shared with the settings card so the picker can unlock the console IN PLACE
 * instead of sending the operator hunting for the lock card in another tab.
 */
export const CONFIG_PATH = '/plugins/dsh-lan-guard/config'

/** The two directory-flow holes `ui-workspace` declares (`single` kind). */
export const HERO_FLOW = 'conversation.hero.workspace.directoryFlow'
export const SIDEBAR_FLOW = 'sidebar.workspaces.directoryFlow'

/**
 * Slot priority for the shadowing occupant.
 *
 * DSH's own picker surface registers at the default 0, and a `single` slot
 * renders the LOWEST priority, so any negative value shadows it. -20 (rather
 * than the reference implementation's -10) keeps this plugin's occupant
 * winning if both are ever installed at once, which is a documented conflict
 * instead of a duplicate-registration throw.
 */
export const FLOW_PRIORITY = -20

/** The DOM facts {@link directoryFlowDecision} needs. */
export interface ClientEnvironment {
  /** `location.hostname`. */
  hostname: string
  /** `location.protocol`. */
  protocol: string
  /** `navigator.userAgent` (empty when unavailable). */
  userAgent: string
  /** Whether the desktop shell's preload picker (`__DSH_DIRECTORY_PICKER__`) exists. */
  hasDesktopPicker: boolean
  /** Whether `window.electron` / `__DSH_NATIVE_HOST__` marks a desktop shell. */
  hasNativeHost: boolean
}

import type { Translate } from './i18n.ts'

/** Which interaction this browser should get. */
export type FlowDecision = 'native' | 'browse'

/** Whether a hostname names this machine's own loopback interface. */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || normalized === ''
}

/**
 * Whether this browser is sitting at the machine that runs DSH.
 *
 * This is the same evidence DSH's own connection client uses to decide that a
 * page "owns the host", plus the desktop-shell markers: a preload picker or an
 * Electron host means an OS dialog can actually be shown to the person looking
 * at this window.
 *
 * @param env - the sampled DOM facts.
 * @returns `native` to delegate to DSH's OS dialog, `browse` to render ours.
 */
export function directoryFlowDecision(env: ClientEnvironment): FlowDecision {
  if (env.hasDesktopPicker) return 'native'
  if (env.hasNativeHost) return 'native'
  if (isLoopbackHostname(env.hostname)) return 'native'
  if (env.protocol === 'file:' || env.protocol === 'app:' || env.protocol === 'vscode-webview:') return 'native'
  if (env.userAgent.includes('Electron')) return 'native'
  return 'browse'
}

/** One sentence plus the fix, shown inside the picker. */
export interface PickerNotice {
  title: string
  detail: string
}

/**
 * Translate a refusal into something actionable.
 *
 * @param code - the `error` field of a management response, or a transport code.
 * @param t - the picker's translator, so the notice follows the active locale.
 * @returns the title and detail the page shows.
 */
export function browseErrorNotice(code: string, t: Translate): PickerNotice {
  switch (code) {
    case 'read_only_remote':
      return {
        title: t('notice.readOnly.title'),
        detail: t('notice.readOnly.detail'),
      }
    case 'admin_required':
      return {
        title: t('notice.adminRequired.title'),
        detail: t('notice.adminRequired.detail'),
      }
    case 'rate_limited':
      return { title: t('notice.rateLimited.title'), detail: t('notice.rateLimited.detail') }
    case 'blocked':
      return {
        title: t('notice.blocked.title'),
        detail: t('notice.blocked.detail'),
      }
    case 'not_found':
      return { title: t('notice.notFound.title'), detail: t('notice.notFound.detail') }
    case 'not_a_directory':
      return { title: t('notice.notADirectory.title'), detail: t('notice.notADirectory.detail') }
    case 'not_absolute':
    case 'invalid_path':
      return { title: t('notice.invalidPath.title'), detail: t('notice.invalidPath.detail') }
    case 'exists':
      return { title: t('notice.exists.title'), detail: t('notice.exists.detail') }
    case 'create_failed':
      return { title: t('notice.createFailed.title'), detail: t('notice.createFailed.detail') }
    case 'unreadable':
      return { title: t('notice.unreadable.title'), detail: t('notice.unreadable.detail') }
    case 'forbidden':
    case 'unauthorized':
      return { title: t('notice.forbidden.title'), detail: t('notice.forbidden.detail') }
    default:
      return { title: t('notice.unknown.title'), detail: code === '' ? t('notice.unknown.detail') : code }
  }
}

/** One row of a listing, as the page needs it. */
export interface BrowseRow {
  name: string
  /** A message key for the name, when the host sent copy rather than a path segment. */
  nameKey?: string
  /** Placeholders for {@link nameKey}. */
  nameParams?: Record<string, string>
  path: string
  hidden: boolean
}

/** One breadcrumb jump target. */
export interface BrowseCrumbRow {
  name: string
  path: string
}

/** A listing as the page consumes it. */
export interface BrowseListingView {
  path: string
  crumbs: BrowseCrumbRow[]
  quick: BrowseRow[]
  entries: BrowseRow[]
  truncated: boolean
}

/** An error carrying the server's stable code. */
export class BrowseRequestError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'BrowseRequestError'
    this.code = code
  }
}

/**
 * Turn one management response into a listing, or throw the stable code.
 *
 * @param status - the HTTP status.
 * @param body - the parsed JSON body, when it parsed.
 * @returns the listing.
 */
export function readBrowseResponse(status: number, body: unknown): BrowseListingView {
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  if (status === 200 && record.ok === true) {
    return {
      path: typeof record.path === 'string' ? record.path : '',
      crumbs: Array.isArray(record.crumbs) ? record.crumbs as BrowseCrumbRow[] : [],
      quick: Array.isArray(record.quick) ? record.quick as BrowseRow[] : [],
      entries: Array.isArray(record.entries) ? record.entries as BrowseRow[] : [],
      truncated: record.truncated === true,
    }
  }
  const code = typeof record.error === 'string' && record.error !== ''
    ? record.error
    : status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : `http_${String(status)}`
  throw new BrowseRequestError(code, code)
}

/** Sample the browser facts {@link directoryFlowDecision} needs. */
export function readClientEnvironment(): ClientEnvironment {
  const scope = globalThis as unknown as {
    location?: { hostname?: string; protocol?: string }
    navigator?: { userAgent?: string }
    electron?: unknown
    __DSH_NATIVE_HOST__?: unknown
    __DSH_DIRECTORY_PICKER__?: unknown
  }
  return {
    hostname: scope.location?.hostname ?? '',
    protocol: scope.location?.protocol ?? '',
    userAgent: scope.navigator?.userAgent ?? '',
    hasDesktopPicker: scope.__DSH_DIRECTORY_PICKER__ !== undefined,
    hasNativeHost: scope.electron !== undefined || scope.__DSH_NATIVE_HOST__ !== undefined,
  }
}

/** The slot registry surface the registration needs. */
export interface FlowSlots {
  inject(seat: string, callback: () => unknown): unknown
  register(options: Record<string, unknown>, component: unknown): unknown
}

/** What the registered occupant is handed by the owner. */
export interface FlowInjected {
  /** The official picker (OS dialog); throws when this host has none. */
  pick(): Promise<string | null>
  /** One directory level from the management route. */
  browse(path?: string): Promise<BrowseListingView>
  /**
   * Create one child folder and return its absolute path.
   *
   * The same verb the official occupant receives, but served by this plugin's
   * own route: DSH's `directoryPicker.createDirectory` needs the `browse`
   * capability, and a host whose web server binds loopback resolves the picker
   * to `native` — where both `list` and `createDirectory` are refused.
   */
  create(path: string, name: string): Promise<string>
  /**
   * The plugin's translator.
   *
   * Passed through this surface rather than through the `locale:` slot seat
   * because the picker is a transient dialog: it cannot be open across a
   * language switch in any realistic flow, and a stable bound function keeps
   * the registration options unchanged.
   */
  t?: Translate
}

/**
 * Register the shadowing occupant into both directory-flow holes.
 *
 * `slots.inject` (not a bare `register`) because `ui-workspace` may declare the
 * holes after this plugin applies — the same transactional nesting the official
 * surface uses. The `priority` is what makes the whole feature possible: a
 * `single` slot renders its LOWEST-priority occupant, so this registration
 * shadows DSH's native surface without a duplicate-registration error, and the
 * occupant itself decides per client which interaction runs.
 *
 * Lives here (not next to the component) so the contract is testable without a
 * browser or React.
 *
 * @param slots - the client slot registry.
 * @param component - the occupant component to register.
 * @param injected - the `pick` / `browse` calls handed to that component.
 */
export function registerDirectoryFlow(slots: FlowSlots, component: unknown, injected: FlowInjected): void {
  const inject = (): FlowInjected => injected
  slots.inject(HERO_FLOW, () => slots.inject(SIDEBAR_FLOW, function* () {
    yield slots.register({ name: HERO_FLOW, priority: FLOW_PRIORITY, inject }, component)
    yield slots.register({ name: SIDEBAR_FLOW, priority: FLOW_PRIORITY, inject }, component)
  }))
}
