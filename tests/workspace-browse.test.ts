/**
 * Remote workspace picker — host half.
 *
 * The fence is the whole point of this module, so the tests exercise it against
 * a REAL filesystem: symlinks are created, sensitive directories are created,
 * and the assertions are about what a remote device could actually reach.
 */
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_ENTRIES,
  blockedPrefixOf,
  createDirectory,
  crumbsOf,
  isFullyQualified,
  isSensitiveName,
  listDirectories,
  resolveBrowsablePath,
} from '../src/workspace/browse.ts'

let scratch: string

beforeEach(async () => {
  const root = join(process.cwd(), '.tmp', 'test-data')
  await mkdir(root, { recursive: true })
  scratch = await mkdtemp(join(root, 'browse-'))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

/** Create a directory under the scratch root and return its path. */
async function dir(...segments: string[]): Promise<string> {
  const path = join(scratch, ...segments)
  await mkdir(path, { recursive: true })
  return path
}

describe('path shape', () => {
  it('accepts a POSIX absolute path and refuses everything else', () => {
    expect(isFullyQualified('/Users/someone/project')).toBe(true)
    expect(isFullyQualified('project')).toBe(false)
    expect(isFullyQualified('./project')).toBe(false)
    expect(isFullyQualified('')).toBe(false)
  })

  it('matches sensitive names case-insensitively and trims', () => {
    expect(isSensitiveName('.ssh')).toBe(true)
    expect(isSensitiveName('.SSH')).toBe(true)
    expect(isSensitiveName(' id_rsa ')).toBe(true)
    expect(isSensitiveName('.env')).toBe(true)
    expect(isSensitiveName('src')).toBe(false)
    expect(isSensitiveName('ssh')).toBe(false)
  })

  it('refuses system prefixes on the path itself and below it', () => {
    expect(blockedPrefixOf('/etc')).toBe('/etc')
    expect(blockedPrefixOf('/etc/hosts')).toBe('/etc')
    expect(blockedPrefixOf('/etcetera')).toBeUndefined()
    expect(blockedPrefixOf('/Users/someone')).toBeUndefined()
  })
})

describe('resolveBrowsablePath', () => {
  it('rejects an empty or non-string request', async () => {
    expect(await resolveBrowsablePath(undefined)).toMatchObject({ ok: false, error: 'invalid_path' })
    expect(await resolveBrowsablePath('   ')).toMatchObject({ ok: false, error: 'invalid_path' })
    expect(await resolveBrowsablePath(42)).toMatchObject({ ok: false, error: 'invalid_path' })
  })

  it('rejects a relative path instead of resolving it against the process cwd', async () => {
    expect(await resolveBrowsablePath('project')).toMatchObject({ ok: false, error: 'not_absolute' })
  })

  it('rejects a path that does not exist, and a file', async () => {
    expect(await resolveBrowsablePath(join(scratch, 'missing'))).toMatchObject({ ok: false, error: 'not_found' })
    const file = join(scratch, 'notes.txt')
    await writeFile(file, 'x')
    expect(await resolveBrowsablePath(file)).toMatchObject({ ok: false, error: 'not_a_directory' })
  })

  it('accepts an ordinary directory and returns its canonical path', async () => {
    const target = await dir('projects', 'alpha')
    expect(await resolveBrowsablePath(target)).toEqual({ ok: true, path: target })
  })

  it('refuses a sensitive segment anywhere in the path', async () => {
    const ssh = await dir('.ssh')
    expect(await resolveBrowsablePath(ssh)).toMatchObject({ ok: false, error: 'blocked' })
    const nested = await dir('.ssh', 'keys')
    expect(await resolveBrowsablePath(nested)).toMatchObject({ ok: false, error: 'blocked' })
  })

  it('refuses a symlink that escapes into a sensitive directory', async () => {
    const ssh = await dir('.ssh')
    const link = join(scratch, 'looks-innocent')
    await symlink(ssh, link)
    // The link itself has a harmless name; only the REAL target is sensitive.
    expect(await resolveBrowsablePath(link)).toMatchObject({ ok: false, error: 'blocked' })
  })

  it('accepts a symlink that stays inside the fence', async () => {
    const target = await dir('real-project')
    const link = join(scratch, 'linked-project')
    await symlink(target, link)
    expect(await resolveBrowsablePath(link)).toEqual({ ok: true, path: target })
  })
})

describe('crumbsOf', () => {
  it('walks from the root to the current directory', async () => {
    const target = await dir('one', 'two')
    const crumbs = crumbsOf(target)
    expect(crumbs.at(-1)?.path).toBe(target)
    expect(crumbs[0]?.path).toBe('/')
    expect(crumbs[0]?.name).toBe('/')
    // Every ancestor is a jump target, and the chain is ordered root → current.
    const paths = crumbs.map(crumb => crumb.path)
    expect(paths).toContain(scratch)
    expect(paths).toContain(join(scratch, 'one'))
    expect(paths.indexOf(scratch)).toBeLessThan(paths.indexOf(join(scratch, 'one')))
    expect(paths.indexOf(join(scratch, 'one'))).toBeLessThan(paths.indexOf(target))
  })
})

describe('listDirectories', () => {
  it('lists directories only, name-sorted, and marks hidden rows', async () => {
    await dir('beta')
    await dir('Alpha')
    await dir('.config')
    await writeFile(join(scratch, 'a-file.txt'), 'x')
    const listing = await listDirectories(scratch)
    expect(listing.ok).toBe(true)
    if (!listing.ok) return
    expect(listing.entries.map(entry => entry.name)).toEqual(['.config', 'Alpha', 'beta'])
    expect(listing.entries.find(entry => entry.name === '.config')?.hidden).toBe(true)
    expect(listing.entries.find(entry => entry.name === 'Alpha')?.hidden).toBe(false)
  })

  it('never lists a sensitive directory', async () => {
    await dir('.ssh')
    await dir('.aws')
    await dir('normal')
    const listing = await listDirectories(scratch)
    expect(listing.ok).toBe(true)
    if (!listing.ok) return
    expect(listing.entries.map(entry => entry.name)).toEqual(['normal'])
  })

  it('follows a safe symlinked directory and skips an escaping one', async () => {
    await dir('real')
    await symlink(join(scratch, 'real'), join(scratch, 'safe-link'))
    const ssh = await dir('.ssh')
    await symlink(ssh, join(scratch, 'unsafe-link'))
    const listing = await listDirectories(scratch)
    expect(listing.ok).toBe(true)
    if (!listing.ok) return
    expect(listing.entries.map(entry => entry.name)).toEqual(['real', 'safe-link'])
  })

  it('lists the home directory when no path is given, and offers it as a shortcut', async () => {
    const listing = await listDirectories(undefined)
    expect(listing.ok).toBe(true)
    if (!listing.ok) return
    expect(listing.path).toBe(homedir())
    expect(listing.quick[0]?.path).toBe(homedir())
    expect(listing.crumbs.at(-1)?.path).toBe(homedir())
  })

  it('propagates a refusal instead of returning an empty listing', async () => {
    expect(await listDirectories('/etc')).toMatchObject({ ok: false, error: 'blocked' })
  })

  it('caps one level at MAX_ENTRIES and reports the truncation', async () => {
    const many = await dir('many')
    await Promise.all(
      Array.from({ length: MAX_ENTRIES + 5 }, (_, index) => mkdir(join(many, `d${String(index).padStart(4, '0')}`))),
    )
    const listing = await listDirectories(many)
    expect(listing.ok).toBe(true)
    if (!listing.ok) return
    expect(listing.entries).toHaveLength(MAX_ENTRIES)
    expect(listing.truncated).toBe(true)
  }, 30_000)
})

describe('createDirectory', () => {
  let scratch = ''

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'dsh-lg-create-'))
  })
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  it('creates one child folder and returns its absolute path', async () => {
    const created = await createDirectory(scratch, 'my-project')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.path).toBe(join(scratch, 'my-project'))
    // Really on disk, and really a directory.
    expect((await stat(created.path)).isDirectory()).toBe(true)
  })

  it('sends the name verbatim rather than trimmed', async () => {
    // The official browser makes the same choice: trimming would create a
    // different sibling than the one typed.
    const created = await createDirectory(scratch, ' spaced ')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.path).toBe(join(scratch, ' spaced '))
  })

  it('refuses a blank, dotted or multi-segment name', async () => {
    for (const name of ['', '   ', '.', '..', 'a/b', 'a\\b']) {
      const created = await createDirectory(scratch, name)
      expect(created.ok, JSON.stringify(name)).toBe(false)
      if (created.ok) continue
      expect(['invalid_path', 'blocked'], JSON.stringify(name)).toContain(created.error)
    }
  })

  it('refuses a sensitive name, so the fence covers the child too', async () => {
    // `.ssh` is no more acceptable as a NEW folder than as a browsed one:
    // creating it would put a credential directory inside a workspace.
    const created = await createDirectory(scratch, '.ssh')
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.error).toBe('blocked')
    await expect(stat(join(scratch, '.ssh'))).rejects.toThrow()
  })

  it('refuses a parent the fence rejects, and creates nothing', async () => {
    const created = await createDirectory(join(scratch, 'does-not-exist'), 'child')
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.error).toBe('not_found')
  })

  it('reports an existing folder as a distinct code, never as a failure', async () => {
    await mkdir(join(scratch, 'taken'))
    const created = await createDirectory(scratch, 'taken')
    expect(created.ok).toBe(false)
    if (created.ok) return
    // A distinct code is what lets the page say "pick another name" instead of
    // an opaque refusal.
    expect(created.error).toBe('exists')
  })

  it('is not recursive: a missing parent is a refusal, not a silent tree', async () => {
    const created = await createDirectory(scratch, 'a')
    expect(created.ok).toBe(true)
    const nested = await createDirectory(join(scratch, 'a', 'b'), 'c')
    expect(nested.ok).toBe(false)
    if (nested.ok) return
    expect(nested.error).toBe('not_found')
  })
})
