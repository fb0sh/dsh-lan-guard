/**
 * The official-component kit, in both of its branches.
 *
 * `./client/ui/kit.ts` resolves every control out of the frozen platform module
 * table and pairs it with a self-drawn stand-in, so a DSH release that ships no
 * `SegmentedTabs` (or no `Switch` capsule, or no toast) loses the pixel-perfect
 * primitive but never the control. TypeScript can only prove the resolution
 * COMPILES; the branch that actually runs on an older host is decided at
 * runtime, by whether the host's module table has the export at all.
 *
 * This file loads the kit twice against a stubbed platform module — empty (the
 * older host) and populated (0.2.0) — and asserts which branch came out and
 * what the stand-in renders. `createElement` needs no DOM, so the element trees
 * are inspected directly; nothing here mounts or renders.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

const PLATFORM_MODULE = '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Model the host's module table the way the BUILT bundle reads it.
 *
 * The compiled client does `require('@deepseek-ai/dsh-client-ui-primitives')
 * .IconShieldOutlineRegular`, i.e. PROPERTY ACCESS on the namespace the shell
 * seeded, and an absent property is `undefined` — that `undefined` is exactly
 * what `host(x) ?? fallback` keys off. A Vitest mock is stricter than that: it
 * emulates static `import { X }` binding and throws on a name the mock does not
 * define. The proxy below restores the real semantics (present → the value,
 * absent → `undefined`) so the fallback branch can be exercised at all.
 *
 * @param exports - what the host's module table answers with.
 * @returns a table with property-access semantics.
 */
function asModuleTable(exports: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(exports, {
    has: () => true,
    get: (target, key) => (typeof key === 'string' ? target[key] : undefined),
  })
}

/**
 * Load a fresh copy of the kit with the host's module table replaced.
 *
 * `resetModules` matters: the kit snapshots the table at module scope (that is
 * what makes `host(...) ?? fallback` a one-time decision), so each branch needs
 * its own module instance.
 *
 * @param exports - what the host's module table answers with.
 * @returns the kit module.
 */
async function loadKit(exports: Record<string, unknown>): Promise<typeof import('../src/client/ui/kit.ts')> {
  vi.resetModules()
  vi.doMock(PLATFORM_MODULE, () => asModuleTable(exports))
  return await import('../src/client/ui/kit.ts')
}

/** A stand-in official control: it is recognisable by the props it returns. */
function marker(name: string): (props: unknown) => ReactElement {
  return (props: unknown) => ({ type: `official:${name}`, props }) as unknown as ReactElement
}

describe('ui kit — official branch', () => {
  it('uses the host component whenever the module table exports one', async () => {
    const kit = await loadKit({
      Button: marker('Button'),
      Switch: marker('Switch'),
      Tag: marker('Tag'),
      Input: marker('Input'),
      SegmentedTabs: marker('SegmentedTabs'),
      Toast: marker('Toast'),
    })

    expect((kit.Button({ children: 'x' }) as unknown as { type: string }).type).toBe('official:Button')
    expect((kit.Switch({ checked: true, onChange: () => {}, label: 'x' }) as unknown as { type: string }).type)
      .toBe('official:Switch')
    expect((kit.Tag({ children: 'x' }) as unknown as { type: string }).type).toBe('official:Tag')
    expect((kit.Input({}) as unknown as { type: string }).type).toBe('official:Input')
    expect(kit.OfficialToast).toBeTypeOf('function')
  })

  it('prefers whichever exports exist and fills the gaps individually', async () => {
    // A release that adds SegmentedTabs but not Toast is exactly the case the
    // per-name resolution exists for: one missing control must not take the
    // page down, and the ones that are there must still be used.
    const kit = await loadKit({ SegmentedTabs: marker('SegmentedTabs') })
    expect(kit.OfficialToast).toBeUndefined()
    const tree = kit.SegmentedTabs({
      items: [{ value: 'a', label: 'A', id: 'a', panelId: 'pa' }],
      value: 'a',
      onChange: () => {},
      label: 'tabs',
    }) as unknown as { type: string }
    expect(tree.type).toBe('official:SegmentedTabs')
    // …and the ones it lacked fell back rather than becoming undefined.
    expect(kit.Button).toBeTypeOf('function')
    expect(kit.Switch).toBeTypeOf('function')
  })
})

