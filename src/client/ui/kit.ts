/**
 * dsh-lan-guard — the official-component kit.
 *
 * The plugin draws its settings section with the SAME controls the official
 * settings pages use, taken straight out of the frozen browser module table:
 * `@deepseek-ai/dsh-client-ui-primitives` is a PLATFORM MODULE (see
 * `packages/client/web/src/platform.ts` upstream), so a client bundle may
 * `require` it without duplicating React or any other singleton, and the
 * primitive's own stylesheet is injected by the shell that seeds it.
 *
 * Every control is resolved through {@link host}, which keeps the "the host may
 * not export this yet" case visible to the type checker instead of hiding it
 * behind an `any`. That is what makes the fallback real: this package supports
 * DSH releases from 0.1.7 onward, and a control added by 0.2.0 (SegmentedTabs,
 * the Switch capsule, the toast surface) simply is not there on the older
 * build. Each export below therefore pairs the official component with a
 * self-drawn stand-in that renders the same structure in the official tokens,
 * so an old host loses the pixel-perfect primitive, never the functionality.
 *
 * Nothing here reaches for a token that does not exist: only `--dsw-alias-*`,
 * `--dsw-radius-*`, `--dsw-shadow-*` and `--ds-font-family-code` names that the
 * installed `dsh-client-ui-theme` stylesheet actually defines.
 */
