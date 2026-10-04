/**
 * Gate-page design guard.
 *
 * The visitor login and device-pairing pages are served on the PROXY origin,
 * where DSH's stylesheet is not loaded: unlike the settings section, they cannot
 * reference `--dsw-*` variables and inherit them — a `var()` there resolves to
 * nothing. The page used to paper over that with fallback literals under a
 * token vocabulary that does not exist in DSH at all
 * (`--dsw-alias-text-primary`, `--dsw-alias-bg-elevated`, `--dsw-alias-bg-danger`,
 * …), so every colour came from the literal and the page had a palette of its
 * own.
 *
 * It now inlines the official palette and styles the markup as the official
 * dialog surface. This test pins the property that made the old version wrong:
 * every token the page reads must be one the page itself defines, and the
 * legacy invented names must not come back.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/auth/login-page.ts', import.meta.url), 'utf8')
const css = /const LOGIN_CSS = `\n([\s\S]*?)\n`\.trim\(\)/.exec(source)?.[1] ?? ''

/** Every distinct `--dsw-*` variable the stylesheet reads. */
function readTokens(text: string): string[] {
  return [...new Set([...text.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map(match => match[1] ?? ''))]
}

/** Every `--dsw-*` variable the stylesheet defines. */
function definedTokens(text: string): Set<string> {
  return new Set([...text.matchAll(/(--dsw-[a-z0-9-]+)\s*:/g)].map(match => match[1] ?? ''))
}

describe('gate page design', () => {
  it('extracts the stylesheet it is guarding', () => {
    expect(css.length).toBeGreaterThan(1000)
  })

  it('defines every token it reads, so no colour is missing at runtime', () => {
    const defined = definedTokens(css)
    const missing = readTokens(css).filter(token => !defined.has(token))
    expect(missing).toEqual([])
  })

  it('never references the legacy invented token vocabulary', () => {
    // None of these names exist in dsh-client-ui-theme 0.2.0-rc.2; they worked
    // only because every use carried a literal fallback.
    for (const legacy of [
      '--dsw-alias-text-', '--dsw-alias-bg-elevated', '--dsw-alias-bg-secondary',
      '--dsw-alias-border-subtle', '--dsw-alias-bg-danger', '--dsw-alias-border-danger',
      '--dsw-alias-bg-warning', '--dsw-alias-border-warning',
    ]) {
      expect(css, `${legacy} is not an official token`).not.toContain(legacy)
    }
  })

  it('carries both palettes, so a dark-mode phone gets the dark surfaces', () => {
    expect(css).toContain('@media (prefers-color-scheme:dark)')
    const light = css.slice(0, css.indexOf('@media (prefers-color-scheme:dark)'))
    const dark = css.slice(css.indexOf('@media (prefers-color-scheme:dark)'))
    // The values are DSH 0.2.0-rc.2's own resolved aliases: light page white,
    // dark page near-black.
    expect(light).toContain('--dsw-alias-bg-base:#fff')
    expect(dark).toContain('--dsw-alias-bg-base:#151517')
    expect(dark).toContain('--dsw-alias-label-primary:#f9fafb')
  })

  it('keeps the 44px coarse-pointer target floor', () => {
    const coarse = css.slice(css.indexOf('@media (hover:none) and (pointer:coarse)'))
    expect(coarse).toContain('height:44px')
  })

  it('keeps a notice’s TEXT on the high-contrast label token', () => {
    const start = css.indexOf('.notice{')
    expect(start).toBeGreaterThanOrEqual(0)
    const rule = css.slice(start, css.indexOf('}', start))
    // The semantic colour is the ACCENT (border-left); the text keeps the label
    // token, because semantic-on-tint measures 3.60:1 in the light palette.
    expect(rule).toContain('border-left:2px solid var(--dsw-alias-label-tertiary)')
    expect(rule).not.toContain('color:var(--dsw-alias-state-')
  })
})