describe('ui kit — fallback branch', () => {
  it('draws a Button in the official shape when the host has none', async () => {
    const kit = await loadKit({})
    const el = kit.Button({ variant: 'primary', size: 'sm', children: '保存' }) as ReactElement
    expect(el.type).toBe('button')
    const props = el.props as { className: string; type: string; children: unknown }
    // The stand-in classes are the ones `styles.ts` dresses in official tokens.
    expect(props.className).toContain('lg-fb-btn')
    expect(props.className).toContain('lg-fb-primary')
    expect(props.className).toContain('lg-fb-sm')
    expect(props.type).toBe('button')
  })

  it('draws a Switch that reports itself as one', async () => {
    const calls: boolean[] = []
    const kit = await loadKit({})
    const el = kit.Switch({ checked: false, onChange: next => calls.push(next), label: '手机滚动矫正' })
    const props = (el as ReactElement).props as {
      role: string
      'aria-checked': boolean
      'aria-label': string
      onClick: () => void
    }
    // The visual state keys off aria-checked, so assistive technology and the
    // capsule can never disagree.
    expect(props.role).toBe('switch')
    expect(props['aria-checked']).toBe(false)
    expect(props['aria-label']).toBe('手机滚动矫正')
    props.onClick()
    expect(calls).toEqual([true])
  })

  it('draws a Tag with its tone', async () => {
    const kit = await loadKit({})
    const el = kit.Tag({ tone: 'success', children: '运行中' }) as ReactElement
    expect(el.type).toBe('span')
    expect((el.props as { 'data-tone': string })['data-tone']).toBe('success')
  })

  it('draws a SegmentedTabs tablist with the official a11y wiring', async () => {
    const selected: string[] = []
    const kit = await loadKit({})
    const el = kit.SegmentedTabs({
      items: [
        { value: 'access', label: '扫码访问', id: 'lg-tab-access', panelId: 'lg-panel-access' },
        { value: 'security', label: '安全认证', id: 'lg-tab-security', panelId: 'lg-panel-security' },
      ],
      value: 'access',
      onChange: value => selected.push(value),
      label: '局域网访问设置分区',
    }) as ReactElement
    const props = el.props as { role: string; 'aria-label': string; children: ReactElement[] }
    expect(el.type).toBe('div')
    expect(props.role).toBe('tablist')
    expect(props['aria-label']).toBe('局域网访问设置分区')
    expect(props.children).toHaveLength(2)
    const [first, second] = props.children
    const firstProps = first?.props as { 'aria-selected': boolean; tabIndex: number; 'aria-controls': string }
    const secondProps = second?.props as { 'aria-selected': boolean; tabIndex: number }
    // Roving tab stop: exactly one tab is reachable by keyboard.
    expect(firstProps['aria-selected']).toBe(true)
    expect(firstProps.tabIndex).toBe(0)
    expect(firstProps['aria-controls']).toBe('lg-panel-access')
    expect(secondProps['aria-selected']).toBe(false)
    expect(secondProps.tabIndex).toBe(-1)
  })

  it('falls back to a searchable icon set and reports no toast', async () => {
    const kit = await loadKit({})
    expect(kit.OfficialToast).toBeUndefined()
    // Every icon the section uses must exist as a renderable function, so a
    // missing glyph degrades to a stand-in instead of throwing.
    for (const [name, Icon] of Object.entries(kit.Icons)) {
      expect(Icon, name).toBeTypeOf('function')
      expect((Icon as (p: { size: number }) => ReactElement)({ size: 14 })).toBeTruthy()
    }
  })
})
