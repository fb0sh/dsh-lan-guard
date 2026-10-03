/**
 * Copy and language-resolution specs.
 *
 * The plugin's language is not its own preference: it follows the one the
 * official settings page writes, which DSH stores in its `locale` settings
 * namespace. The client half consumes it through the `locale` service; the host
 * half reads the namespace directly for the gate's own pages. These specs pin
 * both the dictionaries and that resolution order.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  en,
  LOCALE_NS,
  standaloneTranslate,
  zh,
  type MessageKey,
} from '../src/client/i18n.ts'
import {
  gateEn,
  gateTranslate,
  gateZh,
  localeFromAcceptLanguage,
  localeFromSettings,
  LOCALE_NAMESPACE,
  LOCALE_PREFERENCE_FIELD,
  resolveGateLocale,
} from '../src/auth/gate-i18n.ts'

describe('client dictionaries', () => {
  it('carry the same key set, so no message can fall through', () => {
    // The type already enforces this at compile time; the check stays because a
    // cast or an `as any` upstream would otherwise ship a silent English gap.
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('have no empty or placeholder-looking value', () => {
    for (const [key, value] of Object.entries(zh)) {
      expect(value.trim(), `zh.${key}`).not.toBe('')
      expect(value, `zh.${key}`).not.toMatch(/^[a-z]+(\.[a-z]+)+$/)
    }
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim(), `en.${key}`).not.toBe('')
      expect(value, `en.${key}`).not.toMatch(/^[a-z]+(\.[a-z]+)+$/)
    }
  })

  it('use the same placeholder set in both languages', () => {
    // A placeholder present in one language and missing in the other renders a
    // literal "{count}" to half the users.
    const placeholders = (value: string): string[] =>
      [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1] ?? '').sort()
    for (const key of Object.keys(zh) as MessageKey[]) {
      expect(placeholders(en[key]), key).toEqual(placeholders(zh[key]))
    }
  })

  it('never fall back to the raw key for a locale the stand-in serves', () => {
    const t = standaloneTranslate()
    for (const key of Object.keys(zh) as MessageKey[]) {
      expect(t(key), key).toBe(zh[key])
    }
    // An unknown key still renders something rather than throwing.
    expect(t('not.a.key' as MessageKey)).toBe('not.a.key')
  })

  it('names the namespace after the plugin, never a shared one', () => {
    expect(LOCALE_NS).toBe('dsh-lan-guard')
    expect(LOCALE_NS).not.toBe('common')
  })
})

describe('gate dictionaries', () => {
  it('carry the same key set', () => {
    expect(Object.keys(gateZh).sort()).toEqual(Object.keys(gateEn).sort())
  })

  it('translate through the language-specific dictionary', () => {
    expect(gateTranslate('zh')('pair.title')).toBe('确认这台设备')
    expect(gateTranslate('en')('pair.title')).toBe('Confirm this device')
  })

  it('interpolate the parameters they declare', () => {
    expect(gateTranslate('zh')('pair.source', { ip: '10.0.0.2' })).toBe('来源地址：10.0.0.2')
    expect(gateTranslate('en')('pair.source', { ip: '10.0.0.2' })).toBe('Source address: 10.0.0.2')
  })
})

describe('gate language resolution', () => {
  it('reads the preference DSH\'s settings page wrote', () => {
    expect(localeFromSettings({
      describe: () => [{ ns: LOCALE_NAMESPACE, value: { [LOCALE_PREFERENCE_FIELD]: 'en' } }],
    })).toBe('en')
    expect(localeFromSettings({
      describe: () => [{ ns: LOCALE_NAMESPACE, value: { [LOCALE_PREFERENCE_FIELD]: 'zh' } }],
    })).toBe('zh')
  })

  it('reports "no preference" rather than guessing', () => {
    // Unset, absent namespace, wrong shape, and an unreadable service all mean
    // the same thing to the caller: fall through to the browser's own request.
    expect(localeFromSettings(undefined)).toBeUndefined()
    expect(localeFromSettings({ describe: () => [] })).toBeUndefined()
    expect(localeFromSettings({ describe: () => [{ ns: 'locale', value: {} }] })).toBeUndefined()
    expect(localeFromSettings({ describe: () => [{ ns: 'locale', value: null }] })).toBeUndefined()
    expect(localeFromSettings({
      describe: () => [{ ns: 'locale', value: { preference: 'fr' } }],
    })).toBeUndefined()
    expect(localeFromSettings({
      describe: () => {
        throw new Error('settings unavailable')
      },
    })).toBeUndefined()
  })

  it('recognises every Chinese and English tag the browser may send', () => {
    expect(localeFromAcceptLanguage('zh')).toBe('zh')
    expect(localeFromAcceptLanguage('zh-CN')).toBe('zh')
    expect(localeFromAcceptLanguage('zh-Hans-CN,zh;q=0.9')).toBe('zh')
    expect(localeFromAcceptLanguage('zh-TW,zh;q=0.8')).toBe('zh')
    expect(localeFromAcceptLanguage('en-US,en;q=0.9')).toBe('en')
    expect(localeFromAcceptLanguage('en')).toBe('en')
    // Neither language named: DSH's own rule is English.
    expect(localeFromAcceptLanguage('fr-FR,fr;q=0.9')).toBe('en')
    // The first supported entry in q-order wins.
    expect(localeFromAcceptLanguage('fr,zh;q=0.9,en;q=0.8')).toBe('zh')
    expect(localeFromAcceptLanguage('fr,en;q=0.8,zh;q=0.9')).toBe('en')
  })

  it('keeps the plugin default only when the request names no language at all', () => {
    // Every real browser sends the header, so this is the programmatic case —
    // and returning Chinese here is what the plugin's pages have always done.
    expect(localeFromAcceptLanguage(undefined)).toBe('zh')
    expect(localeFromAcceptLanguage('')).toBe('zh')
    expect(localeFromAcceptLanguage('   ')).toBe('zh')
  })

  it('lets the stored preference beat what the browser asks for', () => {
    expect(resolveGateLocale({
      settings: { describe: () => [{ ns: LOCALE_NAMESPACE, value: { preference: 'en' } }] },
      acceptLanguage: 'zh-CN,zh;q=0.9',
    })).toBe('en')
    expect(resolveGateLocale({
      settings: { describe: () => [] },
      acceptLanguage: 'en-US,en;q=0.9',
    })).toBe('en')
  })
})

describe('every user-facing module goes through the dictionary', () => {
  /**
   * Modules whose text a user reads. `browse.ts` is deliberately absent: its
   * Chinese `message` fields are diagnostics the page never renders (it maps the
   * stable `error` code instead), and `qrcode.ts` answers with codes.
   */
  const LOCALIZED = [
    '../src/client.ts',
    '../src/client/workspace-flow.ts',
    '../src/client/picker-logic.ts',
    '../src/auth/login-page.ts',
  ] as const

  /** Strip comments, then collect every literal that still contains Han script. */
  function hanLiterals(source: string): string[] {
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/^\s*\*.*$/gm, '')
    const found: string[] = []
    for (const pattern of [/'([^'\n]*[\u4e00-\u9fff][^'\n]*)'/g, /`([^`\n]*[\u4e00-\u9fff][^`\n]*)`/g]) {
      for (const match of code.matchAll(pattern)) found.push(match[1] ?? '')
    }
    return found
  }

  it('leaves no hard-coded Chinese in a localizable module', () => {
    // A string added here instead of the dictionary is invisible until someone
    // switches the language, which is exactly how the first pass shipped a
    // half-Chinese English page.
    for (const file of LOCALIZED) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(hanLiterals(source), file).toEqual([])
    }
  })

  it('keeps the dictionary the only place Han script is written', () => {
    const dictionary = readFileSync(new URL('../src/client/i18n.ts', import.meta.url), 'utf8')
    expect(hanLiterals(dictionary).length).toBeGreaterThan(100)
  })
})

describe('degradation without the locale service', () => {
  const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')

  it('looks the service up optionally instead of requiring it', () => {
    // Declaring it in Cordis `inject` would unmount the whole section on a
    // composition that ships no locale plugin; the plugin must degrade to its
    // built-in Chinese rather than disappear.
    expect(source).toContain("optionalService(ctx, 'locale')")
    expect(source).not.toMatch(/inject:\s*\[[^\]]*'locale'/)
  })

  it('declares the slot namespace only when the service exists', () => {
    // An entry that declares `locale:` without the locale plugin is an assembly
    // failure, not a fallback.
    expect(source).toContain('...locale === undefined ? {} : { locale: LOCALE_NS }')
  })

  it('falls back to the Chinese dictionary for the component body', () => {
    expect(source).toContain('props.t ?? standaloneTranslate()')
  })

  it('keeps the nav label a thunk so it follows a switch without re-registering', () => {
    expect(source).toContain("label: () => bound('nav')")
  })
})
