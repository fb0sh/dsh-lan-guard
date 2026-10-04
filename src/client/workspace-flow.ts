/**
 * dsh-lan-guard — the browser half of the remote workspace picker.
 *
 * DSH's directory-picker seam is resolved once per PROCESS
 * (`@deepseek-ai/dsh-host-directory-picker-auto`), and because DSH's own web
 * server binds loopback that resolution is `native` on macOS/Windows: the OS
 * folder dialog opens on the HOST screen. A phone that reached this machine
 * through the LAN gateway therefore cannot add a workspace at all.
 *
 * A `single` slot renders its LOWEST-priority occupant, so this module registers
 * a shadowing occupant at {@link FLOW_PRIORITY} and decides per CLIENT:
 *
 * - a browser sitting at this machine delegates to DSH's own picker (the desktop
 *   preload when present, otherwise the official `uiWorkspace.pickDirectory()`),
 *   so the operator's OS dialog is untouched;
 * - a remote browser gets this module's own bottom-sheet directory browser,
 *   backed by one management route (`GET …/workspaces?path=…`).
 *
 * The occupant is RENDERLESS until a pick is requested, and it never registers a
 * workspace itself: it reports the chosen path through the owner's `onPicked`,
 * and DSH's own workspace flow performs the (validated, persisted) registration.
 */
import { createElement, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { Button, Icons } from './ui/kit.ts'
import { FLOW_CSS } from './ui/styles.ts'
import { standaloneTranslate, type MessageKey, type Translate } from './i18n.ts'
import {
  BROWSE_PATH,
  BrowseRequestError,
  CONFIG_PATH,
  browseErrorNotice,
  directoryFlowDecision,
  readBrowseResponse,
  readClientEnvironment,
  registerDirectoryFlow,
  type BrowseListingView,
  type FlowSlots,
  type PickerNotice,
} from './picker-logic.ts'

/** The client context surface this module needs. */
export interface DirectoryFlowContext {
  slots: FlowSlots
  /** Cordis optional service lookup; used to reach `uiWorkspace` without a hard dependency. */
  get?(name: string): unknown
}

/** Props the slot owner passes to a flow occupant. */
interface FlowProps {
  /** The owner's rising edge: one pick per `false → true` transition. */
  open: boolean
  /** True while the owner is adopting a path; the sheet stays up but is inert. */
  busy?: boolean
  onPicked(path: string): void
  onCancel(): void
  onError(message: string): void
  /** The official picker (OS dialog); throws when this host has none. */
  pick(): Promise<string | null>
  /** One directory level from the management route. */
  browse(path?: string): Promise<BrowseListingView>
  /**
   * Create one child folder and return its absolute path.
   *
   * Mirrors the official occupant's `createDirectory(path, name)` contract, but
   * through this plugin's own route: DSH's `directoryPicker` verbs need the
   * `browse` capability, and a host whose web server binds loopback resolves
   * the picker to `native` — so `list` and `createDirectory` are both refused
   * there, which is why the browse verb is plugin-owned too.
   */
  create(path: string, name: string): Promise<string>
  /** The plugin's translator, forwarded from the registration. */
  t?: Translate
}

/** The stable code of a failed request. */
function codeOf(reason: unknown): string {
  if (reason instanceof BrowseRequestError) return reason.code
  if (reason instanceof Error) return reason.message
  return String(reason)
}

/** A human message for a thrown reason. */
function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * Unlock the management console from inside the picker.
 *
 * The unlock is the ONE management write that never requires an unlocked
 * console (it IS the unlock), so this works under `password_unlock` even though
 * every other route refuses. Doing it here removes the dead end where the sheet
 * says "go unlock in Settings" and the operator has to find the lock card.
 *
 * @param password - the admin password (or the access password when no separate
 *   admin password is set, which is how the host falls back).
 */
async function postAdminUnlock(password: string, t: Translate): Promise<void> {
  const response = await fetch(CONFIG_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ adminUnlock: password }),
  })
  if (response.status === 401) throw new Error(t('error.adminPasswordInvalid'))
  if (!response.ok) throw new Error(t('picker.unlockFailed', { status: response.status }))
}

