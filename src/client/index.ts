// A draggable status dot: the user sees the same notes the agent gets, without
// a banner covering the conversation. Click it to expand the detail panel.
//
// Registered into `shell.overlay` — a frame-wide floating list slot that is
// click-through until our own entry opts into pointer events, so the dot never
// eats clicks meant for the conversation below it.
//
// Two invariants from the host's slot guard: the slot name passed to
// `slots.register` must be a string literal with `{` on the same line, and the
// registered component must be a React component (raw DOM renders blank).

declare const require: any
var React = require('react')
var h = React.createElement

var PLUGIN_ID = 'dsh-supervisor'
var API = '/dsh-supervisor/api'
var POLL_MS = 2500

interface Alert {
  id: string
  sessionId: string
  severity: 'concern' | 'blocker'
  note: string
  at: number
  channel: 'pending' | 'delivered' | 'dropped' | 'panel'
  acked: boolean
}

interface SessionState {
  sessionId: string
  reviewer: string
  route?: { provider: string; model: string }
  fallback?: { provider: string; model: string }
  steps: number
  reviews: number
  /** Per-session split of `reviews`; the four unhealthy kinds mean the reviewer is not really working. */
  outcomes?: Record<string, number>
  /** A queued note is waiting to ride the next step the agent enters. */
  pending: boolean
}

interface Snapshot {
  ok?: boolean
  enabled?: boolean
  intercept?: boolean
  stepsBetweenReviews?: number
  totals?: { sessions: number; steps: number; reviews: number; notes: number; unhealthy: number; outcomes: Record<string, number>; parseFails?: Record<string, number>; parseFailsByRoute?: Record<string, Record<string, number>>; errorKinds?: Record<string, number>; falseClearsByCat?: Record<string, number>; gateByRoute?: Record<string, { cleared: number; falseClears: number; flagged: number; confirmed: number; reviews: number }>; gate?: { cleared: number; falseClears: number; flagged: number; confirmed: number } }
  alerts?: Alert[]
  sessions?: SessionState[]
  error?: string
}

