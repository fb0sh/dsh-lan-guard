/**
 * dsh-lan-guard — the host half of the remote workspace picker.
 *
 * WHY THIS EXISTS
 *
 * DSH resolves its directory-picker seam exactly ONCE at boot
 * (`@deepseek-ai/dsh-host-directory-picker-auto`): a loopback-only bind plus a
 * servable display resolves to the `native` backend. DSH's own web server binds
 * loopback by design — that is the premise of this whole plugin — so on macOS
 * and Windows the resolution IS `native`, and "添加工作区" opens an OS folder
 * dialog ON THE HOST SCREEN. A browser that arrived through the LAN gateway
 * therefore sees the button do nothing at all: the dialog is on the other
 * computer (reported 2026-09-26).
 *
 * The seam cannot be re-resolved per client, and pinning DSH's own `-browse`
 * pair would take the native dialog away from the machine's operator as well.
 * So the browser half shadows the official occupant (a lower slot priority
 * renders instead of it) and, for REMOTE clients only, drives this module: a
 * single-level directory listing served from the management surface.
 *
 * WHAT THIS MODULE NEVER DOES
 *
 * It only READS directory names. Registering the chosen path stays with DSH's
 * own workspace flow (`onPicked` → the official `workspaces.create`), so no
 * workspace is ever created here and no `workspaceRegistry` dependency is
 * needed. Reading the host's directory tree is still a privileged operation,
 * which is why the route that calls this module carries the same authority as
 * every other management call (see `settings/routes.ts`).
 *
 * SECURITY POSTURE (mirrors the researched reference implementation)
 *
 * - only fully-qualified absolute paths (a bare `foo` or Windows `\foo` is
 *   refused rather than silently resolved against the process cwd);
 * - EVERY path segment is checked against a sensitive-name list (`.ssh`,
 *   `.aws`, `.env`, `id_rsa`, …), before AND after symlink resolution;
 * - system prefixes (`/etc`, `/proc`, `/dev`, …) are refused on the realpath
 *   too, so a symlink cannot escape the fence;
 * - one listing never returns more than {@link MAX_ENTRIES} rows.
 */
import { mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, parse, resolve, sep } from 'node:path'

/**
 * Largest number of rows one directory level may return.
 *
 * Same ceiling the reference implementation and GitHub's web directory view
 * use; a truncated level reports `truncated: true` so the page can say so
 * instead of pretending the directory ends there.
 */
export const MAX_ENTRIES = 1000

/** One selectable row. */
/*
 * NOT localizable, deliberately: the `message` on every refusal below is a
 * DIAGNOSTIC. The page never renders it — `picker-logic` maps the stable
 * `error` code to a translated notice and shows that instead — so these strings
 * stay out of the dictionaries. Turning them into keys would put copy on the
 * wire that no user ever reads.
 */

export interface BrowseEntry {
  /** The display name (one path segment). */
  name: string
  /**
   * A message key for the name, when it is plugin copy rather than a real
   * path segment.
   *
   * The five fixed shortcuts are words ("Home", "Desktop"), so they are sent as
   * keys and translated by the page, which knows the active language. Real
   * directory names — and the Windows drive letter — have no key and are
   * displayed verbatim.
   */
  nameKey?: string
  /** Placeholders for {@link nameKey}. */
  nameParams?: Record<string, string>
  /** The absolute path to hand back to DSH's workspace flow. */
  path: string
  /** A dot-prefixed entry; the page dims it but still offers it. */
  hidden: boolean
}

/** One jump target in the breadcrumb. */
export interface BrowseCrumb {
  /** The display name; the filesystem root keeps its full path. */
  name: string
  path: string
}

/** A successful listing. */
export interface BrowseListing {
  ok: true
  /** The canonical (symlink-resolved) directory being listed. */
  path: string
  /** Root → current ancestor chain, each a jump target. */
  crumbs: BrowseCrumb[]
  /** Shortcut rows: home, Desktop/Documents/Downloads when they exist, and the root. */
  quick: BrowseEntry[]
  /** Sub-directories of `path`, name-sorted. */
  entries: BrowseEntry[]
  /** Whether `entries` was cut off at {@link MAX_ENTRIES}. */
  truncated: boolean
}

/** Stable failure codes the page maps to a message. */
export type BrowseErrorCode =
  | 'invalid_path'
  | 'not_absolute'
  | 'not_found'
  | 'not_a_directory'
  | 'unreadable'
  | 'blocked'
  /** A folder of that name already exists. */
  | 'exists'
  /** `mkdir` refused for a reason that is not "already there". */
  | 'create_failed'

