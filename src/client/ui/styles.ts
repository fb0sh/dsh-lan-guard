/**
 * dsh-lan-guard — the plugin's own stylesheet, written in the OFFICIAL design
 * language of DSH 0.2.0-rc.2.
 *
 * Every rule below is a transcription of an official pattern rather than an
 * invention, because the section is rendered INSIDE the official settings
 * dialog and has to read as one of its pages:
 *
 * | This plugin                     | Official source                                              |
 * | ------------------------------- | ------------------------------------------------------------ |
 * | `.lg-panel > *` cell rhythm     | `ui-theme/AppearanceRow`, `FontSizeRow` (pad 16/0, hairline)  |
 * | `.lg-cell` setting row          | `ui-theme/FontSizeRow` (text column left, control right)      |
 * | `.lg-field` / `.lg-label`       | `ui-primitives/settings-form/fields.module.css`               |
 * | `.lg-input`                     | the same field control (34px, 0.5px l4, layer-3, 13px)        |
 * | `.lg-choice` selection cube     | `ui-theme/AppearanceRow` `.themeCube`                         |
 * | `.lg-toast` banner              | `ui-primitives/Toast.module.css` (dark surface, radius-lg)    |
 * | `.lgp-*` picker dialog          | `ui-primitives/Modal.module.css` (panel radius, layer-2)      |
 *
 * Controls the host's own primitives provide (Button, Switch, Tag, Input,
 * SegmentedTabs, Toast, icons) are NOT restyled here — they arrive from the
 * platform module table with their own stylesheet. The `lg-fb-*` block at the
 * bottom is the stand-in set for hosts that predate those exports; it is the
 * only place this plugin draws a control from scratch, and it uses the same
 * tokens so an old host stays visually consistent.
 *
 * Token discipline: only names the installed `dsh-client-ui-theme` stylesheet
 * actually defines are referenced. Cautionary notes in the previous revision of
 * this file record what happens otherwise — `--dsw-alias-bg-layer-4` and
 * `--dsw-alias-label-error` do not exist, and a rule that references a missing
 * token is dropped silently.
 */