var CSS = [
  // The whole widget is dragged, so its position lives in inline style on the host
  // element; only `top` is clamped below the top bar by placeDot(). Everything here
  // is `pointer-events:none` until the dot itself opts in, so it never eats clicks.
  '.dsv-host{position:fixed;z-index:2147483000;pointer-events:none;font-size:13px;line-height:1.5;}',
  // The dot may now sit over the frame's title-bar drag region; the badge and
  // the popup can overlap it too, so they must opt out of window dragging the
  // same way the dot already does (-webkit-app-region:no-drag).
  '.dsv-badge,.dsv-pop{-webkit-app-region:no-drag;}',
  // Status LED: a glossy severity fill (inset highlight + shade) with a
  // page-coloured separation ring and a soft glow. The old hard 6px halo ring
  // read as a fried egg; blur carries the severity colour instead.
  '.dsv-dot{pointer-events:auto;-webkit-app-region:no-drag;position:relative;',
  'width:20px;height:20px;border-radius:50%;cursor:grab;user-select:none;border:none;',
  'background:var(--dsv-sev,var(--dsw-alias-border-default,#9a9a9a));',
  'box-shadow:inset 0 1px 1px rgba(255,255,255,.5),inset 0 -2px 4px rgba(0,0,0,.22),',
  '0 0 0 3px var(--dsw-alias-bg-layer-1,#fff),0 1px 6px rgba(0,0,0,.25);',
  'transition:transform .12s,box-shadow .15s,background .15s;}',
  '.dsv-dot:hover{transform:scale(1.12);}',
  '.dsv-dot:active{cursor:grabbing;transform:scale(1.04);}',
  '.dsv-dot[data-sev="concern"]{--dsv-sev:#d6a13c;',
  'box-shadow:inset 0 1px 1px rgba(255,255,255,.5),inset 0 -2px 4px rgba(0,0,0,.22),',
  '0 0 0 3px var(--dsw-alias-bg-layer-1,#fff),0 0 9px 2px rgba(214,161,60,.38);}',
  '.dsv-dot[data-sev="blocker"]{--dsv-sev:#e0524a;',
  'box-shadow:inset 0 1px 1px rgba(255,255,255,.5),inset 0 -2px 4px rgba(0,0,0,.22),',
  '0 0 0 3px var(--dsw-alias-bg-layer-1,#fff),0 0 10px 3px rgba(224,82,74,.45);}',
  // Breathing halo: a blurred severity glow behind the LED that swells and
  // fades — the alive cue. Blocker breathes faster; this replaces the old
  // expanding ping ring, which only blocker had and read as an alarm strobe.
  '.dsv-dot[data-sev="concern"]::before,.dsv-dot[data-sev="blocker"]::before{content:"";position:absolute;inset:0;',
  'border-radius:50%;background:var(--dsv-sev);filter:blur(5px);z-index:-1;',
  'animation:dsv-breathe 2.6s ease-in-out infinite;}',
  '.dsv-dot[data-sev="blocker"]::before{animation-duration:1.6s;}',
  '@keyframes dsv-breathe{0%,100%{opacity:.3;transform:scale(1);}50%{opacity:.65;transform:scale(1.3);}}',
  '.dsv-dot[data-dim="1"]{opacity:.45;}',
  '.dsv-dot[data-dim="1"]::before{animation:none;opacity:0;}',
  // Count badge: a severity-tinted pill, one family with the LED. The ink pill
  // read as a black blob heavier than the dot itself; the earlier white pill
  // merged with the LED's page-coloured ring. Kept under the LED's radius so
  // it accents the corner instead of covering the dot.
  '.dsv-badge{position:absolute;top:-4px;right:-6px;box-sizing:border-box;',
  'min-width:12px;height:12px;padding:0 3px;',
  'border-radius:999px;font-size:9px;font-weight:700;line-height:13px;text-align:center;pointer-events:none;',
  // Optical centring: digits carry no descender, so their ink sits ~0.5px high
  // in a line box equal to the pill height. A 13px line box in the 12px pill
  // pushes the ink back down half a pixel; the overflow is invisible.
  // Severity fill with a white number, per user preference; the page-coloured
  // ring separates the pill from the LED.
  'background:var(--dsw-alias-border-default,#8a8a8a);color:#fff;',
  'box-shadow:0 0 0 1.5px var(--dsw-alias-bg-layer-1,#fff),0 1px 3px rgba(0,0,0,.3);}',
  '.dsv-badge[data-sev="concern"]{background:#d6a13c;}',
  '.dsv-badge[data-sev="blocker"]{background:#e0524a;}',
  '.dsv-pop{position:absolute;pointer-events:auto;-webkit-app-region:no-drag;',
  'display:flex;flex-direction:column;overflow:hidden;padding:0;border:0;',
  // Official popover surface, verbatim from the host menu recipe: a translucent
  // fill over a 40px blur, no border — the hairline ring lives inside
  // --dsw-elevation-panel. Tokens flip with the theme, so both modes follow.
  'border-radius:var(--dsw-radius-lg,16px);',
  'background:var(--dsw-menu-surface-fill,var(--dsw-alias-bg-layer-3,#232323));',
  'backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));',
  'color:var(--dsw-alias-label-primary,#e6e6e6);',
  'box-shadow:var(--dsw-elevation-panel,0 12px 40px rgba(0,0,0,.28),0 2px 8px rgba(0,0,0,.12));',
  'animation:dsv-in .14s ease-out;}',
  '@keyframes dsv-in{from{opacity:0;transform:translateY(-4px) scale(.98);}to{opacity:1;transform:none;}}',
  // Closing keeps the node mounted for one animation run (the close path sets
  // .dsv-out and unmounts when the timer fires), so the panel fades out instead
  // of vanishing mid-frame.
  '.dsv-pop.dsv-out{animation:dsv-out .12s ease-in forwards;pointer-events:none;}',
  '@keyframes dsv-out{from{opacity:1;transform:none;}to{opacity:0;transform:translateY(-4px) scale(.98);}}',
  '.dsv-pop-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:0 6px 4px;',
  'display:flex;flex-direction:column;',
  'scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l1,#3a3a3a) transparent;}',
  // Host-styled thumb: native scrollbar token, inset by a transparent border so
  // it reads as a slim pill instead of a black bar.
  '.dsv-pop-list::-webkit-scrollbar{width:10px;}',
  '.dsv-pop-list::-webkit-scrollbar-track{background:transparent;}',
  '.dsv-pop-list::-webkit-scrollbar-thumb{border-radius:999px;border:3px solid transparent;',
  'background-clip:padding-box;background:var(--dsw-alias-scrollbar-bg-l1,#3a3a3a);}',
  // Head and footer are plain rows on the glass — the official menu surface has
  // no tinted bands, and a near-opaque header fill would slab over the blur.
  '.dsv-pop-head{display:flex;align-items:center;gap:8px;padding:10px 14px 4px;flex:none;}',
  // Quick toggles ride inside the head row: they take the middle stretch so
  // the ack button stays left and × remains the last element at the right edge.
  '.dsv-quick{display:inline-flex;align-items:center;gap:8px;flex:1 1 auto;justify-content:center;border:0;padding:0;}',
  '.dsv-quick-label{font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary,#b0b0b0);}',
  '.dsv-pop-title{font-size:13px;font-weight:600;letter-spacing:.02em;',
  'color:var(--dsw-alias-label-primary,#e6e6e6);}',
  '.dsv-pop-head .dsv-btn{margin-left:6px;}',
  '.dsv-pop-head .dsv-btn + .dsv-btn{margin-left:6px;}',
  // Plain list, host-native: no invented card backgrounds — items sit on the
  // panel floor and are separated by spacing alone; severity lives in the chip.
  '.dsv-list{display:flex;flex-direction:column;gap:2px;}',
  '.dsv-item{padding:6px 8px 5px;border-radius:var(--dsw-radius-md,12px);transition:background .12s;}',
  '.dsv-item:hover{background:var(--dsw-alias-interactive-bg-hover,transparent);}',
  '.dsv-item[data-acked="1"]{opacity:.5;}',
  // Centred: the ack button is inline-sized now, and every child carries the
  // same 18px line box, so centring puts all four baselines on one line.
  '.dsv-item-head{display:flex;flex-wrap:nowrap;align-items:center;gap:8px;}',
  // Tinted chips, no border; text colour follows the app theme via light-dark()
  // (the host sets the root color-scheme), with a mid tone as the fallback.
  '.dsv-tag{flex:0 0 auto;padding:1px 8px;border-radius:999px;font-size:11px;line-height:18px;font-weight:600;border:none;}',
  '.dsv-tag[data-sev="blocker"]{background:rgba(224,82,74,.14);color:#e0524a;color:light-dark(#c2372f,#ff8b83);}',
  '.dsv-tag[data-sev="concern"]{background:rgba(214,161,60,.16);color:#d6a13c;color:light-dark(#96660f,#e8c07a);}',
  '.dsv-meta{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8a8a);',
  'flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  // The stamp never truncates: it is the part the eye checks first.
  '.dsv-when{flex:0 0 auto;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8a8a);white-space:nowrap;}',
  // Inline-sized: a 30px ack button would stretch the ~20px text row and leave
  // a dead band between the head and the note body.
  '.dsv-item .dsv-btn{margin-left:auto;opacity:.7;padding:1px 8px;font-size:12px;line-height:18px;}',
  '.dsv-item:hover .dsv-btn{opacity:1;}',
  '.dsv-note{white-space:pre-wrap;word-break:break-word;margin-top:4px;font-size:13px;line-height:1.65;}',
  '.dsv-empty{padding:26px 12px;text-align:center;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:12px;}',
  '.dsv-btn{pointer-events:auto;cursor:pointer;border-radius:8px;padding:5px 12px;',
  // inline-flex centers the content optically: the 16px close icon and the
  // 13px CJK label otherwise sit on different baselines inside equal boxes.
  'display:inline-flex;align-items:center;justify-content:center;',
  'font-size:13px;line-height:18px;',
  // Never let a flex parent squeeze a button into a vertical text column.
  'flex:0 0 auto;white-space:nowrap;',
  'border:1px solid transparent;background:transparent;',
  'color:var(--dsw-alias-label-secondary,#b0b0b0);transition:background .12s,color .12s,transform .06s;}',
  // The official menu / ghost buttons hover with the translucent tint
  // (interactive-bg-hover). The -solid variant I used before is meant for
  // opaque surfaces: #f1f3f5 on the glass fill #f8f9fa is nearly invisible.
  '.dsv-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));',
  'color:var(--dsw-alias-label-primary,#e6e6e6);}',
  '.dsv-btn:active{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-interactive-bg-hover-solid,rgba(128,128,128,.24)));transform:scale(.97);}',
  '.dsv-btn:disabled{opacity:.45;cursor:default;}',
  '.dsv-btn:focus-visible{outline:1px solid var(--dsw-alias-border-l3,#666);outline-offset:1px;}',
  '.dsv-btn:disabled{opacity:.45;cursor:default;}',
  '.dsv-btn:disabled:hover{background:transparent;color:var(--dsw-alias-label-secondary,#b0b0b0);transform:none;}',
  // Icon-only close: square box, the svg carries the size. 7+14+7+2 borders
  // keeps the 30px box height shared with the text buttons.
  '.dsv-btn[data-x="1"]{padding:7px;}',
  '.dsv-btn[data-x="1"] svg{display:block;}',
  // Plugins page → dsh-supervisor row → configure.
  // Style B (user-picked from the three-variant mock): macOS-style grouped
  // cards — gray rounded cards, hairline between rows, quiet group titles.
  '.dsv-cfg{max-width:960px;font-size:14px;line-height:1.5;color:var(--dsw-alias-label-primary,#0f1115);}',
  '.dsv-cfg-head{margin:0 0 10px;}',
  '.dsv-cfg-title{margin:0 0 6px;font-size:16px;font-weight:600;line-height:1.3;color:var(--dsw-alias-label-primary,#0f1115);}',
  '.dsv-cfg-desc{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary,#b0b0b0);}',
  '.dsv-cfg p{margin:0 0 8px;color:var(--dsw-alias-label-secondary,#b0b0b0);}',
  '.dsv-group-title{margin:18px 0 8px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-tertiary,#8a8a8a);}',
  // Elevated white card: the gray fill was measured as a low-contrast smudge
  // on the white page ("灰贴纸"), and the 1px border read as a dark line under
  // Windows display scaling. Elevation comes from a two-layer soft shadow
  // instead — the same white-card language as the floating panel.
  '.dsv-card{border-radius:14px;',
  'background:var(--dsw-alias-bg-layer-1,#ffffff);padding:4px 16px;',
  'box-shadow:0 1px 2px rgba(15,17,21,.05),0 4px 16px rgba(15,17,21,.08);',
  // Scroll smoothness (recipe from dsh-hy-proxy): off-screen cards skip
  // layout+paint entirely, so scrolling the long settings page stays cheap.
  // contain-intrinsic-size approximates each card until it renders; the `auto`
  // prefix makes the browser remember the real size after first paint.
  'content-visibility:auto;contain-intrinsic-size:auto 300px;}',
  // The settings dialog's scroll container is host-owned (minified class,
  // measured live). These are advisory hints only — same recipe as
  // dsh-hy-proxy: compositor promotion + no scroll chaining at the ends.
  // Silent no-op if a host rebuild renames the class.
  '.VOzbGW_options{will-change:scroll-position;overscroll-behavior-y:contain;}',
  '.dsv-row{display:flex;align-items:center;gap:8px;padding:12px 0;}',
  '.dsv-row + .dsv-row{border-top:1px solid rgba(0,0,0,.05);}',
  '.dsv-row-main{flex:1 1 auto;min-width:0;}',
  '.dsv-row-label{font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary,#0f1115);}',
  '.dsv-row-hint{margin-top:3px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a);}',
  '.dsv-ctl{flex:0 0 auto;display:flex;align-items:center;}',
  // Pill inputs WITH a visible hairline border: a borderless gray fill reads
  // as a sticker when the field is empty (user-reported). Placeholder tells
  // the user what an empty optional field expects.
  '.dsv-ctl input[type="number"],.dsv-ctl input[type="text"]{height:32px;padding:0 12px;border-radius:10px;',
  'border:1px solid var(--dsw-alias-border-default,#d9d9d9);background:var(--dsw-alias-bg-layer-1,#ffffff);',
  'color:var(--dsw-alias-label-primary,#0f1115);font-size:13px;outline:none;',
  'transition:border-color .15s ease;}',
  '.dsv-ctl input[type="number"]{width:96px;}',
  '.dsv-ctl input[type="text"]{width:200px;}',
  // Pickers wear the same hairline-box language as the text inputs.
  '.dsv-select{height:32px;padding:0 10px;border-radius:8px;max-width:240px;',
  'border:1px solid var(--dsw-alias-border-default,#d9d9d9);background:var(--dsw-alias-bg-layer-1,#ffffff);',
  'color:var(--dsw-alias-label-primary,#0f1115);font-size:13px;outline:none;cursor:pointer;',
  'transition:border-color .15s ease;}',
  '.dsv-select:hover{border-color:var(--dsw-alias-label-tertiary,#8a8a8a);}',
  '.dsv-select:focus{border-color:#316dca;}',
  '.dsv-select:disabled{opacity:.5;cursor:default;}',
  '.dsv-ctl input[type="number"]:focus,.dsv-ctl input[type="text"]:focus{border-color:#316dca;}',
  // Toggle switch for booleans: a real switch reads as "setting". Animated
  // thumb, accent fill when on, stretch on press.
  '.dsv-switch{position:relative;width:36px;height:20px;border-radius:999px;flex:0 0 auto;cursor:pointer;padding:0;',
  'border:1px solid var(--dsw-alias-border-default,#c9c9c9);background:var(--dsw-alias-bg-layer-2,#f2f3f5);',
  'transition:background .15s ease,border-color .15s ease;}',
  '.dsv-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:999px;',
  'background:var(--dsw-alias-label-tertiary,#8a8a8a);transition:transform .15s ease,background .15s ease,width .15s ease;}',
  '.dsv-switch[aria-checked="true"]{background:#316dca;border-color:#316dca;}',
  '.dsv-switch[aria-checked="true"]::after{transform:translateX(16px);background:#ffffff;}',
  '.dsv-switch:active::after{width:17px;}',
  '.dsv-switch:disabled{opacity:.5;cursor:default;}',
  '.dsv-switch:focus-visible{outline:2px solid rgba(49,109,202,.45);outline-offset:1px;}',
  '.dsv-saved{margin-left:auto;font-size:12px;color:#2e9e5b;}',
  '.dsv-bar{display:flex;align-items:center;gap:8px;margin-top:14px;}',
  '.dsv-err{margin-left:auto;font-size:12px;color:#ff8b83;}',
  // Footer: one compact line by default; the per-session grid is opt-in so the
  // reminders keep the height.
  '.dsv-stat{flex:none;margin-top:auto;padding:4px 14px 8px;}',
  '.dsv-stat p{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a);}',
  '.dsv-stat-line{display:flex;align-items:center;gap:8px;font-size:12px;',
  'color:var(--dsw-alias-label-secondary,#b0b0b0);}',
  '.dsv-stat-text{flex:1 1 auto;min-width:0;}',
  // Metrics read as bold number + muted unit, spaced apart instead of one
  // wrapping wall of '·'; a nonzero 异常 turns red like the per-session cells.
  '.dsv-metric{margin-right:10px;white-space:nowrap;}',
  '.dsv-metric b{margin-right:3px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6);}',
  '.dsv-metric[data-bad="1"] b{color:#ff8b83;}',
  // Outcome breakdown lives on its own quiet line, not inside the metrics row.
  '.dsv-stat-sub{margin-top:3px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a);}',
  '.dsv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px 10px;',
  'margin-top:8px;font-size:12px;}',
  '.dsv-cell{color:var(--dsw-alias-label-tertiary,#8a8a8a);overflow:hidden;',
  'text-overflow:ellipsis;white-space:nowrap;}',
  '.dsv-cell b{color:var(--dsw-alias-label-primary,#e6e6e6);font-weight:600;}',
  '.dsv-cell[data-bad="1"] b{color:#ff8b83;}',
  // ── Silent injection ────────────────────────────────────────────────────
  // Supervisor notes render as NOTHING in the conversation: the shadow views
  // return null and the chat frame collapses an empty flow item to zero
  // height. Non-supervisor nodes of the shadowed kinds delegate straight to
  // the host's own component, so no replica CSS is needed here.
].join('')