/** A refused listing. */
export interface BrowseFailure {
  ok: false
  error: BrowseErrorCode
  /** Operator-facing detail; never contains a credential. */
  message: string
}

/** The listing outcome. */
export type BrowseResult = BrowseListing | BrowseFailure

/**
 * Names that are never listed, never entered, and never accepted as a target.
 *
 * The list is the union of the reference implementation's and the obvious
 * credential stores; matching is case-insensitive so a macOS case-insensitive
 * volume cannot smuggle `.SSH` past it.
 */
const SENSITIVE_NAMES = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.git',
  '.svn',
  '.hg',
  '.env',
  '.npmrc',
  '.netrc',
  '.bash_history',
  '.zsh_history',
  '.profile',
  '.bash_profile',
  '.bashrc',
  '.zshrc',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'credentials',
  'shadow',
  'passwd',
  'system volume information',
  '$recycle.bin',
])

/** POSIX system prefixes, refused on the requested path AND on its realpath. */
const POSIX_BLOCKED_PREFIXES = [
  '/etc',
  '/root',
  '/sys',
  '/proc',
  '/dev',
  '/boot',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/usr/bin',
  '/usr/sbin',
  '/private/etc',
  '/private/var/db',
  '/private/var/root',
  '/var/run',
  '/var/root',
  '/Library/Keychains',
  '/System/Library',
]

/**
 * Windows system prefixes, compared against the part AFTER the drive letter
 * (or against a UNC path, which is refused outright).
 */
const WINDOWS_BLOCKED_PREFIXES = [
  'windows',
  'winnt',
  'program files',
  'program files (x86)',
  'system volume information',
  '$recycle.bin',
  'recovery',
  'perflogs',
  'boot',
  'programdata\\microsoft',
]

/** Whether this process is Windows. */
const IS_WINDOWS = process.platform === 'win32'

/** Whether one path segment is a sensitive name. */
export function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAMES.has(name.trim().toLowerCase())
}

/**
 * Whether a path is FULLY QUALIFIED.
 *
 * `isAbsolute` alone is not enough on Windows: `\foo` and `/foo` are "rooted"
 * without naming a drive, so they resolve against the process's current drive
 * and are not the fixed location the caller meant. Both forms are refused, as
 * are UNC paths (a network share is not this machine's directory tree).
 *
 * @param candidate - the trimmed caller-supplied path.
 * @returns whether the path names one fixed location.
 */
export function isFullyQualified(candidate: string): boolean {
  if (!IS_WINDOWS) return isAbsolute(candidate)
  if (/^[A-Za-z]:[\\/]/.test(candidate)) return true
  // A complete UNC prefix is still refused (see `isBlockedAbsolute`), but it is
  // recognized here so the error code says "blocked", not "not absolute".
  return /^\\\\[^\\/]+[\\/][^\\/]+/.test(candidate)
}

/** The comparison key for one absolute path (case-insensitive on Windows). */
function key(path: string): string {
  return IS_WINDOWS ? path.toLowerCase() : path
}

/**
 * Whether an absolute path sits in (or IS) a blocked system location.
 *
 * @param absolutePath - a resolved absolute path.
 * @returns the offending prefix, or `undefined` when the path is allowed.
 */
export function blockedPrefixOf(absolutePath: string): string | undefined {
  const normalized = key(absolutePath)
  if (IS_WINDOWS) {
    if (normalized.startsWith('\\\\')) return '\\\\ (UNC)'
    const rest = /^[a-z]:\\(.*)$/.exec(normalized)?.[1]
    if (rest === undefined) return undefined
    for (const prefix of WINDOWS_BLOCKED_PREFIXES) {
      if (rest === prefix || rest.startsWith(`${prefix}\\`)) return prefix
    }
    return undefined
  }
  for (const prefix of POSIX_BLOCKED_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(`${prefix}${sep}`)) return prefix
  }
  return undefined
}

/**
 * Resolve one caller-supplied path to the canonical directory it names.
 *
 * The order matters: the cheap shape checks run first, then every segment is
 * screened, and only then is the path resolved through the filesystem — so a
 * symlink is followed to its real target and the WHOLE fence is applied again
 * to that target. A symlink therefore cannot be used to reach a blocked
 * directory, and a symlink cannot be used to reach a sensitive one either.
 *
 * @param raw - the caller-supplied path (`?path=` or a body field).
 * @returns the canonical directory path, or a stable failure.
 */