/**
 * Read one directory level from the management route.
 *
 * @param path - the directory to list; omitted lists the host's home directory.
 * @returns the listing.
 */
async function fetchListing(path?: string): Promise<BrowseListingView> {
  const query = path === undefined ? '' : `?path=${encodeURIComponent(path)}`
  const response = await fetch(`${BROWSE_PATH}${query}`, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // A non-JSON body (proxy error page, 401 HTML) is reported by its status.
    body = null
  }
  return readBrowseResponse(response.status, body)
}

/**
 * Create one folder through the management route.
 *
 * The POST body carries the parent and the single-segment name; the host applies
 * the same fence and authority checks as a listing, so this cannot reach
 * anywhere browsing cannot.
 *
 * @param path - the absolute parent directory.
 * @param name - the folder name as typed.
 * @returns the created absolute path.
 */
async function createFolder(path: string, name: string): Promise<string> {
  const response = await fetch(BROWSE_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ path, name }),
  })
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (response.status === 200) {
    const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
    if (record.ok === true && typeof record.path === 'string') return record.path
  }
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  const code = typeof record.error === 'string' && record.error !== ''
    ? record.error
    : `http_${String(response.status)}`
  throw new BrowseRequestError(code, code)
}

/** Look a client service up without requiring it. */
function optionalService(ctx: DirectoryFlowContext, name: string): unknown {
  try {
    return ctx.get?.(name)
  } catch {
    return undefined
  }
}

/**
 * The official picker for THIS browser, when it has one.
 *
 * Mirrors the official native surface: the desktop shell's preload picker wins,
 * then the client service. Either way the dialog appears on the machine the
 * browser is running on — which is exactly what makes this the LOCAL branch.
 *
 * @param ctx - the client context.
 * @returns the pick function, or `undefined` when this host has none.
 */
function officialPick(ctx: DirectoryFlowContext): (() => Promise<string | null>) | undefined {
  const scope = globalThis as unknown as { __DSH_DIRECTORY_PICKER__?: { pick?: () => Promise<string | null> } }
  const desktop = scope.__DSH_DIRECTORY_PICKER__
  if (desktop !== undefined && typeof desktop.pick === 'function') return () => desktop.pick?.() ?? Promise.resolve(null)
  const ui = optionalService(ctx, 'uiWorkspace') as { pickDirectory?: () => Promise<string | null> } | undefined
  if (ui !== undefined && typeof ui.pickDirectory === 'function') return () => ui.pickDirectory?.() ?? Promise.resolve(null)
  return undefined
}

/**
 * The shadowing flow occupant.
 *
 * Renderless until the owner opens a pick. One pick per rising `open` edge, one
 * outcome per pick — the same contract the official occupant implements, so the
 * owner cannot tell the difference.
 *
 * @param props - the owner conversation plus the injected pick/browse calls.
 * @returns the sheet while a remote pick is in flight, otherwise nothing.
 */
