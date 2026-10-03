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
 * - The page is drawn in the OFFICIAL design language, with the official
 *   controls (see `./client/ui/kit.ts`) and the official cell rhythm (see
 *   `./client/ui/styles.ts`), so the section reads as one of DSH's own settings
 *   pages next to 通用设置 and 模型. It replaces the plugin's own
 *   "Liquid Glass" skin, which invented a material the rest of the dialog does
 *   not have.
 * - Passwords and tokens are NEVER echoed: the page only shows whether they
 *   are set, and every write goes through the host endpoint with
 *   `credentials: 'same-origin'`.
 *
 * The section reads and writes `/plugins/dsh-lan-guard/config` on DSH's own
 * origin — the management surface, guarded by DSH's native fence. That is a
 * different auth surface from the proxy port's visitor gate.
 */
import {
  createElement, useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode,
} from 'react'
import { applyDirectoryFlow } from './client/workspace-flow.ts'
import { CONFIG_PATH as CONFIG_PATH_FROM_PICKER } from './client/picker-logic.ts'
import {
  Button, Icons, Input, OfficialToast, SegmentedTabs, Switch, Tag,
  type IconName, type SegmentedTab,
} from './client/ui/kit.ts'
import { SECTION_CSS } from './client/ui/styles.ts'
import {
  en as EN_DICTIONARY,
  LOCALE_NS,
  standaloneTranslate,
  zh as ZH_DICTIONARY,
  type MessageKey,
  type Translate,
} from './client/i18n.ts'

/**
 * The subset of DSH's `locale` service this plugin uses.
 *
 * `register` publishes the dictionary under the plugin's namespace and returns
 * its own disposer (the caller wraps it in an effect); `bind` returns a
 * translate function that reads the ACTIVE locale at call time, so a bound
 * reference stays correct across a language switch.
 */
interface LocaleServiceLike {
  register(ns: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void
  bind(ns: string): (key: MessageKey, params?: Record<string, string | number>) => string
}

/** Look a client service up without requiring it (Cordis optional lookup). */
function optionalService(ctx: { get?(name: string): unknown }, name: string): unknown {
  try {
    return ctx.get?.(name)
  } catch {
    return undefined
  }
}

/** Plugin id: also the Loader entry id and the settings namespace. */
const PLUGIN_ID = 'dsh-lan-guard'
/** The official additive settings seat. */
const SEAT = 'settings.section'
/** The management endpoint on DSH's own origin. */
const CONFIG_PATH = CONFIG_PATH_FROM_PICKER

/**
 * One option of the big-card selector, in KEYS rather than text.
 *
 * These tables live at module scope, where no translate function exists yet:
 * they are read once per render, so the copy has to be resolved at render time
 * and can never be a module-level string (which would freeze the first
 * language the page happened to load in).
 */
interface ChoiceSpec {
  id: string
  titleKey: MessageKey
  detailKey: MessageKey
}

/** The three credential modes offered by the big-card selector. */
const MODE_CHOICES: readonly ChoiceSpec[] = [
  { id: 'token_and_password', titleKey: 'security.mode.tokenPassword', detailKey: 'security.mode.tokenPasswordDetail' },
  { id: 'password', titleKey: 'security.mode.password', detailKey: 'security.mode.passwordDetail' },
  { id: 'token', titleKey: 'security.mode.token', detailKey: 'security.mode.tokenDetail' },
]

/** Admin unlock policies. */
const POLICY_CHOICES: readonly ChoiceSpec[] = [
  { id: 'password_unlock', titleKey: 'security.policy.unlock', detailKey: 'security.policy.unlockDetail' },
  { id: 'local_only', titleKey: 'security.policy.local', detailKey: 'security.policy.localDetail' },
  { id: 'open', titleKey: 'security.policy.open', detailKey: 'security.policy.openDetail' },
]

/** The four tabs of the section (user decision 2026-09-24). */
const TABS = [
  { id: 'access', labelKey: 'tab.access' },
  { id: 'security', labelKey: 'tab.security' },
  { id: 'devices', labelKey: 'tab.devices' },
  { id: 'connection', labelKey: 'tab.connection' },
] as const satisfies readonly { id: string; labelKey: MessageKey }[]

/** One tab id. */
type TabId = (typeof TABS)[number]['id']

/**
 * The tab list handed to the official SegmentedTabs.
 *
 * Built from {@link TABS} with an explicit non-emptiness proof, because the
 * official control types `items` as a non-empty tuple and the plugin's tab
 * table is a `readonly` array. A silent cast would hide the one thing that
 * would actually break the tablist; the destructure makes it a checked fact.
 *
 * @returns the tab descriptors, first element included.
 */
function tabItems(t: Translate): readonly [SegmentedTab<TabId>, ...SegmentedTab<TabId>[]] {
  const [first, ...rest] = TABS.map(entry => ({
    value: entry.id,
    label: t(entry.labelKey),
    id: `lg-tab-${entry.id}`,
    panelId: `lg-panel-${entry.id}`,
  }))
  /* v8 ignore next -- TABS is a non-empty literal; this only satisfies the tuple type. */
  if (first === undefined) throw new Error('dsh-lan-guard: the settings section has no tabs')
  return [first, ...rest]
}

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
    pwaInstall: boolean
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
    unavailableInterface?: string
  }
}

// ---------------------------------------------------------------------------
// Presentation primitives, all official patterns
// ---------------------------------------------------------------------------

/** The note tones; each maps to one official semantic colour for the icon. */
type NoteTone = 'ok' | 'warn' | 'info' | 'danger'

/**
 * One block of more than one part.
 *
 * The panel puts the 16px cell rhythm and the hairline BETWEEN blocks; stacking
 * the parts inside one keeps a hint attached to the control it explains instead
 * of giving it a separator of its own.
 */