var styleInstalled = false
function installStyle(): void {
  if (styleInstalled || typeof document === 'undefined') return
  var el = document.createElement('style')
  el.setAttribute('data-dsv', PLUGIN_ID)
  el.textContent = CSS
  document.head.appendChild(el)
  styleInstalled = true
}

// The dot is dragged by the user, so its position is React state persisted to
// localStorage — not a CSS variable measured off the host layout. Only the floor
// comes from the layout: the Windows title bar reserves a variable strip above the
// frame and the conversation header carries `data-window-drag`, so a fixed offset
// would put the dot on top of the title bar. Measure that header instead.
var HEADER_SELECTOR = 'header[data-window-drag]'
var DOT_SIZE = 18
var DOT_MARGIN = 8
var POS_KEY = PLUGIN_ID + ':dot'

interface DotPos { top: number; left: number }

/** Bottom edge of the top bar; the dot may not go above it. */
function headerFloor(): number {
  if (typeof document === 'undefined') return DOT_MARGIN
  var header = document.querySelector(HEADER_SELECTOR) as HTMLElement | null
  if (!header) return DOT_MARGIN
  var rect = header.getBoundingClientRect()
  if (rect.width < 120 || rect.bottom < 0) return DOT_MARGIN // detached or not laid out
  return Math.round(rect.bottom + DOT_MARGIN)
}

/** Keep the dot inside the viewport after a drag, a resize, or a sidebar move.
 *  The old header floor (never above the top bar) is gone per user request:
 *  the dot may sit anywhere, including over the top bar — the frame's title
 *  strip is the only hard limit (viewport margin). */
function clampPos(pos: DotPos): DotPos {
  var w = Math.round(window.innerWidth || 800)
  var h = Math.round(window.innerHeight || 600)
  var top = Math.min(Math.max(pos.top, DOT_MARGIN), Math.max(DOT_MARGIN, h - DOT_SIZE - DOT_MARGIN))
  var left = Math.min(Math.max(pos.left, DOT_MARGIN), Math.max(DOT_MARGIN, w - DOT_SIZE - DOT_MARGIN))
  return top === pos.top && left === pos.left ? pos : { top: top, left: left }
}

/** Default resting place: right edge, just under the top bar. */
function defaultPos(): DotPos {
  return clampPos({ top: headerFloor() + 8, left: Math.round(window.innerWidth || 800) - DOT_SIZE - 20 })
}

function loadPos(): DotPos {
  if (typeof localStorage === 'undefined') return defaultPos()
  try {
    var saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
    if (saved && typeof saved.top === 'number' && typeof saved.left === 'number') return clampPos(saved)
  } catch { /* corrupt entry: fall back to the default corner */ }
  return defaultPos()
}

function savePos(pos: DotPos): void {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(POS_KEY, JSON.stringify(pos)) } catch { /* quota or private mode */ }
}

/** Which side the expanded panel opens into, so it stays inside the viewport.
 *  The max size is measured against the room in the opening direction: a fixed
 *  `max-height` in CSS clips the panel whenever the dot sits mid-screen. */
function panelStyle(pos: DotPos): Record<string, string> {
  var w = Math.round(window.innerWidth || 800)
  var h = Math.round(window.innerHeight || 600)
  var style: Record<string, string> = {}
  if (pos.left + DOT_SIZE / 2 > w / 2) {
    style.right = DOT_SIZE + 8 + 'px'
    style.width = 'min(430px,88vw,' + Math.max(240, pos.left - 16) + 'px)'
  } else {
    style.left = DOT_SIZE + 8 + 'px'
    style.width = 'min(430px,88vw,' + Math.max(240, w - pos.left - DOT_SIZE - 16) + 'px)'
  }
  if (pos.top + DOT_SIZE / 2 > h / 2) {
    style.bottom = '0px'
    style.maxHeight = Math.max(180, pos.top - 12) + 'px'
  } else {
    style.top = '0px'
    style.maxHeight = Math.max(180, h - pos.top - DOT_SIZE - 12) + 'px'
  }
  return style
}