import { createElement, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import {
  Button as PrimitiveButton,
  IconCheckCircleFillRegular,
  IconCheckOutlineRegular,
  IconCloseOutlineRegular,
  IconClockOutlineRegular,
  IconCopyOutlineRegular,
  IconFolderOpenRegular,
  IconGlobeOutlineRegular,
  IconInfoOutlineRegular,
  IconPlusOutlineRegular,
  IconQuestionOutlineRegular,
  IconRefreshOutlineRegular,
  IconRightUpOutlineRegular,
  IconShieldOutlineRegular,
  IconTrashOutlineRegular,
  IconWarningOutlineRegular,
  IconWarningTriangleOutlineRegular,
  Input as PrimitiveInput,
  SegmentedTabs as PrimitiveSegmentedTabs,
  Switch as PrimitiveSwitch,
  Tag as PrimitiveTag,
  Toast as PrimitiveToast,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** A host export that an older DSH release may not have. */
type Optional<T> = T | undefined

/**
 * Keep a host export's "may be absent" case in the type system.
 *
 * A bare `PrimitiveX ?? Fallback` would be rejected by the compiler as a
 * needless check, because the installed type declarations always describe the
 * newest release. Routing the value through here makes the absence explicit
 * exactly once, at the boundary where it is a real possibility.
 *
 * @param value - the host's export, present or missing.
 * @returns the same value, typed as possibly missing.
 */
const host = <T,>(value: T): Optional<T> => value

/** The class names a self-drawn control uses; styled in `./styles.ts`. */
const fb = (...names: (string | false | undefined)[]): string =>
  names.filter((name): name is string => typeof name === 'string' && name !== '').join(' ')

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

/** The props every official icon accepts. */
export interface IconProps {
  /** Rendered square size in px; the official set defaults to 16. */
  size?: number
  /** Extra class, usually a colour carrier. */
  className?: string
}

/**
 * The text stand-in for an icon the host does not ship.
 *
 * `aria-hidden` because every call site pairs the glyph with a visible label:
 * a screen reader that announced "⚠" as well would read the sentence twice.
 */
function glyph(character: string): (props: IconProps) => ReactNode {
  return (props: IconProps) => createElement(
    'span',
    { className: fb('lg-glyph', props.className), 'aria-hidden': true },
    character,
  )
}

/** The glyph each icon falls back to, and the icon-name vocabulary itself. */
const ICON_GLYPHS = {
  check: '✓',
  checkCircle: '✓',
  close: '✕',
  copy: '⧉',
  folder: '📁',
  globe: '🌐',
  info: 'ℹ',
  plus: '+',
  question: '?',
  refresh: '↻',
  rightUp: '↗',
  shield: '🛡',
  trash: '🗑',
  warning: '⚠',
  warningTriangle: '⚠',
  clock: '🕘',
} as const satisfies Record<string, string>

/** One icon name. */
export type IconName = keyof typeof ICON_GLYPHS

/**
 * The icon set this plugin uses, each entry official when the host has it.
 *
 * Resolved one by one rather than as a set: a release may add some glyphs and
 * not others, and one missing icon must never take the whole page down. The
 * uniform `(props: IconProps) => ReactNode` signature is what lets a call site
 * render an icon without knowing which branch it got.
 */
export const Icons: Record<IconName, (props: IconProps) => ReactNode> = {
  check: host(IconCheckOutlineRegular) ?? glyph(ICON_GLYPHS.check),
  checkCircle: host(IconCheckCircleFillRegular) ?? glyph(ICON_GLYPHS.checkCircle),
  close: host(IconCloseOutlineRegular) ?? glyph(ICON_GLYPHS.close),
  copy: host(IconCopyOutlineRegular) ?? glyph(ICON_GLYPHS.copy),
  folder: host(IconFolderOpenRegular) ?? glyph(ICON_GLYPHS.folder),
  globe: host(IconGlobeOutlineRegular) ?? glyph(ICON_GLYPHS.globe),
  info: host(IconInfoOutlineRegular) ?? glyph(ICON_GLYPHS.info),
  plus: host(IconPlusOutlineRegular) ?? glyph(ICON_GLYPHS.plus),
  question: host(IconQuestionOutlineRegular) ?? glyph(ICON_GLYPHS.question),
  refresh: host(IconRefreshOutlineRegular) ?? glyph(ICON_GLYPHS.refresh),
  rightUp: host(IconRightUpOutlineRegular) ?? glyph(ICON_GLYPHS.rightUp),
  shield: host(IconShieldOutlineRegular) ?? glyph(ICON_GLYPHS.shield),
  trash: host(IconTrashOutlineRegular) ?? glyph(ICON_GLYPHS.trash),
  warning: host(IconWarningOutlineRegular) ?? glyph(ICON_GLYPHS.warning),
  warningTriangle: host(IconWarningTriangleOutlineRegular) ?? glyph(ICON_GLYPHS.warningTriangle),
  clock: host(IconClockOutlineRegular) ?? glyph(ICON_GLYPHS.clock),
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

/** The official visual families, plus the sizes the plugin uses. */
export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'
export type ButtonSize = 'md' | 'sm'

/** Props of {@link Button}: the official surface plus a `sm` size. */
export type ButtonProps = {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
  className?: string | undefined
  children?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>

/** The stand-in used when the host ships no Button primitive. */
function FallbackButton({
  variant = 'ghost', size = 'md', icon, className, children, ...rest
}: ButtonProps): ReactNode {
  return createElement('button', {
    ...rest,
    type: 'button',
    className: fb('lg-fb-btn', `lg-fb-${variant}`, size === 'sm' && 'lg-fb-sm', className),
  }, [
    icon === undefined || icon === null
      ? null
      : createElement('span', { className: 'lg-fb-icon', key: 'i' }, icon),
    children,
  ])
}

/** The official Button, or this plugin's token-styled stand-in. */
export const Button: (props: ButtonProps) => ReactNode = host(PrimitiveButton) ?? FallbackButton

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------

/** Props of {@link Switch}. */
export interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  /** Accessible name; the visible row title is the usual value. */
  label: string
  disabled?: boolean
  title?: string | undefined
  className?: string | undefined
}

/** The stand-in used when the host ships no Switch primitive. */
function FallbackSwitch({ checked, onChange, label, disabled = false, title, className }: SwitchProps): ReactNode {
  return createElement('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': checked,
    'aria-label': label,
    title,
    disabled,
    className: fb('lg-fb-switch', className),
    onClick: () => {
      onChange(!checked)
    },
  }, createElement('span', { className: 'lg-fb-thumb' }))
}

/** The official Switch, or this plugin's token-styled stand-in. */
export const Switch: (props: SwitchProps) => ReactNode = host(PrimitiveSwitch) ?? FallbackSwitch

// ---------------------------------------------------------------------------
// Tag
// ---------------------------------------------------------------------------

/** The official tone vocabulary. */
export type TagTone = 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'

/** Props of {@link Tag}. */
export interface TagProps {
  tone?: TagTone
  className?: string | undefined
  children?: ReactNode
}

/** The stand-in used when the host ships no Tag primitive. */
function FallbackTag({ tone = 'outline', className, children }: TagProps): ReactNode {
  return createElement('span', { className: fb('lg-fb-tag', className), 'data-tone': tone }, children)
}

/** The official Tag, or this plugin's token-styled stand-in. */
export const Tag: (props: TagProps) => ReactNode = host(PrimitiveTag) ?? FallbackTag

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Props of {@link Input}: the official field surface. */
export type InputProps = {
  icon?: ReactNode
  className?: string | undefined
} & InputHTMLAttributes<HTMLInputElement>

/** The stand-in used when the host ships no Input primitive. */
function FallbackInput({ icon, className, ...rest }: InputProps): ReactNode {
  return createElement('span', { className: fb('lg-fb-input', className) }, [
    icon === undefined || icon === null
      ? null
      : createElement('span', { className: 'lg-fb-input-icon', key: 'i' }, icon),
    createElement('input', { ...rest, key: 'f', className: 'lg-fb-input-field' }),
  ])
}

/** The official Input, or this plugin's token-styled stand-in. */
export const Input: (props: InputProps) => ReactNode = host(PrimitiveInput) ?? FallbackInput

// ---------------------------------------------------------------------------
// SegmentedTabs
// ---------------------------------------------------------------------------

/** One tab of {@link SegmentedTabs}. */
export interface SegmentedTab<Value extends string = string> {
  value: Value
  label: ReactNode
  /** DOM id of the tab button. */
  id: string
  /** DOM id of the panel it controls. */
  panelId: string
}

/** Props of {@link SegmentedTabs}. */
export interface SegmentedTabsProps<Value extends string> {
  items: readonly [SegmentedTab<Value>, ...SegmentedTab<Value>[]]
  value: Value
  onChange: (value: Value) => void
  /** Accessible name of the tablist. */
  label: string
  className?: string | undefined
}

/**
 * The stand-in used when the host ships no SegmentedTabs primitive.
 *
 * It keeps the official semantics (tablist/roving tab stop/arrow keys) and the
 * official surface (`--dsw-alias-bg-module-platform` track, raised layer-3
 * indicator), so an old host loses the sliding animation, not the pattern.
 */
function FallbackSegmentedTabs<Value extends string>({
  items, value, onChange, label, className,
}: SegmentedTabsProps<Value>): ReactNode {
  const onKeyDown = (event: { key: string; preventDefault(): void }, index: number): void => {
    const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    const target = step === 0
      ? event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1
      : (index + step + items.length) % items.length
    if (target < 0) return
    event.preventDefault()
    const next = items[target]
    if (next !== undefined) onChange(next.value)
  }
  return createElement(
    'div',
    { role: 'tablist', 'aria-label': label, className: fb('lg-fb-tabs', className) },
    items.map((item, index) => createElement('button', {
      key: item.value,
      id: item.id,
      type: 'button',
      role: 'tab',
      'aria-selected': value === item.value,
      'aria-controls': item.panelId,
      tabIndex: value === item.value ? 0 : -1,
      className: 'lg-fb-tab',
      onClick: () => {
        onChange(item.value)
      },
      onKeyDown: (event: { key: string; preventDefault(): void }) => {
        onKeyDown(event, index)
      },
    }, item.label)),
  )
}

/** The official SegmentedTabs, or this plugin's token-styled stand-in. */
const officialTabs = host(PrimitiveSegmentedTabs)
export const SegmentedTabs: <Value extends string>(props: SegmentedTabsProps<Value>) => ReactNode =
  officialTabs ?? FallbackSegmentedTabs

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

/** Props of the official toast, the shape {@link OfficialToast} accepts. */
export interface ToastProps {
  text: string
  icon?: ReactNode
  tone?: 'success'
  anchor?: HTMLElement | null
  holdMs?: number
  actions?: readonly { label: string; prefix?: string; onClick: () => void }[]
  onDone: () => void
}

/**
 * The host's toast banner, when it has one.
 *
 * Deliberately NOT given a stand-in here: the settings section owns a fallback
 * banner that also carries the countdown bar and the dismiss control it has
 * always had, so the fallback lives with the state that drives it. `undefined`
 * means "draw your own".
 *
 * The official component documents one requirement the caller must honour: a
 * repeat of the same text only restarts the hold if the owner remounts it, so
 * the section keys this banner by a per-show sequence.
 */
export const OfficialToast: Optional<(props: ToastProps) => ReactNode> = host(PrimitiveToast)