function stack(...children: (ReactNode | null)[]): ReactElement {
  return createElement('div', { className: 'lg-stack' }, ...children)
}

/** One setting: its text column on the left, its control on the right. */
function cell(props: {
  title: string
  desc?: string | undefined
  control?: ReactNode
  extra?: ReactNode
}): ReactElement {
  return createElement(
    'div',
    { className: 'lg-cell' },
    createElement(
      'div',
      { className: 'lg-cell-text' },
      createElement('div', { className: 'lg-title' }, props.title),
      props.desc === undefined ? null : createElement('div', { className: 'lg-desc' }, props.desc),
      props.extra ?? null,
    ),
    props.control === undefined ? null : createElement('div', { className: 'lg-cell-control' }, props.control),
  )
}

/** A status line: plain copy with a coloured leading glyph. */
function note(tone: NoteTone | null, icon: IconName, ...children: ReactNode[]): ReactElement {
  return createElement(
    'p',
    { className: tone === null ? 'lg-note' : `lg-note ${tone}` },
    createElement('span', { className: 'lg-note-icon' }, createElement(Icons[icon], { size: 14 })),
    createElement('span', null, ...children),
  )
}

/** A labelled field: the official 13/500 label above its control. */
function field(label: string, ...children: ReactNode[]): ReactElement {
  return createElement(
    'div',
    { className: 'lg-field' },
    createElement('div', { className: 'lg-label' }, label),
    ...children,
  )
}

/**
 * A switch row: the official FontSizeRow shape (title and description left, the
 * control right) with the official Switch capsule.
 *
 * @param props.title - the setting's name, also the switch's accessible name.
 * @param props.desc - the one-line explanation under the title.
 * @param props.hint - longer copy placed under the whole row.
 * @param props.checked - current value.
 * @param props.disabled - true while a write is in flight.
 * @param props.onChange - receives the requested value.
 * @returns the row.
 */
function toggleCell(props: {
  title: string
  desc: string
  hint?: string
  checked: boolean
  disabled: boolean
  onChange: (next: boolean) => void
}): ReactElement {
  return stack(
    cell({
      title: props.title,
      desc: props.desc,
      control: createElement(Switch, {
        checked: props.checked,
        disabled: props.disabled,
        label: props.title,
        onChange: props.onChange,
      }),
    }),
    props.hint === undefined ? null : createElement('p', { className: 'lg-hint' }, props.hint),
  )
}

/**
 * The official selection cubes (ui-theme AppearanceRow `.themeCube`).
 *
 * @param props.choices - id, title and one-line detail per option.
 * @param props.value - the selected id.
 * @param props.disabled - true while a write is in flight.
 * @param props.onPick - receives the chosen id.
 * @returns the cube row.
 */
function choiceGroup(props: {
  choices: readonly { id: string; title: string; detail: string }[]
  value: string
  disabled: boolean
  onPick: (id: string) => void
}): ReactElement {
  return createElement(
    'div',
    { className: 'lg-choices' },
    ...props.choices.map(choice => createElement(
      'button',
      {
        key: choice.id,
        type: 'button',
        className: 'lg-choice',
        'aria-pressed': props.value === choice.id,
        disabled: props.disabled,
        onClick: () => {
          props.onPick(choice.id)
        },
      },
      createElement('span', { className: 'lg-choice-title' }, choice.title),
      createElement('span', { className: 'lg-choice-desc' }, choice.detail),
    )),
  )
}

/** A row of text links in the official settings-link dress. */
function textLink(key: string, href: string, label: string): ReactElement {
  return createElement(
    'a',
    { key, className: 'lg-link', href, target: '_blank', rel: 'noreferrer' },
    label,
  )
}

/**
 * The transient confirmation banner used when the host ships no Toast
 * primitive.
 *
 * It reproduces the official toast surface (a dark banner at the top centre of
 * the viewport, radius-lg, `--dsw-shadow-lv3`) and adds the two things this
 * plugin has always had: an explicit dismiss control, and a countdown bar whose
 * duration is injected from {@link TOAST_MS} so the animation and the dismissal
 * timer can never disagree.
 *
 * @param props.tone - `info` for a confirmation, `danger` for a failure.
 * @param props.text - the line to show.
 * @param props.icon - the leading glyph.
 * @param props.seq - the show sequence; keys the element so a second banner
 *   restarts the countdown instead of inheriting the first one's deadline.
 * @param props.onClose - dismisses immediately.
 * @returns the banner.
 */
function fallbackToast(props: {
  tone: 'info' | 'danger'
  text: string
  icon: ReactNode
  seq: number
  /** Accessible name of the dismiss control, already localized. */
  closeLabel: string
  onClose: () => void
}): ReactElement {
  return createElement(
    'div',
    { className: 'lg-toasts', key: `toast-${String(props.seq)}` },
    createElement(
      'div',
      { className: `lg-toast ${props.tone}`, role: props.tone === 'danger' ? 'alert' : 'status' },
      createElement('span', { className: 'lg-toast-icon' }, props.icon),
      createElement('span', { className: 'lg-toast-text' }, props.text),
      createElement(
        'button',
        { type: 'button', className: 'lg-toast-x', 'aria-label': props.closeLabel, onClick: props.onClose },
        createElement(Icons.close, { size: 12 }),
      ),
      // The countdown bar is decorative: the close button is the accessible way
      // out, so screen readers get no second "progress" element.
      createElement('span', {
        className: 'lg-toast-bar',
        'aria-hidden': true,
        style: { animationDuration: `${String(TOAST_MS)}ms` },
      }),
    ),
  )
}

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
function settingsError(raw: string, t: Translate): string {
  const key = settingsErrorKey(raw)
  return key === null ? raw : t(key)
}

/**
 * Map an access-reason code to its message key.
 *
 * @param code - the code the host sent.
 * @returns the message key for it.
 */