/** The settings section inside the official settings dialog. */
export const SECTION_CSS = `
/* The section column. No card chrome: the official shell already gives the
   options column its own 24px padding, its own scrolling and its own width. */
.lg-root{display:flex;flex-direction:column;width:100%;color:var(--dsw-alias-label-primary)}

/* The tab strip is the official SegmentedTabs control; only its spacing here. */
.lg-tabbar{padding:0 0 8px}

/* The panel is one column of BLOCKS. A block carries the official cell rhythm
   (16px above and below); neighbours are separated by one hairline, so the page
   reads as a list of settings rather than as a stack of boxes. */
.lg-panel{display:flex;flex-direction:column;width:100%}
.lg-panel>*{padding:16px 0}
.lg-panel>*+*{border-top:0.5px solid var(--dsw-alias-border-l2)}

/* A block that is more than one thing: stack its parts, no extra hairline
   between them (a hint belongs to the control above it, not to the page). */
.lg-stack{display:flex;flex-direction:column;gap:8px}
/* A button that is a direct child of a stacked block is an ACTION, not the
   block's control: it keeps its intrinsic width and sits at the start, the way
   every official settings button does. Only a field's control spans the
   column. */
.lg-stack>button,.lg-field>button{align-self:flex-start}

/* One setting: text column left, control right. */
.lg-cell{display:flex;align-items:center;gap:8px}
.lg-cell-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.lg-cell-control{flex:0 0 auto;display:flex;align-items:center;gap:8px}
.lg-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}

/* Typography: the official settings scale, nothing else. */
.lg-title{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary)}
.lg-desc{font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.lg-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.lg-lead{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary)}

/* Notices are plain copy with a coloured leading glyph, which is how the
   official pages report state (WelcomeNotice). A semantic colour fills no
   surface of ours, so no status line can fall below AA: measured against DSH
   0.2.0-rc.2, semantic-on-its-own-10%-tint is 3.60:1 in the light palette while
   the label tokens this rule uses are 16.04:1 and 9.79:1. */
.lg-note{display:flex;align-items:flex-start;gap:6px;margin:0;
  font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.lg-note-icon{flex:none;display:inline-flex;margin-top:2px;color:var(--dsw-alias-label-tertiary)}
.lg-note.ok .lg-note-icon{color:var(--dsw-alias-state-success-primary)}
/* A warning is important copy, so its TEXT takes the primary label token and
   only the glyph carries the amber. Losing the old filled bar must not lose the
   signal: the sentence the operator has to act on is now the highest-contrast
   text on the page rather than coloured text on a tint (3.60:1 in light). */
.lg-note.warn{color:var(--dsw-alias-label-primary)}
.lg-note.warn .lg-note-icon{color:var(--dsw-alias-state-warn-primary)}
.lg-note.info .lg-note-icon{color:var(--dsw-alias-state-business-primary)}
/* The failure line takes the official error treatment verbatim: the semantic
   colour IS the text colour here (WelcomeNotice .error), on the plain panel
   surface rather than on a tint. */
.lg-note.danger{color:var(--dsw-alias-state-error-primary)}
.lg-note.danger .lg-note-icon{color:var(--dsw-alias-state-error-primary)}

/* Official field: label 13/500 above its control. One field per block, so the
   panel's own hairline already separates neighbours (fields.module.css). */
.lg-field{display:flex;flex-direction:column;gap:6px}
.lg-label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}

/* The official field control. */
.lg-input{box-sizing:border-box;height:34px;padding:0 12px;
  border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;
  color:var(--dsw-alias-label-primary)}
.lg-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.lg-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
select.lg-input{cursor:pointer}
.lg-input-grow{display:flex;width:100%}

/* Copyable values (the access URL, the upgrade command) are SINGLE-LINE fields:
   horizontal scrolling instead of hard wrapping, so a long URL cannot push the
   rest of the page down. Scrolling never truncates what you get — the copy
   button writes the source string, never the rendered text. */
.lg-mono{box-sizing:border-box;margin:0;padding:8px 12px;
  border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-module-platform);
  font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);
  font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.lg-mono-scroll{white-space:nowrap;overflow-x:auto;overflow-y:hidden;overflow-wrap:normal;
  cursor:text;scrollbar-width:thin}
.lg-mono-scroll::-webkit-scrollbar{height:6px}
.lg-mono-scroll::-webkit-scrollbar-track{background:transparent}
.lg-mono-scroll::-webkit-scrollbar-thumb{border-radius:999px;
  background:color-mix(in srgb, var(--dsw-alias-label-tertiary) 55%, transparent)}

/* The white QR plate HUGS the code. Deliberately OPAQUE: a QR code on a
   translucent plate loses contrast and may stop scanning. */
.lg-qr{width:fit-content;margin:0 auto;padding:12px;background:#fff;
  border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg)}
.lg-qr svg{display:block;width:190px;height:190px}

/* Official selection cube (AppearanceRow .themeCube): hairline l4 stroke,
   xl radius, transparent fill, hover wash, selected = platform fill with the
   neutral bluish-400 stroke. */
.lg-choices{display:flex;flex-wrap:wrap;gap:8px}
.lg-choice{box-sizing:border-box;flex:1 1 180px;display:flex;flex-direction:column;gap:4px;
  padding:16px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-xl);
  background:transparent;font:inherit;text-align:left;color:var(--dsw-alias-label-primary);
  cursor:pointer}
.lg-choice:hover:not([aria-pressed=true]){background:var(--dsw-alias-interactive-bg-hover)}
.lg-choice[aria-pressed=true]{background:var(--dsw-alias-bg-module-platform);
  border-color:var(--dsw-static-neutral-bluish-400)}
.lg-choice:disabled{opacity:.4;cursor:not-allowed}
.lg-choice-title{font-size:14px;font-weight:400;line-height:22px}
.lg-choice-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.lg-choice[aria-pressed=true] .lg-choice-desc{color:var(--dsw-alias-label-secondary)}

/* Official list rows: a hairline between neighbours, no boxed cards. */
.lg-list{display:flex;flex-direction:column}
.lg-item{display:flex;align-items:flex-start;gap:8px;padding:12px 0}
.lg-item+.lg-item{border-top:0.5px solid var(--dsw-alias-border-l2)}
.lg-item-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.lg-item-name{display:flex;align-items:center;gap:6px;min-width:0;
  font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.lg-item-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lg-item-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.lg-item-actions{flex:0 0 auto;display:flex;align-items:center;gap:8px}

/* The management console's lock card: a plain centred block, no card chrome. */
.lg-lock{display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px;padding:8px 0}
.lg-lock-icon{display:inline-flex;color:var(--dsw-alias-label-tertiary)}
.lg-lock-title{margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary)}
.lg-lock-body{margin:0;max-width:440px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.lg-lock-form{display:flex;flex-direction:column;gap:8px;width:min(320px,100%);margin-top:2px}
.lg-recover{width:100%;margin-top:4px;text-align:left;
  font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.lg-recover p{margin:0}
.lg-recover p+p{margin-top:4px}

/* Action rows and text links, both in official dress. */
.lg-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.lg-link{border:0;background:transparent;padding:0;cursor:pointer;font:inherit;
  font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);text-decoration:none}
.lg-link:hover{color:var(--dsw-alias-label-primary)}
.lg-update{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:0 0 12px}

/*
 * Transient confirmations.
 *
 * The official toast surface is a DARK banner pinned to the top centre of the
 * viewport, in both themes; when the host ships the Toast primitive this plugin
 * renders that component and none of this markup is used. The rules below are
 * the fallback, and they carry two things the primitive does not have: an
 * explicit dismiss control and a countdown bar whose duration is injected from
 * TOAST_MS, so the animation and the dismissal timer can never disagree.
 *
 * A fixed position costs no layout: a bar in the page flow would push every
 * control down for the length of the toast, so a save made at the bottom of a
 * long tab would look like the page had jumped.
 */
.lg-toasts{position:fixed;top:40px;left:50%;transform:translateX(-50%);z-index:2147483001;
  display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;
  max-width:min(640px,calc(100vw - 48px))}
.lg-toast{pointer-events:auto;box-sizing:border-box;position:relative;overflow:hidden;
  display:flex;align-items:center;gap:10px;width:max-content;
  max-width:min(640px,calc(100vw - 48px));padding:12px 16px;
  border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-shadow-lv3);
  background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);
  font-size:14px;line-height:22px;animation:lg-toast-in .16s ease-out}
@keyframes lg-toast-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.lg-toast{animation:none}}
.lg-toast-icon{flex:none;display:inline-flex;color:var(--dsw-alias-state-warn-label)}
.lg-toast.info{background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label)}
.lg-toast.info .lg-toast-icon{color:var(--dsw-alias-state-success-primary)}
.lg-toast.danger{background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label)}
.lg-toast.danger .lg-toast-icon{color:var(--dsw-alias-state-warn-label)}
.lg-toast-text{min-width:0}
.lg-toast-x{flex:none;border:0;background:transparent;color:inherit;opacity:.7;cursor:pointer;
  padding:2px 4px;border-radius:var(--dsw-radius-sm);font:inherit;line-height:1}
.lg-toast-x:hover{opacity:1}
.lg-toast-bar{position:absolute;left:0;bottom:0;height:2px;width:100%;background:currentColor;
  opacity:.4;animation-name:lg-toast-shrink;animation-timing-function:linear;
  animation-fill-mode:forwards}
@keyframes lg-toast-shrink{from{width:100%}to{width:0}}
@media (prefers-reduced-motion:reduce){.lg-toast-bar{display:none}}

/* Fallback glyphs stand in for an official icon the host does not ship. */
.lg-glyph{display:inline-flex;align-items:center;justify-content:center;font-size:14px;line-height:1}

/*
 * Controls for a host that predates the platform primitives.
 *
 * This is the ONLY place the plugin draws a control itself. Geometry and
 * palette are copied from the official primitive it stands in for, so the page
 * keeps the same visual language either way; these rules are inert on every DSH
 * release that exports Button/Switch/Tag/Input/SegmentedTabs.
 */
.lg-fb-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;
  height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);cursor:pointer;
  font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent}
.lg-fb-btn:disabled{cursor:not-allowed;opacity:.4}
.lg-fb-btn.lg-fb-sm{height:28px;padding:0 10px;font-size:12px;line-height:18px;border-radius:var(--dsw-radius-sm)}
.lg-fb-icon{display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center}
.lg-fb-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.lg-fb-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill))}
.lg-fb-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.lg-fb-outline{border:0.5px solid var(--dsw-alias-border-l3)}
.lg-fb-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.lg-fb-toolbar{background:var(--dsw-alias-button-tool-bar-fill,var(--dsw-alias-bg-layer-3))}
.lg-fb-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;
  border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer}
.lg-fb-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary))}
.lg-fb-switch:disabled{cursor:default;opacity:.5}
.lg-fb-thumb{display:block;width:16px;height:16px;border-radius:50%;
  background:var(--dsw-alias-switch-thumb,var(--dsw-alias-bg-layer-1));transition:transform 120ms ease}
.lg-fb-switch[aria-checked=true] .lg-fb-thumb{background:var(--dsw-alias-label-primary-foreground);
  transform:translateX(16px)}
.lg-fb-tag{display:inline-flex;align-items:center;border-radius:999px;padding:1px 8px;
  font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;
  border:0.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary)}
.lg-fb-tag[data-tone=success]{border-color:transparent;color:var(--dsw-alias-state-success-primary);
  background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)}
.lg-fb-tag[data-tone=warning]{border-color:transparent;color:var(--dsw-alias-state-warn-primary);
  background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent)}
.lg-fb-tag[data-tone=danger]{border-color:transparent;color:var(--dsw-alias-state-error-primary);
  background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)}
.lg-fb-tag[data-tone=info]{border-color:transparent;color:var(--dsw-alias-state-business-primary);
  background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent)}
.lg-fb-tag[data-tone=neutral]{border-color:transparent;color:var(--dsw-alias-label-secondary);
  background:var(--dsw-alias-bg-module-platform)}
.lg-fb-tag[data-tone=quiet]{border-color:transparent}
.lg-fb-tag[data-tone=solid]{border-color:transparent;background:var(--dsw-alias-label-primary);
  color:var(--dsw-alias-bg-layer-3)}
.lg-fb-input{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:32px;
  padding:0 8px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-1)}
.lg-fb-input:focus-within{border-color:var(--dsw-alias-state-business-primary)}
.lg-fb-input-icon{display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;
  color:var(--dsw-alias-label-tertiary)}
.lg-fb-input-field{flex:1;min-width:0;border:none;outline:none;background:transparent;font:inherit;
  font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.lg-fb-tabs{position:relative;display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;
  padding:4px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform)}
.lg-fb-tab{position:relative;justify-content:center;height:34px;padding:0 12px;border:0;
  border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;font:inherit;
  font-size:14px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.lg-fb-tab[aria-selected=true]{background:var(--dsw-alias-bg-layer-3);
  border:0.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);font-weight:600}

/* Coarse pointers get the same 44px floor the official surfaces use. */
@media (hover:none) and (pointer:coarse){
  .lg-fb-btn,.lg-input,.lg-fb-input,.lg-choice{min-height:44px}
}
`.trim()

