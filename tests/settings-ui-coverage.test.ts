/**
 * Settings-page coverage guard.
 *
 * The host whitelists a switch, the README promises it is editable in the page,
 * and the page... forgets a widget. That is exactly how `adminPolicy` stayed
 * uneditable for two releases while being the load-bearing switch for remote
 * workspace access: `POLICY_CHOICES` was defined in the client and never
 * rendered, so the only way to leave the default `local_only` was to hand-edit
 * the profile patch (reported 2026-09-26).
 *
 * This test reads the client source and asserts every switch the host accepts
 * at runtime has a write call in the page. It is deliberately a source-level
 * check: rendering the React tree needs a DOM and a React copy this package
 * does not ship, and the failure it guards against is "the control is absent",
 * not "the control is drawn wrong".
 *
 * The stylesheet half of this file guards the OTHER thing a later edit can
 * silently undo: the section is drawn in DSH's official design language, with
 * the official controls, and not with a bespoke material of its own (the
 * "Liquid Glass" skin this page used to carry).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PREFERENCE_KEYS } from '../src/store/preferences.ts'

/**
 * Switches the page must NOT expose.
 *
 * `enabled` is the plugin master switch: `config.ts` documents it as a
 * startup-only field the listener reads statically, so it is persisted through
 * the settings service but only takes effect on the next start.
 */
const STARTUP_ONLY: readonly string[] = ['enabled']

describe('settings page coverage', () => {
  const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')
  const kit = readFileSync(new URL('../src/client/ui/kit.ts', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('../src/client/ui/styles.ts', import.meta.url), 'utf8')

  it('writes every runtime switch the host accepts', () => {
    const missing = PREFERENCE_KEYS
      .filter(key => !STARTUP_ONLY.includes(key))
      .filter(key => !source.includes(`preferences: { ${key}:`))
    expect(missing).toEqual([])
  })

  it('exposes the authority switches that gate the remote workspace picker', () => {
    // These three decide whether a LAN device may browse directories at all;
    // a regression here makes the picker unusable with no visible cause.
    for (const key of ['adminPolicy', 'adminProtection', 'allowLoopback']) {
      expect(source).toContain(`preferences: { ${key}:`)
    }
  })

  it('drives the toast countdown bar from the same constant as the timer', () => {
    // Two independent durations would drift, and a bar that outlives its toast
    // (or vanishes early) is worse than no bar at all. The official Toast takes
    // the same constant as its hold, so the fallback and the primitive agree.
    expect(source).toMatch(/const TOAST_MS = \d+/)
    expect(source).toContain('}, TOAST_MS)')
    expect(source).toContain('animationDuration: `${String(TOAST_MS)}ms`')
    expect(source).toContain('holdMs: TOAST_MS')
  })

  it('clears the previous toast timer before arming a new one', () => {
    // Without this a second save inside the window is dismissed by the FIRST
    // timer, so the confirmation flashes for a few hundred milliseconds.
    const flash = source.slice(source.indexOf('const flash = useCallback'))
    expect(flash.slice(0, 500)).toContain('clearNoticeTimer()')
  })

  it('never paints a status surface with a hover tint', () => {
    // --dsw-alias-interactive-bg-hover-danger resolves to an 8-digit colour
    // whose alpha byte is 0x0d (5%): a wash over whatever is behind it, not a
    // background. A danger surface mixes the semantic colour into a surface.
    for (const [name, text] of [['client', source], ['styles', styles], ['kit', kit]] as const) {
      expect(text, `${name} must not use the hover-danger wash as a fill`)
        .not.toContain('background:var(--dsw-alias-interactive-bg-hover-danger')
    }
    expect(styles).toContain('color-mix(in srgb, var(--dsw-alias-state-error-primary')
  })

  it('keeps every status surface’s colours on defined tokens', () => {
    // Measured against DSH 0.2.0-rc.2 in both themes: a semantic colour on its
    // own 10% tint is 3.60:1 (light) and 4.39:1 (dark) — below AA for text,
    // while label-primary on the same surfaces is 16.04:1 and 9.79:1. The page
    // therefore owns no semantic-on-tint TEXT surface: notices are label-token
    // copy (`.lg-note`), the failure line is the official error treatment, and
    // the toast is the official dark surface with its own label token.
    const rules: readonly [string, string][] = [
      ['.lg-note{', 'color:var(--dsw-alias-label-secondary)'],
      ['.lg-note.danger{', 'color:var(--dsw-alias-state-error-primary)'],
      ['.lg-toast{', 'background:var(--dsw-alias-toast-bg)'],
      ['.lg-toast{', 'color:var(--dsw-alias-toast-label)'],
    ]
    for (const [rule, declaration] of rules) {
      const start = styles.indexOf(rule)
      expect(start, `${rule} is missing`).toBeGreaterThanOrEqual(0)
      expect(styles.slice(start, styles.indexOf('}', start)), rule).toContain(declaration)
    }
  })

  it('draws the section with the host’s official controls', () => {
    // The plugin used to hand-draw every control in a material of its own. The
    // page now resolves the platform primitives (which the shell seeds into the
    // frozen module table) and only falls back when a host predates them.
    expect(kit).toContain("from '@deepseek-ai/dsh-client-ui-primitives'")
    for (const name of ['Button', 'Switch', 'Tag', 'Input', 'SegmentedTabs', 'Toast']) {
      expect(kit, `${name} must resolve the official primitive`).toContain(name)
    }
    for (const name of ['Button', 'Switch', 'Tag', 'Input', 'SegmentedTabs']) {
      expect(source, `${name} must be used by the section`).toContain(name)
    }
  })

  it('invents no material: no bespoke blur, gradient or glass rim', () => {
    // The section renders INSIDE the official settings dialog and has to read
    // as one of its pages. A `backdrop-filter`, a radial gradient or a
    // specular rim on a card is the "Liquid Glass" skin coming back.
    const section = /export const SECTION_CSS = `\n([\s\S]*?)\n`\.trim\(\)/.exec(styles)?.[1] ?? ''
    expect(section.length).toBeGreaterThan(1000)
    for (const banned of ['backdrop-filter', 'radial-gradient', 'linear-gradient', 'mask-composite']) {
      expect(section, `SECTION_CSS must not use ${banned}`).not.toContain(banned)
    }
    expect(source).not.toContain('lg-card')
  })
})