function shortId(sessionId: string): string {
  // Real ids look like `session-b5f4e723-…`; a naive head-8 would label every
  // session `session-`. Drop the constant prefix, then take the first hex run.
  var bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
  return bare.length > 8 ? bare.slice(0, 8) : bare
}

// Host state strings → Chinese, for the live-status panel only (the machine
// values stay English in the API payload).
var REVIEWER_ZH: Record<string, string> = {
  idle: '空闲',
  working: '审查中',
  no_route: '无模型',
  quota_exhausted: '额度耗尽',
  halted: '已停',
  disposed: '已释放',
}

var OUTCOME_ZH: Record<string, string> = {
  silent: '无话可说',
  note: '提出提醒',
  suppressed: '重复抑制',
  gated_clear: 'Jev 门放行',
  unparseable: '回复不可解析',
  error: '调用失败',
  quota: '额度耗尽',
  halted: '永久失败',
}

/** Failure fingerprints (server-side `fingerprintFailure`), for the footer line. */
var KIND_ZH: Record<string, string> = {
  timeout: '超时',
  network: '网络',
  'rate-limit': '限流',
  auth: '鉴权',
  'invalid-request': '无效请求',
  'model-not-found': '模型不存在',
  'max-tokens': '长度超限',
  aborted: '中断',
  'server-5xx': '服务端 5xx',
  other: '其他',
}

/** Review category ids (PROBLEM_CATEGORIES in prompts.ts), for the gate line. */
var CAT_ZH: Record<string, string> = {
  read_selectively: '选择性读',
  unsaid_finding: '隐瞒发现',
  ungrounded_claim: '无据断言',
  untried_impossible: '没试就说不行',
  scope_creep: '范围蔓延',
  blind_tuning: '盲调',
  done_then_changed: '完工又改',
  unknown: '未报类',
}

function relative(at: number, now: number): string {
  var seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return seconds + ' 秒前'
  var minutes = Math.round(seconds / 60)
  if (minutes < 60) return minutes + '分钟前'
  return Math.round(minutes / 60) + ' 小时前'
}