/**
 * The remote workspace picker: an official dialog.
 *
 * Shown to a LAN browser whose host resolved DSH's own directory picker to the
 * OS dialog on the OTHER machine. Geometry, mask and surface are the official
 * Modal's (`ui-primitives/Modal.module.css`): 24px of air on every side, the
 * `--dsw-radius-panel` shell on `bg-layer-2`, the prominent elevation, and a
 * 28px close control in the header.
 */
export const FLOW_CSS = `
.lgp-root{pointer-events:auto;position:fixed;inset:0;z-index:2147483000;display:flex;
  align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px}
.lgp-mask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;
  background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur);
  -webkit-backdrop-filter:var(--dsw-mask-blur)}
.lgp-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;
  width:min(520px,100%);max-height:100%;overflow:hidden;
  border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);
  box-shadow:var(--dsw-elevation-prominent)}
.lgp-head{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:22px 14px 12px 24px}
.lgp-title{margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary)}
.lgp-x{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;
  border:none;border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;
  color:var(--dsw-alias-label-secondary)}
.lgp-x:hover{background:var(--dsw-alias-interactive-bg-hover)}
/* The dialog's only flexing child: everything above and below it is fixed, so
   the list absorbs all the shrinkage and the rows keep their height. */
.lgp-body{flex:1 1 auto;display:flex;flex-direction:column;gap:10px;min-height:0;padding:0 24px}
/*
 * FLEX SHRINK IS EXPLICIT ON EVERY FIXED ROW (user report 2026-09-26: the
 * breadcrumb and the quick-access rows were crushed into one overlapping strip).
 * A flex item's AUTOMATIC minimum size resolves to 0 as soon as its overflow is
 * not visible, and both rows scroll horizontally — so the moment the dialog hit
 * its max-height the browser shrank exactly those two rows to nothing while the
 * list kept its floor. Only the list may flex; everything else is fixed.
 */
.lgp-crumbs,.lgp-quick{flex:0 0 auto;display:flex;align-items:center;gap:8px;overflow-x:auto;
  overflow-y:hidden;padding-bottom:2px;scrollbar-width:none}
.lgp-crumbs::-webkit-scrollbar,.lgp-quick::-webkit-scrollbar,.lgp-list::-webkit-scrollbar{display:none}
.lgp-crumb{flex:0 0 auto;border:0;background:transparent;color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:13px;line-height:20px;cursor:pointer;padding:4px 6px;
  border-radius:var(--dsw-radius-sm);white-space:nowrap}
.lgp-crumb:hover{background:var(--dsw-alias-interactive-bg-hover)}
.lgp-crumb[aria-current=true]{color:var(--dsw-alias-label-primary);font-weight:500;
  background:var(--dsw-alias-bg-module-platform)}
.lgp-quickbtn{flex:0 0 auto;border:0.5px solid var(--dsw-alias-border-l4);
  border-radius:999px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;
  font-size:13px;line-height:20px;padding:4px 12px;cursor:pointer;white-space:nowrap}
.lgp-quickbtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
/* The list is the ONLY flexible row: it absorbs every bit of shrinkage, so the
   fixed rows above and the actions below stay whole on a short viewport. */
.lgp-list{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;
  border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-1);padding:4px}
.lgp-row{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;
  background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;
  line-height:22px;padding:8px 10px;border-radius:var(--dsw-radius-sm);cursor:pointer;min-height:36px}
.lgp-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.lgp-dir{flex:0 0 auto;display:inline-flex;color:var(--dsw-alias-label-tertiary)}
.lgp-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lgp-row[data-hidden=true] .lgp-name{color:var(--dsw-alias-label-tertiary)}
.lgp-hint{margin:0;padding:10px 4px;color:var(--dsw-alias-label-tertiary);
  font-size:13px;line-height:20px}
/* The refusal keeps the official error treatment: semantic colour as text. */
.lgp-notice{flex:0 0 auto;display:flex;flex-direction:column;gap:4px;padding:10px 12px;
  border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md)}
.lgp-notice h4{margin:0;font-size:13px;font-weight:500;line-height:20px;
  color:var(--dsw-alias-state-error-primary)}
.lgp-notice p{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.lgp-unlock{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:6px}
.lgp-input{flex:1 1 12ch;min-width:0;box-sizing:border-box;height:34px;padding:0 12px;
  border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;
  font-size:13px;line-height:1.5}
.lgp-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.lgp-code{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);
  font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.lgp-foot{flex:0 0 auto;display:flex;flex-direction:column;gap:10px;padding:16px 24px 24px}
.lgp-path{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);
  font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);
  overflow-x:auto;white-space:nowrap;scrollbar-width:none}
.lgp-path::-webkit-scrollbar{display:none}
.lgp-actions{display:flex;align-items:center;gap:8px}
/* The primary action stays right; the New folder button leads the row. */
.lgp-actions>button:last-child{margin-left:auto}
.lgp-create-layer{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  padding:24px;background:var(--dsw-alias-bg-mask-1);backdrop-filter:blur(var(--dsw-mask-blur,4px));
  border-radius:inherit;z-index:1}
.lgp-create{display:flex;flex-direction:column;gap:12px;width:100%;max-width:360px;
  box-sizing:border-box;padding:20px;border-radius:var(--dsw-radius-xl);
  background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l4);
  box-shadow:var(--dsw-shadow-lv3,none)}
.lgp-create .lgp-title{margin:0}
.lgp-create .lgp-hint{margin:0}
.lgp-create-actions{display:flex;justify-content:flex-end;gap:8px}
.lgp-error{color:var(--dsw-alias-state-error-primary)}
.lgp-busy{align-self:center;margin:auto;padding:12px 16px;border-radius:var(--dsw-radius-lg);
  background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);
  font-size:14px;line-height:22px;box-shadow:var(--dsw-shadow-lv3)}
`.trim()