function accessReasonKey(code: string): MessageKey {
  switch (code) {
    case 'loopback-only':
      return 'reason.loopback'
    case 'no-address':
      return 'reason.noAddress'
    case 'interface-missing':
      return 'reason.interfaceMissing'
    default:
      return 'common.unknown'
  }
}

/**
 * Map a management refusal code to its message key.
 *
 * The host answers with stable codes, so the translation belongs here rather
 * than on the wire: the same refusal reads correctly in either language.
 *
 * @param raw - the error text from the management endpoint.
 * @returns the message key, or null for a code this page does not know.
 */
function settingsErrorKey(raw: string): MessageKey | null {
  switch (raw) {
    case 'read_only_remote':
      return 'error.readOnlyRemote'
    case 'admin_required':
      return 'error.adminRequired'
    case 'admin_password_invalid':
      return 'error.adminPasswordInvalid'
    case 'csrf':
      return 'error.csrf'
    case 'current_password_required':
      return 'error.currentPasswordRequired'
    case 'gate_disabled_requires_loopback':
      return 'error.gateDisabledRequiresLoopback'
    default:
      // An unrecognised code is passed through unchanged rather than swallowed:
      // a new host code stays visible instead of becoming a generic message.
      return null
  }
}

/**
 * The settings section component.
 *
 * Four tabs (user decision, 2026-09-24) and EXACTLY ONE QR code at any time —
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
function SettingsSection(props: { t?: Translate } = {}): ReactElement {
  // The `t` standard seat, injected because the registration declares this
  // plugin's locale namespace. A host without the locale service degrades to
  // the built-in Chinese dictionary instead of failing to mount.
  const t: Translate = props.t ?? standaloneTranslate()
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<TabId>('access')
  const [password, setPassword] = useState('')
  const [adminPassword, setAdminPassword] = useState('')
  const [unlockPassword, setUnlockPassword] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  /** Bumped per shown banner: the official Toast only restarts its hold on a remount. */
  const [toastSeq, setToastSeq] = useState(0)
  const [copied, setCopied] = useState<string | null>(null)
  const [showRecovery, setShowRecovery] = useState(false)
  const [portDraft, setPortDraft] = useState('')
  const [portCheck, setPortCheck] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [doctor, setDoctor] = useState<string[] | null>(null)
  const [doctorBusy, setDoctorBusy] = useState(false)

  // A transient confirmation: a permanent line costs a whole row of the page
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
    setToastSeq(sequence => sequence + 1)
    setError(null)
    setNotice(message)
    noticeTimer.current = setTimeout(() => {
      noticeTimer.current = null
      setNotice(null)
    }, TOAST_MS)
  }, [clearNoticeTimer])
  const fail = useCallback((message: string): void => {
    clearNoticeTimer()
    setToastSeq(sequence => sequence + 1)
    setNotice(null)
    setError(message)
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
      flash(t('toast.saved'))
    } catch (failure) {
      fail((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }, [fail, flash])

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
      flash(action === 'approve' ? t('devices.status.approved') : action === 'block' ? t('devices.group.blocked') : t('toast.unblocked'))
    } catch (failure) {
      fail((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }, [fail, flash])

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
      flash(t('toast.revoked'))
    } catch (failure) {
      fail((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }, [fail, flash])

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
      setPortCheck(t('port.invalid'))
      return
    }
    setPortCheck(t('port.checking'))
    try {
      const response = await fetch(`/plugins/dsh-lan-guard/port-check?port=${String(port)}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      const body = await response.json() as { available?: boolean }
      setPortCheck(body.available === true
        ? t('port.available', { port })
        : t('port.taken', { port }))
    } catch {
      setPortCheck(t('port.checkFailed'))
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
      lines.push(t('doctor.patches', {
          unlock: patches.settingsUnlock === true ? '✓' : '—',
          compat: patches.mobileCompat === true ? '✓' : '—',
          watchdog: patches.socketWatchdog === true ? '✓' : '—',
        }))
      const missing: string[] = []
      if (typeof AbortSignal.any !== 'function') missing.push('AbortSignal.any')
      if (typeof AbortSignal.timeout !== 'function') missing.push('AbortSignal.timeout')
      if (typeof (Promise as unknown as { withResolvers?: unknown }).withResolvers !== 'function') {
        missing.push('Promise.withResolvers')
      }
      if (typeof (globalThis as { Iterator?: unknown }).Iterator === 'undefined') missing.push('Iterator')
      lines.push(missing.length === 0
        ? t('doctor.engine.ok')
        : t('doctor.engine.missing', { list: missing.join('、') }))
      const loopback = location.origin.startsWith('https://127.0.0.1') || location.origin.startsWith('http://127.0.0.1')
      lines.push(t('doctor.origin', {
        origin: location.origin,
        kind: loopback ? t('doctor.origin.loopback') : t('doctor.origin.lan'),
      }))
      const agent = navigator.userAgent
      lines.push(t('doctor.agent', { agent: agent.slice(0, 120) }))

      const started = Date.now()
      const outcome = await new Promise<string>((resolve) => {
        let socket: WebSocket
        try {
          socket = new WebSocket(`${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}/api/remote.mux`)
        } catch (failure) {
          resolve(t('doctor.socket.create', { message: (failure as Error).message }))
          return
        }
        const timer = setTimeout(() => {
          try { socket.close() } catch { /* already gone */ }
          resolve(t('doctor.socket.timeout'))
        }, 12_000)
        socket.addEventListener('open', () => {
          clearTimeout(timer)
          resolve(t('doctor.socket.ok', { ms: Date.now() - started }))
          try { socket.close() } catch { /* already gone */ }
        })
        socket.addEventListener('error', () => {
          clearTimeout(timer)
          resolve(t('doctor.socket.failed'))
        })
        socket.addEventListener('close', (event) => {
          if (event.code === 1006) return // the abnormal path is already reported by open/error
        })
      })
      lines.push(t('doctor.socket', { host: location.host, outcome }))
      const relay = snapshot?.connection
      if (relay !== undefined) {
        lines.push(t('doctor.relay', {
          active: relay.wsActive,
          upgrades: relay.wsUpgrades,
          refused: relay.wsRefused,
          answered: relay.heartbeatAnswered,
        }))
        const last = relay.recent[0]
        if (last !== undefined) {
          lines.push(t('doctor.last', {
            state: last.upgraded ? t('doctor.last.upgraded') : t('doctor.last.refused', { status: last.status ?? '?' }),
            seconds: Math.round(last.durationMs / 1000),
            up: Math.round(last.bytesToUpstream / 1024),
            down: Math.round(last.bytesToVisitor / 1024),
            abnormal: last.upgraded && !last.sawCloseFrame ? t('doctor.last.abnormal') : '',
          }))
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
      setNotice(t('toast.enterPassword'))
      return
    }
    await write({ adminUnlock: unlockPassword })
    setUnlockPassword('')
  }

  if (error !== null && snapshot === null) {
    return createElement(
      'div',
      { className: 'lg-root' },
      createElement('style', null, SECTION_CSS),
      createElement(
        'div',
        { className: 'lg-panel' },
        stack(
          createElement('div', { className: 'lg-title' }, t('access.title')),
          note('danger', 'warning', settingsError(error, t)),
        ),
      ),
    )
  }
  if (snapshot === null) {
    return createElement(
      'div',
      { className: 'lg-root' },
      createElement('style', null, SECTION_CSS),
      createElement('p', { className: 'lg-hint' }, t('section.loading')),
    )
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
        setNotice(t('toast.copyFailed'))
      }
    })()
  }

  const goSecurity = createElement(Button, {
    variant: 'outline',
    size: 'sm',
    onClick: () => setTab('security'),
  }, t('access.setPassword'))

  // ---- tab: access -------------------------------------------------------
  // The "set a password first" action lives in the status block ONLY. It used to
  // be repeated next to the QR placeholder, which showed the same button twice
  // on the same screen.
  const qrBlock = !hasPassword
    ? stack(note('warn', 'warning', t('access.qrPending')))
    : access.unavailableReason !== undefined
      ? stack(note('warn', 'warning', t(accessReasonKey(access.unavailableReason), {
        interface: access.unavailableInterface ?? '',
      })))
      : unlocked && access.tokenQrSvg !== undefined
        ? stack(
          createElement('div', { className: 'lg-qr', dangerouslySetInnerHTML: { __html: access.tokenQrSvg } }),
          createElement('p', { className: 'lg-hint' },
            t('access.linkHint')),
        )
        : stack(
          access.qrSvg === null
            ? null
            : createElement('div', { className: 'lg-qr', dangerouslySetInnerHTML: { __html: access.qrSvg } }),
          createElement('p', { className: 'lg-hint' }, hasPassword && !unlocked
            ? t('access.qrHintLocked')
            : t('access.qrHint')),
        )

  const gatewayNote = hasPassword
    ? note('ok', 'checkCircle', listener.listenHost === '127.0.0.1'
      ? t('access.okLocal')
      : t('access.ok'))
    : listener.listenHost === '127.0.0.1'
      ? note('warn', 'warning', t('access.noPassword'))
      // Exposed AND passwordless: the gate still refuses everyone, but the
      // operator must know the port is visible on the network.
      : note('warn', 'warning', t('access.openNoPassword', { port: listener.listenPort }))

  const accessTab = [
    stack(
      cell({
        title: t('access.title'),
        desc: t('access.desc'),
        control: createElement(Tag, { tone: running ? 'success' : 'neutral' }, running ? t('status.running') : t('status.stopped')),
      }),
      gatewayNote,
      hasPassword ? null : createElement('div', { className: 'lg-actions' }, goSecurity),
    ),
    stack(
      createElement('div', {
        className: 'lg-mono lg-mono-scroll',
        title: scanUrl ?? '',
      }, scanUrl ?? '—'),
      createElement(
        'div',
        { className: 'lg-actions' },
        createElement(Button, {
          variant: 'outline',
          icon: createElement(Icons.copy, { size: 14 }),
          disabled: scanUrl === null,
          onClick: () => copy(scanUrl ?? '', 'link'),
        }, copied === 'link' ? t('common.copied') : t('common.copy')),
        scanIsPasswordless
          ? createElement(Button, {
            variant: 'ghost',
            icon: createElement(Icons.refresh, { size: 14 }),
            disabled: busy,
            onClick: () => void write({ rotateToken: true }),
          }, t('access.rotate'))
          : null,
      ),
    ),
    qrBlock,
    stack(
      note(null, 'shield', t('access.privateOnly')),
      note(null, 'info', t('access.pwaHint')),
    ),
  ]

  // ---- shared lock card --------------------------------------------------
  const lockCard = stack(createElement(
    'div',
    { className: 'lg-lock' },
    createElement(Icons.shield, { size: 28, className: 'lg-lock-icon' }),
    createElement('h3', { className: 'lg-lock-title' }, t('lock.title')),
    createElement(Tag, { tone: 'neutral' }, t('lock.tag')),
    createElement('p', { className: 'lg-lock-body' }, authStatus.hasAdminPassword
      ? t('lock.bodyAdmin')
      : t('lock.bodyFallback')),
    createElement(
      'div',
      { className: 'lg-lock-form' },
      createElement(Input, {
        className: 'lg-input-grow',
        type: 'password',
        autoComplete: 'current-password',
        placeholder: t('lock.placeholder'),
        value: unlockPassword,
        onChange: (event: { target: { value: string } }) => setUnlockPassword(event.target.value),
        onKeyDown: (event: { key: string }) => {
          if (event.key === 'Enter') void submitUnlock()
        },
      }),
      createElement(Button, {
        variant: 'primary',
        disabled: busy,
        onClick: () => void submitUnlock(),
      }, t('lock.submit')),
    ),
    createElement('button', {
      type: 'button',
      className: 'lg-link',
      onClick: () => setShowRecovery(!showRecovery),
    }, t('lock.recover')),
    showRecovery
      ? createElement(
        'div',
        { className: 'lg-recover' },
        createElement('p', null, t('lock.recoverTitle')),
        createElement('p', null,
          t('lock.recoverLocal')),
        createElement('p', null,
          t('lock.recoverHeadless')
          + t('lock.recoverHeadlessAfter')),
      )
      : null,
  ))

  // ---- tab: security -----------------------------------------------------
  const securityTab = locked ? [lockCard] : [
    stack(
      createElement('div', { className: 'lg-title' }, t('tab.security')),
      createElement('p', { className: 'lg-lead' }, t('security.lead')),
      createElement('p', { className: 'lg-hint' },
        t('security.intro')),
    ),
    stack(
      createElement('div', { className: 'lg-label' }, t('security.mode')),
      choiceGroup({
        choices: MODE_CHOICES.map(choice => ({
          id: choice.id, title: t(choice.titleKey), detail: t(choice.detailKey),
        })),
        value: preferences.mode,
        disabled: busy,
        onPick: (id: string) => void write({ preferences: { mode: id } }),
      }),
    ),
    field(
      authStatus.hasPassword ? t('security.accessSet') : t('security.accessUnset'),
      createElement(Input, {
        className: 'lg-input-grow',
        type: 'password',
        autoComplete: 'new-password',
        placeholder: t('security.newAccess'),
        value: password,
        disabled: busy,
        onChange: (event: { target: { value: string } }) => setPassword(event.target.value),
      }),
      createElement(Button, {
        variant: 'primary',
        disabled: busy || password === '',
        onClick: () => {
          void write({ setPassword: { next: password } }).then(() => setPassword(''))
        },
      }, t('access.setPassword')),
    ),
    field(
      authStatus.hasAdminPassword ? t('security.adminSet') : t('security.adminUnset'),
      createElement(Input, {
        className: 'lg-input-grow',
        type: 'password',
        autoComplete: 'new-password',
        placeholder: t('security.newAdmin'),
        value: adminPassword,
        disabled: busy,
        onChange: (event: { target: { value: string } }) => setAdminPassword(event.target.value),
      }),
      createElement(Button, {
        variant: 'outline',
        disabled: busy || adminPassword === '',
        onClick: () => {
          void write({ setAdminPassword: { next: adminPassword } }).then(() => setAdminPassword(''))
        },
      }, t('security.setAdmin')),
    ),
    toggleCell({
      title: t('security.loopback'),
      desc: t('security.loopbackDesc'),
      checked: preferences.allowLoopback,
      disabled: busy,
      onChange: (next: boolean) => void write({ preferences: { allowLoopback: next } }),
    }),
    // The management policy had NO control at all until 2026-09-26: the host
    // accepted the write and the README promised the switch, but POLICY_CHOICES
    // was dead code, so `adminPolicy` could only be changed by hand-editing the
    // profile patch. It is load-bearing for the remote workspace picker, which
    // needs `password_unlock` or `open` to serve a LAN device at all.
    stack(
      createElement('div', { className: 'lg-label' }, t('security.policy')),
      createElement('p', { className: 'lg-hint' },
        t('security.policyDesc')),
      choiceGroup({
        choices: POLICY_CHOICES.map(choice => ({
          id: choice.id, title: t(choice.titleKey), detail: t(choice.detailKey),
        })),
        value: preferences.adminPolicy,
        disabled: busy,
        onPick: (id: string) => void write({ preferences: { adminPolicy: id } }),
      }),
    ),
    toggleCell({
      title: t('security.adminProtection'),
      desc: t('security.adminProtectionDesc'),
      checked: preferences.adminProtection,
      disabled: busy,
      onChange: (next: boolean) => void write({ preferences: { adminProtection: next } }),
    }),
    stack(note(null, 'shield',
      t('security.storageNote'))),
  ]

  // ---- tab: devices (P4-g) ----------------------------------------------
  const when = (ms: number | null): string => (ms === null ? '—' : new Date(ms).toLocaleString('zh-CN'))
  const deviceGroups = [
    { key: 'pending', title: t('devices.group.pending'), list: snapshot.devices.filter(entry => entry.status === 'pending') },
    { key: 'approved', title: t('devices.group.approved'), list: snapshot.devices.filter(entry => entry.status === 'approved') },
    { key: 'blocked', title: t('devices.group.blocked'), list: snapshot.devices.filter(entry => entry.status === 'blocked') },
  ]
  const statusTag = (status: string): ReactElement => createElement(
    Tag,
    { tone: status === 'blocked' ? 'danger' : status === 'pending' ? 'warning' : 'success' },
    status === 'blocked' ? t('devices.group.blocked') : status === 'pending' ? t('devices.group.pending') : t('devices.status.approved'),
  )
  const devButton = (label: string, action: string, id: string, danger: boolean): ReactElement =>
    createElement(Button, {
      variant: danger ? 'outline' : 'ghost',
      size: 'sm',
      disabled: busy,
      onClick: () => void deviceAction(id, action),
    }, label)
  const devicesTab = locked ? [lockCard] : [
    stack(
      createElement('div', { className: 'lg-title' }, t('tab.devices')),
      createElement('p', { className: 'lg-lead' }, t('devices.lead')),
      createElement('p', { className: 'lg-hint' },
        t('devices.intro')),
    ),
    toggleCell({
      title: t('devices.requirePairing'),
      desc: t('devices.requirePairingDesc'),
      checked: preferences.requirePairing,
      disabled: busy,
      onChange: (next: boolean) => void write({ preferences: { requirePairing: next } }),
    }),
    toggleCell({
      title: t('devices.requireApproval'),
      desc: t('devices.requireApprovalDesc'),
      hint: t('devices.approvalHint'),
      checked: preferences.requireApproval,
      disabled: busy,
      onChange: (next: boolean) => void write({ preferences: { requireApproval: next } }),
    }),
    snapshot.pendingCount > 0
      ? stack(
        createElement('div', { className: 'lg-head' },
          createElement(Tag, { tone: 'warning' }, t('devices.pendingTag')),
          createElement('span', { className: 'lg-title' },
            t('devices.pendingAlert', { count: snapshot.pendingCount }))),
      )
      : null,
    stack(
      snapshot.devices.length === 0
        ? createElement('p', { className: 'lg-hint' }, t('devices.empty'))
        : createElement(
          'div',
          { className: 'lg-list' },
          ...deviceGroups
            .filter(group => group.list.length > 0)
            .flatMap(group => [
              createElement('div', { className: 'lg-title', key: `${group.key}-t` },
                `${group.title}（${String(group.list.length)}）`),
              ...group.list.map(device => createElement(
                'div',
                { key: device.id, className: 'lg-item' },
                createElement(
                  'div',
                  { className: 'lg-item-main' },
                  createElement(
                    'div',
                    { className: 'lg-item-name' },
                    createElement('span', { className: 'lg-item-label' }, device.label),
                    statusTag(device.status),
                  ),
                  createElement('div', { className: 'lg-item-meta' }, t('devices.meta', {
                    created: when(device.createdAtMs),
                    seen: when(device.lastSeenAtMs),
                    ip: device.lastIp ?? '—',
                  })),
                ),
                createElement(
                  'div',
                  { className: 'lg-item-actions' },
                  device.status === 'pending'
                    ? devButton(t('devices.approve'), 'approve', device.id, false)
                    : null,
                  device.status === 'pending'
                    ? devButton(t('devices.block'), 'block', device.id, true)
                    : device.status === 'blocked'
                      ? devButton(t('devices.unblock'), 'unblock', device.id, false)
                      : devButton(t('devices.revokeBlock'), 'block', device.id, true),
                ),
              )),
            ]),
        ),
    ),
  ]

  // ---- tab: connection ---------------------------------------------------
  const connectionTab = locked ? [lockCard] : [
    // Mobile resilience (2026-09-28). Both halves are measured facts, not
    // guesses: DSH reaps a mux socket 6 s after its Pings stop being answered,
    // and a phone that leaves Safari cannot answer them; and WebKit can leave a
    // resumed page with a WebSocket that never opens again.
    stack(
      createElement('div', { className: 'lg-title' }, t('connection.title')),
      createElement('p', { className: 'lg-lead' }, t('connection.lead')),
      createElement('p', { className: 'lg-hint' },
        t('connection.intro')),
    ),
    toggleCell({
      title: t('connection.heartbeat'),
      desc: t('connection.heartbeatDesc'),
      hint: t('connection.heartbeatHint'),
      checked: preferences.answerHeartbeat,
      disabled: busy,
      onChange: (next: boolean) => void write({ preferences: { answerHeartbeat: next } }),
    }),
    toggleCell({
      title: t('connection.watchdog'),
      desc: t('connection.watchdogDesc'),
      hint: t('connection.watchdogHint'),
      checked: preferences.socketWatchdog,
      disabled: busy,
      onChange: (next: boolean) => void write({ preferences: { socketWatchdog: next } }),
    }),
    toggleCell({
      title: t('connection.compat'),
      desc: t('connection.compatDesc'),
      hint: t('connection.compatHint'),
      checked: preferences.mobileCompat,
      disabled: busy,
      onChange: (next: boolean) => void write({ preferences: { mobileCompat: next } }),
    }),
    toggleCell({
      title: t('connection.install'),
      desc: t('connection.installDesc'),
      hint: t('connection.installHint'),
      checked: preferences.pwaInstall,
      disabled: busy,
      onChange: (next: boolean) => void write({ preferences: { pwaInstall: next } }),
    }),
    toggleCell({
      title: t('connection.scroll'),
      desc: t('connection.scrollDesc'),
      hint: t('connection.scrollHint'),
      checked: preferences.mobileScrollFix,
      disabled: busy,
      onChange: (next: boolean) => void write({ preferences: { mobileScrollFix: next } }),
    }),
    stack(
      createElement(Button, {
        variant: 'outline',
        icon: createElement(Icons.globe, { size: 14 }),
        disabled: doctorBusy,
        onClick: () => void runDoctor(),
      }, doctorBusy ? t('connection.doctorBusy') : t('connection.doctor')),
      createElement('p', { className: 'lg-hint' },
        t('connection.doctorHint')),
      doctor === null
        ? null
        : createElement(
          'div',
          { className: 'lg-mono' },
          ...doctor.map((line, index) => createElement('div', { key: `l${String(index)}` }, line)),
        ),
    ),
    stack(
      createElement('div', { className: 'lg-title' }, t('transport.title')),
      createElement('div', { className: 'lg-mono' },
        t('transport.ports', { port: listener.listenPort, upstream: listener.upstreamOrigin })),
      listener.portFallback
        ? note('warn', 'warning',
          t('transport.portBusy', {
            configured: listener.configuredPort ?? '?',
            port: listener.listenPort,
          }))
        : null,
    ),
    // The bind scope comes first because it is the most consequential setting
    // on this page: it decides whether the LAN can reach the port at all. Both
    // choices keep the gate and TLS in force — this is not a "security off"
    // switch.
    stack(
      createElement('div', { className: 'lg-label' }, t('scope.label')),
      choiceGroup({
        choices: [
          {
            id: '0.0.0.0',
            title: t('scope.lan'),
            detail: t('scope.lanDetail'),
          },
          {
            id: '127.0.0.1',
            title: t('security.policy.local'),
            detail: t('scope.localDetail'),
          },
        ],
        value: listener.listenHost,
        disabled: busy,
        onPick: (id: string) => void write({ preferences: { listenHost: id } }),
      }),
      listener.listenHost === '0.0.0.0' || listener.listenHost === '127.0.0.1'
        ? null
        : createElement('p', { className: 'lg-hint' },
          t('scope.custom', { host: listener.listenHost })),
      listener.listenHost === '127.0.0.1'
        ? null
        : createElement('p', { className: 'lg-hint' },
          t('scope.hint')),
    ),
    // DSH's OFFICIAL settings surface is loopback-only: any page whose address
    // bar is not 127.0.0.1/localhost gets `persistence = "memory"`, so
    // Settings → Models reports "settings are unavailable in this browser" on
    // every LAN device. This switch puts DSH's own `ownsHost` flag into the
    // served index, which is what the desktop shell sets, so those pages work
    // through the gateway too.
    toggleCell({
      title: t('unlock.title'),
      desc: t('unlock.desc'),
      hint: t('unlock.hint'),
      checked: preferences.settingsUnlock,
      disabled: busy,
      onChange: (next: boolean) => void write({ preferences: { settingsUnlock: next } }),
    }),
    field(
      t('port.label'),
      createElement(
        'div',
        { className: 'lg-cell' },
        createElement('input', {
          className: 'lg-input',
          style: { flex: '1 1 auto', minWidth: 0 },
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
        createElement(Button, {
          variant: 'outline',
          disabled: busy || portDraft === ''
            || portDraft === String(listener.configuredPort ?? listener.listenPort),
          onClick: () => {
            void write({ preferences: { listenPort: Number.parseInt(portDraft, 10) } })
              .then(() => { setPortDraft(''); setPortCheck(null) })
          },
        }, t('port.save')),
      ),
      portCheck === null ? null : createElement('p', { className: 'lg-hint' }, portCheck),
      createElement('p', { className: 'lg-hint' },
        t('port.hint', { default: DEFAULT_PORT_HINT, max: 10 })),
      // The port is part of the ORIGIN, and this page can change it while an
      // installed app is pointed at the old one. Stated here rather than left
      // to be discovered: the app and the CA trust both break silently.
      createElement('p', { className: 'lg-hint' }, t('port.originNotice')),
    ),
    field(
      t('nic.label'),
      createElement(
        'select',
        {
          className: 'lg-input',
          value: preferences.networkInterface,
          disabled: busy,
          onChange: (event: { target: { value: string } }) =>
            void write({ preferences: { networkInterface: event.target.value } }),
        },
        createElement('option', { value: '' }, t('nic.auto')),
        ...access.addresses.map(entry => createElement('option', {
          key: `${entry.interface}:${entry.address}`,
          value: entry.interface,
        }, entry.virtual
          ? t('nic.optionVirtual', {
            name: entry.interface,
            address: entry.address,
            reason: entry.virtualReason ?? t('common.unknown'),
          })
          : t('nic.option', { name: entry.interface, address: entry.address }))),
      ),
      createElement('p', { className: 'lg-hint' },
        t('nic.hint')),
    ),
    stack(
      createElement('div', { className: 'lg-label' }, t('tls.label')),
      choiceGroup({
        choices: [
          { id: 'self-signed', title: t('tls.selfSigned'), detail: t('tls.selfSignedDetail') },
          { id: 'off', title: t('tls.off'), detail: t('tls.offDetail') },
        ],
        value: 'self-signed',
        disabled: busy,
        onPick: () => setNotice(t('tls.notYet')),
      }),
      access.tlsMode === 'off'
        ? note('danger', 'warning',
          t('tls.offNotice'))
        : null,
      access.caFingerprint === null
        ? null
        : createElement('div', { className: 'lg-mono' },
          t('tls.caFingerprint', { fingerprint: access.caFingerprint })),
      access.caFingerprint === null
        ? null
        : createElement('p', { className: 'lg-hint' },
          t('tls.caHint')),
      createElement('p', { className: 'lg-hint' },
        t('net.count', {
          count: access.addresses.length,
          virtual: access.addresses.some(a => a.virtual) ? t('net.virtualSuffix') : '',
        })),
    ),
  ]

  // Only meaningful for a REMOTE session that had to unlock; the operator's own
  // machine is never locked, so the notice there is pure noise.
  const unlockBanner = authStatus.adminUnlocked && !locked && authStatus.localAccess === false
    ? stack(
      note('info', 'info', t('banner.unlocked')),
      createElement('div', { className: 'lg-actions' },
        createElement(Button, {
          variant: 'outline',
          size: 'sm',
          onClick: () => void write({ adminLock: true }),
        }, t('banner.relock'))),
    )
    : null

  const readOnlyBanner = readOnly
    ? stack(note('warn', 'warning',
      t('banner.readOnly')))
    : null

  // Update detection row (SPEC F8). Read-only: the host never installs
  // anything; it reports and offers a copyable command.
  const repoUrl = 'https://github.com/idoall/dsh-lan-guard'
  const updateRow = createElement(
    'div',
    { className: 'lg-update' },
    createElement(Tag, { tone: update !== null && update.hasUpdate ? 'warning' : 'neutral' },
      update === null
        ? t('update.checking')
        : update.error !== null
          ? t('update.failed', { current: update.current })
          : update.hasUpdate
            ? t('update.available', { current: update.current, latest: update.latest ?? '' })
            : t('update.current', { current: update.current })),
    createElement(Button, {
      variant: 'outline',
      size: 'sm',
      icon: createElement(Icons.refresh, { size: 14 }),
      disabled: updateBusy,
      onClick: () => void loadUpdate(true),
    }, updateBusy ? t('update.busy') : t('update.check')),
    textLink('g', repoUrl, t('update.github')),
    textLink('c', `${repoUrl}/blob/main/CHANGELOG.md`, t('update.changelog')),
    textLink('i', `${repoUrl}/issues`, t('update.issue')),
  )

  const updatePanel = update !== null && update.hasUpdate
    ? [
      createElement('div', { className: 'lg-title', key: 't' },
        t('update.found', { latest: update.latest ?? '', current: update.current })),
      createElement('div', {
        key: 'c',
        className: 'lg-mono lg-mono-scroll',
        title: `dsh plugin --profile web add dsh-lan-guard@${String(update.latest)}`,
      }, `dsh plugin --profile web add dsh-lan-guard@${String(update.latest)}`),
      createElement('div', { className: 'lg-actions', key: 'a' },
        createElement(Button, {
          variant: 'outline',
          icon: createElement(Icons.copy, { size: 14 }),
          onClick: () => copy(`dsh plugin --profile web add dsh-lan-guard@${String(update.latest)}`, 'update'),
        }, copied === 'update' ? t('common.copied') : t('update.copyCommand'))),
      createElement('p', { className: 'lg-hint', key: 'h' },
        t('update.installHint')),
    ]
    : null

  const bannerText = error !== null ? settingsError(error, t) : notice
  const closeBanner = error === null ? dismissNotice : (): void => setError(null)
  const banner = bannerText === null
    ? null
    : OfficialToast !== undefined
      ? createElement(OfficialToast, {
        key: `toast-${String(toastSeq)}`,
        text: bannerText,
        tone: error === null ? 'success' : undefined,
        icon: error === null ? undefined : createElement(Icons.warningTriangle, { size: 16 }),
        holdMs: TOAST_MS,
        onDone: closeBanner,
      })
      : fallbackToast({
        // Sequenced exactly like the official banner: without a remount the
        // countdown bar and the dismissal timer would keep the FIRST show's
        // deadline (see the Toast primitive's own contract).
        seq: toastSeq,
        tone: error === null ? 'info' : 'danger',
        text: bannerText,
        icon: error === null
          ? createElement(Icons.checkCircle, { size: 16 })
          : createElement(Icons.warningTriangle, { size: 16 }),
        closeLabel: t('common.close'),
        onClose: closeBanner,
      })

  return createElement(
    'div',
    { className: 'lg-root' },
    createElement('style', null, SECTION_CSS),
    banner,
    updateRow,
    updatePanel === null ? null : stack(...updatePanel),
    createElement(
      'div',
      { className: 'lg-tabbar' },
      createElement(SegmentedTabs as (props: {
        items: readonly [SegmentedTab<TabId>, ...SegmentedTab<TabId>[]]
        value: TabId
        onChange: (value: TabId) => void
        label: string
      }) => ReactNode, {
        items: tabItems(t),
        value: tab,
        onChange: setTab,
        label: t('tablist'),
      }),
    ),
    createElement(
      'div',
      {
        className: 'lg-panel',
        id: `lg-panel-${tab}`,
        role: 'tabpanel',
        'aria-labelledby': `lg-tab-${tab}`,
      },
      unlockBanner,
      readOnlyBanner,
      ...(tab === 'access'
        ? accessTab
        : tab === 'security' ? securityTab : tab === 'devices' ? devicesTab : connectionTab),
    ),
  )
}

/** Default port shown as a hint in the port field. */
const DEFAULT_PORT_HINT = 3081

/**
 * How long a transient confirmation stays on screen.
 *
 * The single source of truth: the fallback banner's countdown bar reads it as
 * an animation duration and the dismissal timer is armed with it, so the bar
 * can never outlive (or predecease) the toast. The official Toast, when the
 * host ships one, receives it as its hold.
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
  // The official locale service, taken OPTIONALLY rather than through Cordis
  // `inject`: a hard requirement would make the whole section disappear on a
  // composition that ships no locale plugin, and the page can still speak its
  // built-in Chinese there. When the service IS present — every DSH web client
  // provides it — the section follows 设置 → 通用设置 → 语言 and re-renders on a
  // switch without a reload.
  const locale = optionalService(ctx, 'locale') as LocaleServiceLike | undefined
  if (locale !== undefined) {
    // Registered as the plugin's own effect, the way the official packages do
    // it, so the dictionary leaves with the plugin.
    ctx.effect?.(() => locale.register(LOCALE_NS, { zh: ZH_DICTIONARY, en: EN_DICTIONARY }))
  }
  const bound = locale?.bind(LOCALE_NS) ?? standaloneTranslate()

  ctx.slots.inject(SEAT, () => ctx.slots.register({
    name: SEAT,
    id: PLUGIN_ID,
    order: 100,
    // A thunk, not a string: the nav row is re-read per render, so the label
    // follows the active locale without re-registering the section (the
    // official SlotLabel contract).
    label: () => bound('nav'),
    // Declaring the namespace puts the framework's `t` seat on this entry,
    // which is what makes the body re-render on a language switch. It is
    // declared only when the service exists: an entry that declares a locale
    // namespace without the locale plugin is an assembly failure.
    ...locale === undefined ? {} : { locale: LOCALE_NS },
  }, SettingsSection))
  // The remote workspace picker: an independent second client contribution.
  // It shadows the official directory-flow occupant for REMOTE browsers only
  // (see client/workspace-flow.ts), so a phone can add a workspace even though
  // DSH resolved its own picker to the HOST's OS dialog.
  applyDirectoryFlow(ctx, { t: bound })
}

module.exports = {
  name: PLUGIN_ID,
  inject: ['slots'],
  apply,
}