/** Wall-clock stamp, the way the reference band shows `noted N (hh:mm)`. */
function hhmm(at: number): string {
  var d = new Date(at)
  var pad = function (n: number) { return n < 10 ? '0' + n : String(n) }
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/** A raw session id tells the user nothing; the session list knows its title.
 *  `byId` comes from the store snapshot, so the reference only moves when a
 *  session summary actually changes. */
function titleOf(byId: any, sessionId: string): string {
  var summary = byId ? byId[sessionId] : undefined
  if (summary) {
    var title = typeof summary.displayTitle === 'string' ? summary.displayTitle : summary.title
    if (typeof title === 'string' && title.trim()) {
      title = title.replace(/\s+/g, ' ').trim()
      return title.length > 34 ? title.slice(0, 34) + '…' : title
    }
  }
  return '会话 ' + shortId(sessionId)
}

/** Both seats this plugin renders into (shell.overlay, plugins.row.config)
 *  carry `useSessions` in their standard props. Called unconditionally so the
 *  hook order never shifts. */
function useTitles(props: any): (sessionId: string) => string {
  var byId = props && props.useSessions
    ? props.useSessions(function (s: any) { return s.byId }, function (a: any, b: any) { return a === b })
    : null
  return function (sessionId: string) { return titleOf(byId, sessionId) }
}

var AlertItem = function AlertItem(props: { alert: Alert; now: number; label: string; onAck: (id?: string) => void }) {
  var alert = props.alert
  var label = alert.severity === 'blocker' ? '严重' : '注意'
  var held = alert.channel === 'pending' ? '待附加下一步 · ' : alert.channel === 'panel' ? '' : ''
  return h(
    'div',
    { className: 'dsv-item', 'data-sev': alert.severity, 'data-acked': alert.acked ? '1' : '0' },
    h(
      'div',
      { className: 'dsv-item-head' },
      h('span', { className: 'dsv-tag', 'data-sev': alert.severity }, label),
      h('span', { className: 'dsv-meta', title: alert.sessionId }, held + props.label),
      h('span', { className: 'dsv-when' }, hhmm(alert.at) + '（' + relative(alert.at, props.now) + '）'),
      alert.acked
        ? null
        : h('button', { className: 'dsv-btn', type: 'button', onClick: function () { props.onAck(alert.id) } }, '已读'),
    ),
    h('div', { className: 'dsv-note' }, alert.note),
  )
}

function Panel(props: any) {
  // React arrives through `require`, so it is untyped here: no type arguments.
  var snapshotRef = React.useState({} as Snapshot)
  var snapshot = snapshotRef[0]
  var setSnapshot = snapshotRef[1]
  var titleOfSession = useTitles(props)
  // Lazy initialiser: localStorage is read once, not on every render.
  var posRef = React.useState(loadPos)
  var pos = posRef[0]
  var setPos = posRef[1]
  var openRef = React.useState(false)
  var open = openRef[0]
  var setOpen = openRef[1]
  // Closing runs one fade-out before unmount: `closing` keeps the node mounted
  // with .dsv-out until the timer flips `open` off; reopening mid-animation
  // cancels the timer instead of flashing.
  var closingRef = React.useState(false)
  var closing = closingRef[0]
  var setClosing = closingRef[1]
  var closeTimerRef = React.useRef(0 as any)
  function requestClose() {
    // Guard on the ref, not the state: effect closures captured on an earlier
    // render would otherwise see a stale `closing` and schedule twice.
    if (closeTimerRef.current) return
    setClosing(true)
    closeTimerRef.current = setTimeout(function () {
      closeTimerRef.current = 0
      setClosing(false)
      setOpen(false)
    }, 130)
  }
  function requestOpen() {
    if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = 0 }
    if (closing) setClosing(false)
    setOpen(true)
  }
  // Mid-fade the `open` state is still true, so toggle must treat a pending
  // close timer as "closed" or a dot tap during the fade-out is swallowed.
  function togglePanel() { if (open && !closeTimerRef.current) requestClose(); else requestOpen() }
  var writingRef = React.useState(false)
  var writing = writingRef[0]
  var setWriting = writingRef[1]
  var errorRef = React.useState('')
  var error = errorRef[0]
  var setError = errorRef[1]
  /** One config key through the same /config write path the settings page
   *  uses; the panel's own load() refreshes immediately instead of waiting
   *  for the next poll. */
  function toggleConfig(key: string, value: any) {
    if (writingRef.current) return
    setWriting(true)
    fetch(API + '/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: key, value: value }),
    })
      .then(function (r) { return r.json() })
      .then(function (b: any) {
        setWriting(false)
        if (b && b.ok) {
          // Immediate refresh instead of waiting for the next poll: the
          // switch must not lag behind the value it just wrote.
          fetch(API + '/state', { cache: 'no-store' })
            .then(function (r) { return r.json() })
            .then(function (body) { setSnapshot(body || {}) })
            .catch(function () { /* the next poll decides */ })
        } else setError(String((b && b.error) || '宿主拒绝了这次修改'))
      })
      .catch(function (e: any) { setWriting(false); setError(String((e && e.message) || e)) })
  }
  var tickRef = React.useState(0)
  var setTick = tickRef[1]
  var hostRef = React.useRef(null as HTMLElement | null)
  // A drag session: pointer origin, dot origin, and whether it moved far enough
  // to count as a drag rather than a click.
  var dragRef = React.useRef(null as { x: number; y: number; top: number; left: number; moved: boolean } | null)

  React.useEffect(function () {
    installStyle()
    var cancelled = false
    var inflight: Promise<any> | null = null

    function load() {
      if (inflight) return inflight
      inflight = fetch(API + '/state', { cache: 'no-store' })
        .then(function (r) {
          return r.json().then(function (body) {
            if (!r.ok) throw new Error((body && body.error) || 'HTTP ' + r.status)
            return body as Snapshot
          })
        })
        .then(function (next) {
          if (!cancelled) setSnapshot(next || {})
        })
        .catch(function () {
          /* transient: the next poll decides */
        })
        .finally(function () {
          inflight = null
        })
      return inflight
    }

    void load()
    var timer = setInterval(function () {
      void load()
      setTick(function (n: number) { return n + 1 })
    }, POLL_MS)

    // Window resizes and sidebar drags shrink the viewport under a dot the user
    // parked near an edge; re-clamp so it cannot end up off screen. `clampPos`
    // returns the same object when nothing changed, so React bails out.
    function reclamp() {
      setPos(function (p: DotPos) { return clampPos(p) })
    }
    reclamp()
    window.addEventListener('resize', reclamp)
    var observer: any = null
    var header = document.querySelector(HEADER_SELECTOR)
    if (header && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(reclamp)
      observer.observe(document.body)
      observer.observe(header)
    }

    return function () {
      cancelled = true
      clearInterval(timer)
      if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = 0 }
      window.removeEventListener('resize', reclamp)
      if (observer) { try { observer.disconnect() } catch { /* gone */ } }
    }
  }, [])

  React.useEffect(function () { savePos(pos) }, [pos])

  // Outside click and Escape both collapse the detail panel.
  React.useEffect(function () {
    if (!open) return
    function onDown(e: any) {
      var host = hostRef.current
      if (host && !host.contains(e.target)) requestClose()
    }
    function onKey(e: any) {
      if (e.key === 'Escape') requestClose()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return function () {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // ── drag (pointer events, so a pen/touch drag works too) ──
  function onPointerMove(e: any) {
    var start = dragRef.current
    if (!start) return
    var dx = e.clientX - start.x
    var dy = e.clientY - start.y
    if (!start.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return // still a click
    start.moved = true
    setPos(clampPos({ top: start.top + dy, left: start.left + dx }))
  }
  function onPointerUp() {
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    var start = dragRef.current
    dragRef.current = null
    if (start && !start.moved) togglePanel()
  }
  function onPointerDown(e: any) {
    if (e.button !== undefined && e.button !== 0) return
    e.preventDefault() // no text selection while dragging
    dragRef.current = { x: e.clientX, y: e.clientY, top: pos.top, left: pos.left, moved: false }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }

  var alerts: Alert[] = snapshot.alerts || []
  var pending = alerts.filter(function (a: Alert) { return !a.acked && a.channel !== 'dropped' })
  var count = pending.length
  var hasBlocker = pending.some(function (a: Alert) { return a.severity === 'blocker' })
  var sev = hasBlocker ? 'blocker' : count > 0 ? 'concern' : 'none'
  var now = Date.now()

  function ack(id?: string) {
    var url = API + '/ack' + (id ? '?id=' + encodeURIComponent(id) : '')
    void fetch(url, { cache: 'no-store' })
      .then(function () {
        return fetch(API + '/state', { cache: 'no-store' })
          .then(function (r) { return r.json() })
          .then(function (body) { setSnapshot(body || {}) })
      })
      .catch(function () { /* next poll catches up */ })
  }

  var title = count > 0
    ? '审查提醒：' + count + ' 条未读（点击展开）'
    : '审查员：暂无未读提醒（点击查看详情）'

  return h(
    'div',
    {
      className: 'dsv-host',
      style: { top: pos.top + 'px', left: pos.left + 'px' },
      ref: hostRef,
    },
    h(
      'div',
      {
        className: 'dsv-dot',
        'data-sev': sev,
        'data-open': open ? '1' : '0',
        'data-dim': snapshot.enabled === false ? '1' : '0',
        title: title,
        onPointerDown: onPointerDown,
      },
    ),
    count > 0 ? h('div', { className: 'dsv-badge', 'data-sev': sev }, String(count > 99 ? '99+' : count)) : null,
    open
      ? h(
          'div',
          { className: 'dsv-pop' + (closing ? ' dsv-out' : ''), style: panelStyle(pos) },
          h(
            'div',
            { className: 'dsv-pop-head' },
            h('span', { className: 'dsv-pop-title' }, '审查提醒'),
            // Quick toggles live INSIDE the head row (right after the title):
            // a separate row left a wide empty gap (title/ack left, switches
            // pinned to both edges) and the user called the layout out twice.
            h(
              'div',
              { className: 'dsv-quick' },
              h('span', { className: 'dsv-quick-label' }, '启用'),
              h('button', {
                className: 'dsv-switch', type: 'button', role: 'switch',
                'aria-checked': !!snapshot.enabled, 'aria-label': '启用审查员',
                disabled: writing, onClick: function () { toggleConfig('enabled', !snapshot.enabled) },
              }),
              h('span', { className: 'dsv-quick-label' }, '下一步附加'),
              h('button', {
                className: 'dsv-switch', type: 'button', role: 'switch',
                'aria-checked': !!snapshot.intercept, 'aria-label': '下一步附加',
                disabled: writing, onClick: function () { toggleConfig('intercept', !snapshot.intercept) },
              }),
              error ? h('span', { className: 'dsv-err' }, error) : null,
            ),
            // Always rendered (disabled when nothing is unread): a button that
            // unmounts on ack would make the centred switches jump sideways.
            h('button', { className: 'dsv-btn', type: 'button', disabled: count === 0, onClick: function () { ack() } }, '全部已读'),
            h('button', { className: 'dsv-btn', type: 'button', 'data-x': '1', title: '收起', onClick: function () { requestClose() } },
              // A real stroke icon (lucide x), matching the host's close
              // glyphs — the old child was a literal × text character.
              h('svg', {
                width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
                stroke: 'currentColor', 'stroke-width': 2,
                'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
              }, h('path', { d: 'M18 6 6 18' }), h('path', { d: 'm6 6 12 12' }))),
          ),
          h(
            'div',
            { className: 'dsv-pop-list' },
            alerts.length === 0
              ? h('div', { className: 'dsv-empty' }, '暂无提醒。审查员每 ' + (snapshot.stepsBetweenReviews || 6) + ' 步看一次最近的转录。')
              : h(
                  'div',
                  { className: 'dsv-list' },
                  alerts.slice(0, 20).map(function (a: Alert) {
                    return h(AlertItem, { key: a.id, alert: a, now: now, label: titleOfSession(a.sessionId), onAck: ack })
                  }),
                ),
          ),
          h(Status, { live: snapshot, titleOf: titleOfSession }),
        )
      : null,
  )
}

// ── Plugins page → dsh-supervisor row → configure ────────────────────────────
// `plugins.row.config` is keyed by `<bundle>#<row id>`; both are `dsh-supervisor`
// here because the bundle patch inserts one row whose id is the package name.
// The page owner re-reads the form snapshot on every render, so this card keeps
// only its own unsaved draft and drops it when the host revision moves.
interface ConfigFormState {
  status: 'loading' | 'ready' | 'unavailable'
  value: Record<string, unknown> | undefined
  base: unknown
  user: unknown
  revision: number | undefined
  writable: boolean
  mode: 'host' | 'memory'
}

interface ConfigForm {
  state: ConfigFormState
  mutate: (ops: any[], expectedRevision?: number) => Promise<boolean>
}

interface CardProps {
  view: 'summary' | 'page'
  form?: ConfigForm
}

interface FieldSpec {
  key: string
  label: string
  hint: string
  toggle?: boolean
  text?: boolean
  select?: 'route'
  ph?: string
  min?: number
  max?: number
}

// Mirrors src/config.ts; the server validates every write against those keys
// and coerces types, so these bounds only keep the number inputs honest.
// Labels are Chinese on purpose: the reviewer's note is Chinese, so the surface
// that explains it should be too. No locale table — this plugin ships one UI language.
var FIELDS: FieldSpec[] = [
  { key: 'enabled', label: '启用', hint: '开启后台审查员盯着每个会话。关闭时审查员不会调用任何模型。', toggle: true },
  { key: 'stepsBetweenReviews', label: '审查间隔（步）', hint: '每多少步审查一次。额外 token 成本约为 1/N。', min: 1, max: 60 },
  { key: 'intercept', label: '下一步即附加', hint: '提醒默认等你下次提问时才进入会话；开启后它随下一个 step 附加（不重排、不打断轮次）。', toggle: true },
  { key: 'jevGate', label: 'jev 检测门', hint: '审查前先过一道 jev 快筛：命中的类别作为线索拼进审查提示词。', toggle: true },
  { key: 'gateSkipClear', label: '门清即跳过（省钱模式）', hint: '默认关闭：门判全清也照审，误放可度量。开启后全清的 delta 跳过模型调用。', toggle: true },
  { key: 'fallbackRoute', label: '回退路由', hint: '审查路由连续失败后切到这条路由；留空则不启用回退，连续失败时面板会亮失明提醒。', select: 'route', ph: '不启用' },
  { key: 'fallbackAfterErrors', label: '回退触发（连败次数）', hint: '连续多少次 transient 失败后切回退路由。', min: 1, max: 20 },
  { key: 'reviewRoute', label: '审查模型', hint: '固定审查模型：选定后所有会话都用它审查；留空 = 跟随各会话自己的模型。强主模型可能是弱审查员（契约遵守差）。', select: 'route', ph: '跟随会话' },
  { key: 'maxDeltaMessages', label: '每次审查的消息数', hint: '送给审查员的增量转录上限（0 = 不限）。只送新增的消息。', min: 0, max: 500 },
  { key: 'maxNoteChars', label: '提醒长度上限', hint: '超长的提醒在送到主 agent 之前会被截断并加省略号。', min: 80, max: 4000 },
  { key: 'reviewMaxTokens', label: '审查回复预算', hint: '审查调用的 maxTokens。推理模型需要余量，否则会返回空正文。', min: 128, max: 8192 },
]

function ConfigCard(props: CardProps) {
  // The settings.section seat does not hand out the host form, so the card
  // owns its read/write path: GET /config for current values, POST /config to
  // persist one key through configEditor (server side). Fully functional in
  // the settings page; the host form is no longer part of this plugin's UI.
  var valuesRef = React.useState({} as Record<string, unknown>)
  var values = valuesRef[0]
  var setValues = valuesRef[1]
  var writableRef = React.useState(false)
  var writable = writableRef[0]
  var setWritable = writableRef[1]
  var loadErrRef = React.useState('')
  var loadErr = loadErrRef[0]
  var setLoadErr = loadErrRef[1]

  var draftRef = React.useState({} as Record<string, unknown>)
  var draft = draftRef[0]
  var setDraft = draftRef[1]

  var errRef = React.useState('')
  var error = errRef[0]
  var setError = errRef[1]
  var busyRef = React.useState(false)
  var busy = busyRef[0]
  var setBusy = busyRef[1]
  var savedRef = React.useState(false)
  var saved = savedRef[0]
  var setSaved = savedRef[1]
  var savedTimer = React.useRef(0 as unknown as ReturnType<typeof setTimeout>)

  var liveRef = React.useState({} as Snapshot)
  var live = liveRef[0]
  var setLive = liveRef[1]
  // Live provider/model directory for the two pickers (/models is served from
  // inside the host, so it works without browser credentials).
  var dirRef = React.useState({ providers: [] as any[], models: [] as any[] })
  var dir = dirRef[0]
  var setDir = dirRef[1]
  var providers = dir.providers
  var models = dir.models
  var titleOfSession = useTitles(props)

  React.useEffect(function () {
    installStyle()
    // Poll in every view but the one-line summary. /state and /config are
    // auth-free and cheap; without the poll the ledger and the current values
    // would sit frozen at an empty snapshot.
    if (props.view === 'summary') return undefined
    var cancelled = false
    function pull() {
      fetch(API + '/state', { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (body) { if (!cancelled) setLive((body || {}) as Snapshot) })
        .catch(function () { /* the next poll decides */ })
      fetch(API + '/config', { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (body) {
          if (cancelled) return
          if (body && body.ok) {
            setValues((body.values || {}) as Record<string, unknown>)
            setWritable(!!body.writable)
            setLoadErr('')
          } else if (!cancelled) setLoadErr('配置读取失败。')
        })
        .catch(function () { if (!cancelled) setLoadErr('配置读取失败。') })
      fetch(API + '/models', { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (body) {
          if (!cancelled && body && body.ok) setDir({ providers: body.providers || [], models: body.models || [] })
        })
        .catch(function () { /* pickers keep their empty option */ })
    }
    pull()
    var timer = setInterval(pull, POLL_MS)
    return function () { cancelled = true; clearInterval(timer) }
  }, [props.view])

  function current(key: string): unknown {
    return Object.prototype.hasOwnProperty.call(draft, key) ? draft[key] : values[key]
  }
  function edit(key: string, next: unknown) {
    setDraft({ ...draft, [key]: next })
  }
  var dirty = FIELDS.some(function (f: FieldSpec) {
    return Object.prototype.hasOwnProperty.call(draft, f.key) && draft[f.key] !== values[f.key]
  })

  function save() {
    if (!writable || !dirty || busy) return
    var changed = FIELDS.filter(function (f: FieldSpec) {
      return Object.prototype.hasOwnProperty.call(draft, f.key) && draft[f.key] !== values[f.key]
    })
    if (changed.length === 0) { setDraft({}); return }
    setBusy(true)
    setError('')
    var failed = ''
    var seq: Promise<void> = Promise.resolve()
    for (var f of changed) {
      ;(function (field: FieldSpec) {
        seq = seq.then(function () {
          if (failed) return
          return fetch(API + '/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: field.key, value: draft[field.key] }),
          })
            .then(function (r) { return r.json() })
            .then(function (b: any) { if (!b || !b.ok) failed = (b && b.error) || '宿主拒绝了这次修改' })
        })
      })(f)
    }
    void seq.then(function () {
      setBusy(false)
      if (failed) { setError(failed); return }
      setDraft({})
      // Submit feedback: the switch/number row gives no other cue that the
      // write landed (the values only move after the next /config poll).
      setSaved(true)
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(function () { setSaved(false) }, 2000)
      fetch(API + '/config', { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (body) { if (body && body.ok) setValues((body.values || {}) as Record<string, unknown>) })
        .catch(function () { /* the next poll decides */ })
    })
  }

  if (props.view === 'summary') {
    return h('span', null, '后台审查员：每隔几步用同一个模型复查最近的转录。')
  }

  // Four sectioned cards; every config key lives in exactly one.
  var GROUPS: Array<{ title: string; keys: string[] }> = [
    { title: '运行', keys: ['enabled', 'stepsBetweenReviews', 'intercept'] },
    { title: '审查门', keys: ['jevGate', 'gateSkipClear'] },
    { title: '审查模型', keys: ['reviewRoute'] },
    { title: '故障回退', keys: ['fallbackRoute', 'fallbackAfterErrors'] },
    { title: '增量与预算', keys: ['maxDeltaMessages', 'maxNoteChars', 'reviewMaxTokens'] },
  ]
  var rows = GROUPS.map(function (g: { title: string; keys: string[] }) {
    var inner = g.keys
      .map(function (key) { return FIELDS.find(function (f: FieldSpec) { return f.key === key }) })
      .filter(function (f): f is FieldSpec { return !!f })
      .map(function (f: FieldSpec) {
        var control: any
        if (f.toggle) {
          control = h('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': !!current(f.key),
            'aria-label': f.label,
            className: 'dsv-switch',
            disabled: !writable || busy,
            onClick: function () { edit(f.key, !current(f.key)) },
          })
        } else if (f.select === 'route') {
          // One picker per route: value is `provider\u0000model` (either side may
          // be empty while the other is set). Options are `provider · model`,
          // so a single dropdown replaces the old two-field pair.
          var ROUTE_SEP = '\u0000'
          var cur = String(current(f.key) ?? '')
          var parts = cur.split(ROUTE_SEP)
          var curP = parts[0] || ''
          var curM = parts[1] || ''
          var opts: any[] = [h('option', { value: '', key: 'none' }, f.ph || '跟随会话')]
          var seen: Record<string, boolean> = {}
          if (curP && !providers.some(function (p: any) { return p.id === curP })) {
            opts.push(h('option', { value: curP + ROUTE_SEP + curM, key: 'cur' }, (curP || '?') + ' · ' + (curM || '?') + '（当前值）'))
            seen[curP + ROUTE_SEP + curM] = true
          }
          for (var p of providers) {
            var pms = models.filter(function (m: any) { return m.provider === p.id })
            if (pms.length === 0) {
              var k0 = p.id + ROUTE_SEP
              if (!seen[k0]) { seen[k0] = true; opts.push(h('option', { value: k0, key: k0 }, (p.name || p.id) + ' · （默认模型）')) }
              continue
            }
            for (var m of pms) {
              var k = p.id + ROUTE_SEP + m.id
              if (seen[k]) continue
              seen[k] = true
              var label = (p.name || p.id) + ' · ' + (m.name || m.id)
              opts.push(h('option', { value: k, key: k }, label))
            }
          }
          control = h(
            'select',
            {
              className: 'dsv-select',
              value: cur,
              'aria-label': f.label,
              disabled: !writable || busy,
              onChange: function (e: any) { edit(f.key, e.target.value) },
            },
            opts,
          )
        } else {
          control = h('input', {
            type: f.text ? 'text' : 'number',
            value: current(f.key) as any,
            min: f.min,
            max: f.max,
            placeholder: f.ph,
            'aria-label': f.label,
            disabled: !writable || busy,
            onChange: function (e: any) { edit(f.key, e.target.value) },
          })
        }
        return h(
          'div',
          { className: 'dsv-row', key: f.key },
          h(
            'div',
            { className: 'dsv-row-main' },
            h('div', { className: 'dsv-row-label' }, f.label),
            h('div', { className: 'dsv-row-hint' }, f.hint),
          ),
          h('div', { className: 'dsv-ctl' }, control),
        )
      })
    return h(
      'div',
      { key: g.title },
      h('div', { className: 'dsv-group-title' }, g.title),
      h('div', { className: 'dsv-card' }, inner),
    )
  })

  var note = loadErr ? loadErr : !writable ? '配置服务不可用（configEditor 无本插件条目），当前只读。' : ''

  return h(
    'div',
    { className: 'dsv-cfg' },
    // The summary view early-returns above, so everything below is the page.
    h(
      'div',
      { className: 'dsv-cfg-head' },
      h('h2', { className: 'dsv-cfg-title' }, '审查员'),
      h('p', { className: 'dsv-cfg-desc' }, '后台旁观审查员：每隔几步用同一个模型复查最近的转录，只就七类问题出声；提醒静默注入主 agent，并在右上角圆点向你亮角标。'),
    ),
    note ? h('p', null, note) : null,
    rows,
    h(
      'div',
      { className: 'dsv-bar' },
      h('button', { className: 'dsv-btn', type: 'button', disabled: !writable || !dirty || busy, onClick: save }, busy ? '保存中…' : '保存'),
      h('button', { className: 'dsv-btn', type: 'button', disabled: !dirty || busy, onClick: function () { setDraft({}); setError('') } }, '放弃'),
      saved && !error ? h('span', { className: 'dsv-saved' }, '已保存') : null,
      error ? h('span', { className: 'dsv-err' }, error) : null,
    ),
    h(Status, { live: live, titleOf: titleOfSession }),
  )
}

/** What the reviewer actually did since the host started: the evidence that the loop runs. */
function Status(props: { live: Snapshot; titleOf?: (sessionId: string) => string }) {
  var live = props.live
  var titleOf = props.titleOf || function (sessionId: string) { return '会话 ' + shortId(sessionId) }
  var openRef = React.useState(false)
  var open = openRef[0]
  var setOpen = openRef[1]
  if (!live.ok) return h('div', { className: 'dsv-stat' }, h('p', { className: 'dsv-stat-line' }, '无法访问 ' + API + '/state。'))

  var totals = live.totals
  var outcomes: string[] = []
  if (totals) {
    for (var key of Object.keys(totals.outcomes || {})) {
      var count = totals.outcomes[key]
      if (count) outcomes.push(OUTCOME_ZH[key] + ' ' + count)
    }
    // Gate calibration line, both sides: the clear side (how often jev said
    // clean and the LLM disagreed) and the hit side (how often jev flagged and
    // the review then raised a note). Shown once there is anything to show.
    var gate = totals.gate
    if (gate && (gate.cleared > 0 || gate.flagged > 0)) {
      var parts: string[] = []
      if (gate.cleared > 0) parts.push('门 clear ' + gate.cleared + (gate.falseClears ? ' · 误放 ' + gate.falseClears : ''))
      if (gate.flagged > 0) parts.push('命中 ' + gate.flagged + (gate.confirmed ? ' · 证实 ' + gate.confirmed : ''))
      outcomes.push(parts.join(' · '))
    }
    // Failure fingerprints, so a throttled route reads differently from a
    // dead one: `error` alone never said which fix was needed.
    var kinds = totals.errorKinds
    if (kinds) {
      var kindParts: string[] = []
      for (var kind of Object.keys(kinds)) {
        var n = kinds[kind]
        if (n) kindParts.push(KIND_ZH[kind] || kind + ' ' + n)
      }
      if (kindParts.length) outcomes.push('失败 ' + kindParts.join(' · '))
    }
    // Which categories the gate's misses were about: a concentration on one
    // class is a prompt fix, an even spread is a threshold fix.
    var cats = totals.falseClearsByCat
    if (cats) {
      var catParts: string[] = []
      for (var cat of Object.keys(cats)) {
        var cn = cats[cat]
        if (cn) catParts.push((CAT_ZH[cat] || cat) + ' ' + cn)
      }
      if (catParts.length) outcomes.push('误放类别 ' + catParts.join(' · '))
    }
  }

  var sessions: SessionState[] = (live.sessions || []).slice(0, 12)
  var cells = sessions.map(function (s: SessionState) {
    var bad = 0
    for (var key of ['unparseable', 'error', 'quota', 'halted']) {
      var count = s.outcomes ? s.outcomes[key] : 0
      if (count) bad += count
    }
    var text = (REVIEWER_ZH[s.reviewer] || s.reviewer) + ' · ' + s.steps + ' 步 · ' + s.reviews + ' 次审查' + (s.pending ? ' · 待附加' : '') + (s.route ? ' · ' + s.route.provider + '/' + s.route.model : '') + (s.fallback ? ' · 回退 ' + s.fallback.provider + '/' + s.fallback.model : '')
    return h('div', { className: 'dsv-cell', key: s.sessionId, 'data-bad': bad ? '1' : '0', title: s.sessionId }, h('b', null, titleOf(s.sessionId)), ' — ' + text)
  })

  var metrics = totals
    ? ([[totals.sessions, '个会话'], [totals.steps, '步'], [totals.reviews, '次审查'], [totals.notes, '条提醒'], [totals.unhealthy, '次异常']] as [number, string][]).map(function (p, i) {
        return h('span', { key: i, className: 'dsv-metric', 'data-bad': p[1] === '次异常' && p[0] > 0 ? '1' : '0' }, h('b', null, String(p[0])), p[1])
      })
    : null

  return h(
    'div',
    { className: 'dsv-stat' },
    h(
      'div',
      { className: 'dsv-stat-line' },
      h('span', { className: 'dsv-stat-text' }, metrics || '等待首次拉取…'),
      h('button', {
        className: 'dsv-btn', type: 'button',
        onClick: function () { setOpen(function (v: boolean) { return !v }) },
      }, open ? '收起' : '详情'),
    ),
    outcomes.length ? h('div', { className: 'dsv-stat-sub' }, outcomes.join(' · ')) : null,
    open && cells.length ? h('div', { className: 'dsv-grid' }, cells) : null,
  )
}

// ── Silent injection: shadow the host's chat-node renderers ────────────────
// A supervisor note enters the session log as a `user/message` with
// `source.kind === 'supervisor'`. The chat projection classifies it as a
// `context` node, or as `turn-trigger` when it woke an idle agent — both loud
// surfaces. We shadow both keyed cells at priority -1 (lowest live entry of a
// cell renders) and return null for supervisor sources; the chat frame
// collapses an empty flow item to zero height, so the note leaves no trace in
// the conversation while still reaching the model.
//
// Every OTHER source in those two cells must keep looking exactly like the
// host, so instead of replicating the host cards we delegate: the host's own
// component is read off the slot ledger (`ctx.slots.entries(key)`, the
// inspection surface the render machinery itself uses) and rendered with the
// props our entry received. Props are contract-identical — the host registers
// `TurnTriggerNodeView({node, t})` and `ContextMessageNodeView({node, t})`
// into the same keyed cells, and our entries declare `locale: 'chat'`, so the
// render machinery synthesizes the same `t` seat for us (renderer: an entry's
// `t` comes from its own `locale` declaration). The lookup is lazy and cached:
// at our apply time the chat entry may not be registered yet.

var HOST_COMPONENTS: Record<string, any> = {}

function noteText(content: any): string {
  if (!Array.isArray(content)) return ''
  var out = ''
  for (var block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/** The host's own renderer for a keyed chat-node cell, live-probed and cached.
 *  `entries()` is keyed by SLOT name, not cell key, so read the whole ledger
 *  for the chat-node slot and pick the host's entry for this cell — our own
 *  shadow entries are the ones carrying a negative priority. */
function hostNodeComponent(slots: any, cellKey: string): any {
  var cached = HOST_COMPONENTS[cellKey]
  if (cached && slots.isLive && slots.isLive(cached.entry)) return cached.component
  var found: any = null
  try {
    var entries = slots.entries('conversation.chat.node')
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i]
      var options = entry && entry.options
      if (!options || options.key !== cellKey) continue
      if (typeof options.priority === 'number' && options.priority < 0) continue
      if (entry.component) { found = entry; break }
    }
  } catch { /* undeclared or disposed: fall through to the fallback */ }
  HOST_COMPONENTS[cellKey] = found ? { entry: found, component: found.component } : null
  return found ? found.component : undefined
}

function isSupervisorSource(source: any): boolean {
  return !!source && source.kind === 'supervisor'
}

function nodeSource(props: any): any {
  var node = props && props.node
  return node && node.data ? node.data.source : undefined
}

/** Silent for supervisor notes; the host's own view for everything else. */
function makeShadowView(slots: any, key: string, fallbackLabel: string) {
  return function ShadowView(props: any) {
    // Hooks first, unconditionally: the branches below return early, and a
    // hook after a conditional return would break the order on re-render.
    var openState = React.useState(false)
    var open = openState[0]
    var setOpen = openState[1]
    if (isSupervisorSource(nodeSource(props))) return null
    var Host = hostNodeComponent(slots, key)
    if (Host) return h(Host, props)
    // The host entry is gone or was never registered: degrade to a plain
    // disclosure instead of rendering nothing for host traffic.
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    var text = noteText(props.node && props.node.data && props.node.data.content)
    return h(
      primitives.DisclosureRow,
      {
        icon: h('span', null, h(primitives.IconContextInjectionOutlineRegular, { size: 14 })),
        title: fallbackLabel,
        open: open,
        expandable: true,
        onToggle: function () { setOpen(!open) },
        previewChevron: true,
        collapsedContent: h('span', null, text.split('\n')[0].slice(0, 120)),
      },
      h('div', { style: { padding: '4px 12px 10px 30px', whiteSpace: 'pre-wrap' } }, text),
    )
  }
}

/**
 * 设置页导航图标补丁 —— 与 dsh-usage-heatmap / dshmarket / dsh-better-sidebar
 * 同款做法：`settings.section` 契约只有 id/order/label（无 icon 字段），外壳
 * `navIcon(id)` 对未知 id 回落齿轮；按本插件自己的 label 文本认领那一行，打标记，
 * 用 CSS mask 把齿轮换成自己的图标（mask 只读 alpha，可见色走 currentColor，
 * 自动跟随 hover/active）。宿主 DOM 变化时补丁静默失效，不影响面板本体。
 * 删除条件：settings.section 长出 icon 字段。
 */
var NAV_ICON_MARKER = 'data-dsv-nav-icon'
var NAV_ROW_SELECTOR = '[role="dialog"] nav button'
var NAV_ICON_LABEL = '审查员'
var NAV_ICON_MASK = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23000' fill-rule='evenodd' d='M12 5C5.5 5 2.1 10.2 1.3 11.5a1 1 0 0 0 0 1C2.1 13.8 5.5 19 12 19s9.9-5.2 10.7-6.5a1 1 0 0 0 0-1C21.9 10.2 18.5 5 12 5Zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Z'/%3E%3Ccircle cx='12' cy='12' r='2' fill='%23000'/%3E%3C/svg%3E\")"

function navIconCss(): string {
  return [
    '[' + NAV_ICON_MARKER + '] > svg { display: none; }',
    '[' + NAV_ICON_MARKER + ']::before {',
    "  content: '';",
    '  flex: none;',
    '  width: 16px;',
    '  height: 16px;',
    '  background-color: currentColor;',
    '  -webkit-mask-image: ' + NAV_ICON_MASK + ';',
    '  mask-image: ' + NAV_ICON_MASK + ';',
    '  -webkit-mask-repeat: no-repeat;',
    '  mask-repeat: no-repeat;',
    '  -webkit-mask-position: center;',
    '  mask-position: center;',
    '  -webkit-mask-size: 16px 16px;',
    '  mask-size: 16px 16px;',
    '}',
  ].join('\n')
}

/** 独立注入样式表：设置导航在面板渲染之前就要显示图标，时序与面板 CSS 对不上。 */
function installSettingsNavIcon(): () => void {
  if (typeof document === 'undefined' || !document.body) return function () {}
  var tag = document.createElement('style')
  tag.id = 'dsh-supervisor-nav-icon-style'
  tag.textContent = navIconCss()
  document.head.appendChild(tag)

  var disposed = false
  var scheduled = false
  function sync(): void {
    scheduled = false
    if (disposed) return
    if (!document.querySelector('[role="dialog"]')) return
    var rows = document.querySelectorAll(NAV_ROW_SELECTOR)
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i]
      if (String(row.textContent || '').trim() === NAV_ICON_LABEL) row.setAttribute(NAV_ICON_MARKER, '')
      else row.removeAttribute(NAV_ICON_MARKER)
    }
  }
  function schedule(): void {
    if (scheduled || disposed) return
    scheduled = true
    var qm = typeof queueMicrotask === 'function' ? queueMicrotask : function (f: any) { setTimeout(f, 0) }
    qm(sync)
  }
  sync()
  var observer: any = null
  try {
    observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
  } catch {
    /* 观察失败：至少已同步过一次 */
  }
  return function () {
    disposed = true
    try { if (observer) observer.disconnect() } catch { /* ignore */ }
    var marked = document.querySelectorAll('[' + NAV_ICON_MARKER + ']')
    for (var i = 0; i < marked.length; i++) {
      try { marked[i].removeAttribute(NAV_ICON_MARKER) } catch { /* ignore */ }
    }
    try { tag.remove() } catch { /* ignore */ }
  }
}

function registerAll(ctx: any): () => void {
  var slots = ctx.slots
  var disposers: Array<() => void> = []
  disposers.push(
    slots.inject('shell.overlay', function () {
      return slots.register({ name: 'shell.overlay', id: PLUGIN_ID + '.banner', order: 900, label: 'Supervisor banner' }, Panel)
    }),
  )
  // A first-class page of its own in the settings panel's left nav (same seat
  // as 手机访问 / LLM 自动重试), per user choice — the ONLY settings surface of
  // this plugin: the Plugins row keeps no separate configure card.
  disposers.push(
    slots.inject('settings.section', function () {
      return slots.register({ name: 'settings.section', id: PLUGIN_ID + '.settings', order: 50, label: '审查员' }, ConfigCard)
    }),
  )
  // Shadow both chat-node cells a supervisor note can be routed into:
  // `turn-trigger` (the note woke an idle agent) and plain `context` (it was
  // injected into a running step). Same keys at priority -1, so our entry is
  // the cell's only live winner; `locale: 'chat'` gives us the same `t` seat
  // the host entries render with, which the delegated host component needs.
  disposers.push(
    slots.inject('conversation.chat.node', function () {
      return slots.register(
        { name: 'conversation.chat.node', key: 'turn-trigger', priority: -1, locale: 'chat' },
        makeShadowView(slots, 'turn-trigger', '收到执行请求'),
      )
    }),
  )
  disposers.push(
    slots.inject('conversation.chat.node', function () {
      return slots.register(
        { name: 'conversation.chat.node', key: 'context', priority: -1, locale: 'chat' },
        makeShadowView(slots, 'context', '上下文注入'),
      )
    }),
  )
  disposers.push(installSettingsNavIcon())
  return function () {
    for (var dispose of disposers) {
      try { dispose() } catch { /* already gone */ }
    }
  }
}

export const name = PLUGIN_ID
// Must stay `export const`: the injector's skeleton check matches this by text.
export const inject = ['slots']

export function apply(ctx: any): void {
  if (ctx.effect) {
    ctx.effect(function () { return registerAll(ctx) }, PLUGIN_ID + ': status dot')
  } else {
    registerAll(ctx)
  }
}