export async function resolveBrowsablePath(raw: unknown): Promise<{ ok: true; path: string } | BrowseFailure> {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, error: 'invalid_path', message: '路径不能为空' }
  }
  const candidate = raw.trim()
  if (candidate.includes('\0')) {
    return { ok: false, error: 'invalid_path', message: '路径包含非法字符' }
  }
  if (!isFullyQualified(candidate)) {
    return { ok: false, error: 'not_absolute', message: '必须使用完整的绝对路径' }
  }

  const resolved = resolve(candidate)
  const segments = resolved.split(/[\\/]/).filter(part => part !== '')
  for (const segment of segments) {
    if (isSensitiveName(segment)) {
      return { ok: false, error: 'blocked', message: `禁止访问敏感目录「${segment}」` }
    }
  }
  const directBlock = blockedPrefixOf(resolved)
  if (directBlock !== undefined) {
    return { ok: false, error: 'blocked', message: `禁止访问系统目录「${directBlock}」` }
  }

  let canonical: string
  try {
    canonical = await realpath(resolved)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, error: 'not_found', message: '目录不存在' }
    }
    return { ok: false, error: 'unreadable', message: `无法访问该目录（${code ?? '未知'}）` }
  }

  // Second pass, now against the PHYSICAL target: this is what stops a symlink
  // from escaping the fence after the first pass approved the link itself.
  for (const segment of canonical.split(/[\\/]/).filter(part => part !== '')) {
    if (isSensitiveName(segment)) {
      return { ok: false, error: 'blocked', message: `符号链接指向敏感目录「${segment}」` }
    }
  }
  const realBlock = blockedPrefixOf(canonical)
  if (realBlock !== undefined) {
    return { ok: false, error: 'blocked', message: `符号链接指向系统目录「${realBlock}」` }
  }

  try {
    const info = await stat(canonical)
    if (!info.isDirectory()) {
      return { ok: false, error: 'not_a_directory', message: '该路径不是文件夹' }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { ok: false, error: 'unreadable', message: `无法访问该目录（${code ?? '未知'}）` }
  }
  return { ok: true, path: canonical }
}

/** The filesystem root for this platform (`/`, or the current drive's root). */
function rootOf(path: string): string {
  return parse(path).root === '' ? sep : parse(path).root
}

/**
 * Build the root → current breadcrumb chain.
 *
 * Each crumb is a jump target, and the root keeps its full path as its name
 * (`/` on POSIX, `C:\` on Windows) because that is what it actually is.
 *
 * @param current - the canonical directory being listed.
 * @returns the chain, root first.
 */
export function crumbsOf(current: string): BrowseCrumb[] {
  const crumbs: BrowseCrumb[] = []
  let cursor = current
  for (;;) {
    const root = rootOf(cursor)
    const name = basename(cursor)
    crumbs.push({ name: name === '' ? cursor : name, path: cursor })
    if (key(cursor) === key(root)) break
    const parent = resolve(cursor, '..')
    if (key(parent) === key(cursor)) break
    cursor = parent
  }
  return crumbs.reverse()
}

/** Shortcut rows that exist on this machine. */
async function quickAccess(): Promise<BrowseEntry[]> {
  const home = homedir()
  const rows: BrowseEntry[] = [
    { name: 'Home', nameKey: 'quick.home', path: home, hidden: false },
  ]
  const named: readonly { name: string; nameKey: string; segment: string }[] = [
    { name: 'Desktop', nameKey: 'quick.desktop', segment: 'Desktop' },
    { name: 'Documents', nameKey: 'quick.documents', segment: 'Documents' },
    { name: 'Downloads', nameKey: 'quick.downloads', segment: 'Downloads' },
    { name: 'Projects', nameKey: 'quick.projects', segment: 'Projects' },
    { name: 'code', nameKey: 'quick.code', segment: 'code' },
    { name: 'src', nameKey: 'quick.src', segment: 'src' },
  ]
  for (const item of named) {
    const candidate = join(home, item.segment)
    try {
      const info = await stat(candidate)
      if (info.isDirectory()) {
        rows.push({ name: item.name, nameKey: item.nameKey, path: candidate, hidden: false })
      }
    } catch {
      // A missing shortcut is not an error; the row simply does not exist.
    }
  }
  rows.push(IS_WINDOWS
    ? {
      name: `${parse(home).root} drive root`,
      nameKey: 'quick.driveRoot',
      nameParams: { drive: parse(home).root },
      path: rootOf(home),
      hidden: false,
    }
    : { name: 'Root', nameKey: 'quick.root', path: rootOf(home), hidden: false })
  return rows
}