export function DirectoryFlow(props: FlowProps): ReactElement | null {
  const { open, pick, browse, create } = props
  // The plugin's translator rides the injected surface; a host without the
  // locale service leaves it undefined and the Chinese stand-in applies.
  const t: Translate = props.t ?? standaloneTranslate()
  const latest = useRef(props)
  latest.current = props
  const armed = useRef(false)
  const alive = useRef(true)
  const [listing, setListing] = useState<BrowseListingView | null>(null)
  const [notice, setNotice] = useState<PickerNotice | null>(null)
  /** The server's stable code behind {@link notice}; drives the inline unlock. */
  const [failureCode, setFailureCode] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [unlockPassword, setUnlockPassword] = useState('')
  const [unlockBusy, setUnlockBusy] = useState(false)
  const [unlockError, setUnlockError] = useState<string | null>(null)
  // The nested create dialog. `null` means closed; a string is the draft name,
  // so an empty draft is distinguishable from "not creating".
  const [folderDraft, setFolderDraft] = useState<string | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  /** The path a retry should re-list (the last one shown, or the home directory). */
  const lastPath = useRef<string | undefined>(undefined)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback((path?: string): void => {
    lastPath.current = path ?? lastPath.current
    setLoading(true)
    setNotice(null)
    setFailureCode(null)
    void browse(path).then(
      (next) => {
        // A listing that lands after the owner closed the flow is dropped, so a
        // cancelled pick can never repaint the sheet.
        if (!alive.current || !latest.current.open) return
        setListing(next)
        setLoading(false)
      },
      (reason: unknown) => {
        if (!alive.current || !latest.current.open) return
        setNotice(browseErrorNotice(codeOf(reason), t))
        setFailureCode(codeOf(reason))
        setLoading(false)
      },
    )
  }, [browse])

  /**
   * Create the drafted folder, then land on its parent with it selected.
   *
   * The draft is sent VERBATIM: only an all-whitespace name is rejected, because
   * trimming would create a different sibling than the one typed. Mirrors the
   * official browser's `confirmCreate`.
   */
  const confirmCreate = useCallback((): void => {
    if (listing === null || folderDraft === null || creatingFolder) return
    const name = folderDraft
    if (name.trim() === '') return
    const target = listing.path
    setCreatingFolder(true)
    setCreateError(null)
    void create(target, name).then(
      () => {
        if (!alive.current) return
        setCreatingFolder(false)
        setFolderDraft(null)
        // Land like the official flow: the target becomes the listed level and
        // the new folder appears in it.
        load(target)
      },
      (reason: unknown) => {
        if (!alive.current) return
        setCreatingFolder(false)
        const notice = browseErrorNotice(codeOf(reason), t)
        setCreateError(`${notice.title}。${notice.detail}`)
      },
    )
  }, [create, creatingFolder, folderDraft, listing, load, t])

  useEffect(() => {
    if (!open) {
      armed.current = false
      setListing(null)
      setNotice(null)
      setFailureCode(null)
      setLoading(false)
      setUnlockPassword('')
      setUnlockError(null)
      lastPath.current = undefined
      return
    }
    if (armed.current) return
    armed.current = true
    if (directoryFlowDecision(readClientEnvironment()) === 'native') {
      // The operator is sitting at this machine: hand the pick to DSH's own
      // picker so the OS dialog appears where the person can see it.
      let pending: Promise<string | null>
      try {
        pending = pick()
      } catch (reason) {
        latest.current.onError(messageOf(reason))
        return
      }
      pending.then(
        (path) => {
          if (!alive.current) return
          if (path === null) latest.current.onCancel()
          else latest.current.onPicked(path)
        },
        (reason: unknown) => {
          if (alive.current) latest.current.onError(messageOf(reason))
        },
      )
      return
    }
    load(undefined)
  }, [open, pick, load])

  // Escape cancels, matching the owner's own dialogs.
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') latest.current.onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!open) return null
  if (directoryFlowDecision(readClientEnvironment()) !== 'browse') return null
  if (props.busy === true) {
    return createElement(
      'div',
      { className: 'lgp-root' },
      createElement('style', null, FLOW_CSS),
      // The owner is adopting the path, so the surface stays up but inert: it
      // still masks the page behind it rather than letting clicks through.
      createElement('div', { className: 'lgp-mask', 'aria-hidden': true }),
      createElement('div', { className: 'lgp-busy', role: 'status' }, t('picker.adding')),
    )
  }

  const stop = (event: { stopPropagation(): void }): void => {
    event.stopPropagation()
  }
  const cancel = (): void => {
    latest.current.onCancel()
  }
  /** Unlock in place, then list the same directory again. */
  const submitUnlock = (): void => {
    if (unlockPassword === '' || unlockBusy) return
    setUnlockBusy(true)
    setUnlockError(null)
    void postAdminUnlock(unlockPassword, t).then(
      () => {
        if (!alive.current) return
        setUnlockPassword('')
        setUnlockBusy(false)
        load(lastPath.current)
      },
      (reason: unknown) => {
        if (!alive.current) return
        setUnlockError(messageOf(reason))
        setUnlockBusy(false)
      },
    )
  }
  const crumbs = listing?.crumbs ?? []
  const rows = listing?.entries ?? []
  /** The console is locked: offer the unlock right here instead of a dead end. */
  const needsUnlock = failureCode === 'admin_required'

  const listBody = loading
    ? [createElement('p', { className: 'lgp-hint', key: 'loading' }, t('common.loading'))]
    : listing === null
      // A refusal is never dressed up as "this folder is empty": the notice
      // above carries the reason, and this says so.
      ? [createElement('p', { className: 'lgp-hint', key: 'blocked' }, t('picker.unreadable'))]
      : rows.length === 0
        ? [createElement('p', { className: 'lgp-hint', key: 'empty' }, t('picker.empty'))]
        : rows.map(entry => createElement(
          'button',
          {
            key: entry.path,
            type: 'button',
            className: 'lgp-row',
            'data-hidden': entry.hidden,
            onClick: () => {
              load(entry.path)
            },
          },
          createElement('span', { className: 'lgp-dir' }, createElement(Icons.folder, { size: 16 })),
          createElement('span', { className: 'lgp-name' }, entry.name),
        ))

  return createElement(
    'div',
    { className: 'lgp-root' },
    createElement('style', null, FLOW_CSS),
    createElement('div', { className: 'lgp-mask', 'aria-hidden': true, onClick: cancel }),
    createElement(
      'div',
      {
        className: 'lgp-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('picker.title'),
        onClick: stop,
      },
      createElement(
        'div',
        { className: 'lgp-head' },
        createElement('h3', { className: 'lgp-title' }, t('picker.title')),
        createElement(
          'button',
          { type: 'button', className: 'lgp-x', 'aria-label': t('common.cancel'), onClick: cancel },
          createElement(Icons.close, { size: 14 }),
        ),
      ),
      createElement(
        'div',
        { className: 'lgp-body' },
        notice === null
          ? null
          : createElement(
            'div',
            { className: 'lgp-notice', role: 'alert' },
            createElement('h4', null, notice.title),
            createElement('p', null, notice.detail),
            needsUnlock
              ? createElement(
                'div',
                { className: 'lgp-unlock' },
                createElement('input', {
                  className: 'lgp-input',
                  type: 'password',
                  autoComplete: 'current-password',
                  placeholder: t('picker.unlockPlaceholder'),
                  value: unlockPassword,
                  disabled: unlockBusy,
                  onChange: (event: { target: { value: string } }) => {
                    setUnlockPassword(event.target.value)
                  },
                  onKeyDown: (event: { key: string }) => {
                    if (event.key === 'Enter') submitUnlock()
                  },
                }),
                createElement(Button, {
                  variant: 'primary',
                  disabled: unlockBusy || unlockPassword === '',
                  onClick: submitUnlock,
                }, unlockBusy ? t('picker.unlocking') : t('picker.unlock')),
                unlockError === null
                  ? null
                  : createElement('p', { className: 'lgp-hint' }, unlockError),
              )
              : createElement(
                'div',
                { className: 'lgp-unlock' },
                createElement(Button, {
                  variant: 'outline',
                  icon: createElement(Icons.refresh, { size: 14 }),
                  onClick: () => {
                    load(lastPath.current)
                  },
                }, t('common.retry')),
                createElement('span', { className: 'lgp-code' }, failureCode ?? ''),
              ),
          ),
        crumbs.length === 0
          ? null
          : createElement(
            'div',
            { className: 'lgp-crumbs' },
            ...crumbs.map((crumb, index) => createElement(
              'button',
              {
                key: crumb.path,
                type: 'button',
                className: 'lgp-crumb',
                'aria-current': index === crumbs.length - 1,
                onClick: () => {
                  load(crumb.path)
                },
              },
              crumb.name,
            )),
          ),
        (listing?.quick?.length ?? 0) === 0
          ? null
          : createElement(
            'div',
            { className: 'lgp-quick' },
            ...(listing?.quick ?? []).map(entry => createElement(
              'button',
              {
                key: entry.path,
                type: 'button',
                className: 'lgp-quickbtn',
                onClick: () => {
                  load(entry.path)
                },
              },
              // A host-supplied key means the name is plugin copy ("Home"),
              // not a real path segment; anything else is shown verbatim.
              entry.nameKey === undefined
                ? entry.name
                : t(entry.nameKey as MessageKey, entry.nameParams),
            )),
          ),
        createElement('div', { className: 'lgp-list' }, ...listBody),
        listing?.truncated === true
          ? createElement('p', { className: 'lgp-hint' }, t('picker.truncated'))
          : null,
      ),
      // The nested create dialog, mirroring the official browser: a title, the
      // target it names, one input (Enter creates, Escape closes), an inline
      // error, and Cancel/Create. Rendered as its own layer so the level
      // underneath stays visible but inert.
      folderDraft === null ? null : createElement(
        'div',
        { className: 'lgp-create-layer' },
        createElement(
          'div',
          { className: 'lgp-create', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('picker.newFolder') },
          createElement('h3', { className: 'lgp-title' }, t('picker.newFolder')),
          createElement('p', { className: 'lgp-hint' },
            t('picker.createIn', { name: listing?.path ?? '' })),
          createElement('input', {
            className: 'lgp-input',
            type: 'text',
            value: folderDraft,
            placeholder: t('picker.untitledFolder'),
            'aria-label': t('picker.folderName'),
            autoFocus: true,
            disabled: creatingFolder,
            onChange: (event: { target: { value: string } }) => {
              setFolderDraft(event.target.value)
              setCreateError(null)
            },
            onKeyDown: (event: { key: string; preventDefault: () => void; stopPropagation: () => void }) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                confirmCreate()
              }
              if (event.key === 'Escape') {
                event.stopPropagation()
                if (!creatingFolder) setFolderDraft(null)
              }
            },
          }),
          createError === null
            ? null
            : createElement('p', { className: 'lgp-hint lgp-error', role: 'alert' }, createError),
          createElement(
            'div',
            { className: 'lgp-create-actions' },
            createElement(Button, {
              variant: 'outline',
              disabled: creatingFolder,
              onClick: () => { setFolderDraft(null) },
            }, t('common.cancel')),
            createElement(Button, {
              variant: 'primary',
              disabled: creatingFolder || folderDraft.trim() === '',
              onClick: confirmCreate,
            }, creatingFolder ? t('picker.creating') : t('picker.create')),
          ),
        ),
      ),
      createElement(
        'div',
        { className: 'lgp-foot' },
        createElement('div', { className: 'lgp-path', title: listing?.path ?? '' }, listing?.path ?? ''),
        createElement(
          'div',
          { className: 'lgp-actions' },
          createElement(Button, {
            variant: 'outline',
            icon: createElement(Icons.plus, { size: 14 }),
            disabled: listing === null || loading,
            onClick: () => {
              setFolderDraft('')
              setCreateError(null)
            },
          }, t('picker.newFolder')),
          createElement(Button, { variant: 'outline', onClick: cancel }, t('common.cancel')),
          createElement(Button, {
            variant: 'primary',
            disabled: listing === null,
            onClick: () => {
              if (listing !== null) latest.current.onPicked(listing.path)
            },
          }, t('picker.use')),
        ),
      ),
    ),
  )
}

/**
 * Register the shadowing occupant into both directory-flow holes.
 *
 * @param ctx - the client plugin context.
 */
export function applyDirectoryFlow(ctx: DirectoryFlowContext, i18n: { t: Translate }): void {
  const pick = (): Promise<string | null> => {
    const official = officialPick(ctx)
    if (official === undefined) {
      throw new Error(i18n.t('picker.noPicker'))
    }
    return official()
  }
  registerDirectoryFlow(ctx.slots, DirectoryFlow, {
    pick, browse: fetchListing, create: createFolder, t: i18n.t,
  })
}