/**
 * List one directory level.
 *
 * Only DIRECTORIES are returned: a workspace is a folder, so files would be
 * noise on a phone. Symlinked directories are followed (that is how macOS
 * exposes `/tmp` and friends), but each target goes through the same fence as
 * an explicitly requested path — a link to a blocked or sensitive location is
 * silently skipped rather than listed as a dead row.
 *
 * @param raw - the requested absolute path; absent or blank lists the home directory.
 * @returns the listing, or a stable failure.
 */
export async function listDirectories(raw: unknown): Promise<BrowseResult> {
  const requested = typeof raw === 'string' && raw.trim() !== '' ? raw : homedir()
  const resolved = await resolveBrowsablePath(requested)
  if (!resolved.ok) return resolved
  const current = resolved.path

  const entries: BrowseEntry[] = []
  let truncated = false
  try {
    const dirents = await readdir(current, { withFileTypes: true })
    dirents.sort((a, b) => a.name.localeCompare(b.name))
    for (const dirent of dirents) {
      if (isSensitiveName(dirent.name)) continue
      const childPath = join(current, dirent.name)
      let isDirectory = dirent.isDirectory()
      if (dirent.isSymbolicLink()) {
        const target = await resolveBrowsablePath(childPath)
        if (!target.ok) continue
        isDirectory = true
      }
      if (!isDirectory) continue
      if (entries.length >= MAX_ENTRIES) {
        truncated = true
        break
      }
      entries.push({ name: dirent.name, path: childPath, hidden: dirent.name.startsWith('.') })
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { ok: false, error: 'unreadable', message: `无法读取该目录（${code ?? '未知'}）` }
  }

  return {
    ok: true,
    path: current,
    crumbs: crumbsOf(current),
    quick: await quickAccess(),
    entries,
    truncated,
  }
}

/** A successfully created folder. */
export interface CreateListing {
  ok: true
  /** The absolute path of the folder that now exists. */
  path: string
}

/** The create outcome. */
export type CreateResult = CreateListing | BrowseFailure

/**
 * Validate one new folder name.
 *
 * Mirrors the host controller's own schema (`createDirectoryRequestSchema`):
 * a single non-blank path segment. The name is returned VERBATIM rather than
 * trimmed, because trimming would create a different sibling than the one the
 * operator typed — the official browser makes the same choice.
 *
 * @param raw - the name as typed.
 * @returns the name to create, or the refusal.
 */
export function resolveNewFolderName(raw: unknown): { ok: true; name: string } | BrowseFailure {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, error: 'invalid_path', message: '文件夹名称不能为空' }
  }
  if (raw.includes('\0') || raw.includes('/') || raw.includes('\\')) {
    return { ok: false, error: 'invalid_path', message: '文件夹名称不能包含路径分隔符' }
  }
  if (raw === '.' || raw === '..') {
    return { ok: false, error: 'invalid_path', message: '文件夹名称无效' }
  }
  // The fence applies to the CHILD as well: `.ssh` is no more acceptable as a
  // new folder than it is as a browsed one, and creating it would put a
  // credential directory inside a workspace.
  if (isSensitiveName(raw)) {
    return { ok: false, error: 'blocked', message: `禁止访问敏感目录「${raw}」` }
  }
  return { ok: true, name: raw }
}

/**
 * Create one child folder inside a browsable parent.
 *
 * The parent goes through exactly the same fence as a listing, and the child is
 * re-checked against it, so the create verb cannot reach anywhere the browse
 * verb cannot. `mkdir` is deliberately NOT recursive: a missing parent is a
 * refusal, not a silent tree.
 *
 * @param rawParent - the absolute parent directory.
 * @param rawName - the single-segment folder name.
 * @returns the created absolute path, or the refusal.
 */
export async function createDirectory(rawParent: unknown, rawName: unknown): Promise<CreateResult> {
  const name = resolveNewFolderName(rawName)
  if (!name.ok) return name
  const parent = await resolveBrowsablePath(rawParent)
  if (!parent.ok) return parent

  const child = join(parent.path, name.name)
  const directBlock = blockedPrefixOf(child)
  if (directBlock !== undefined) {
    return { ok: false, error: 'blocked', message: `禁止访问系统目录「${directBlock}」` }
  }

  try {
    await mkdir(child)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      return { ok: false, error: 'exists', message: '同名文件夹已存在' }
    }
    return { ok: false, error: 'create_failed', message: `无法创建文件夹（${code ?? '未知'}）` }
  }
  return { ok: true, path: child }
}
