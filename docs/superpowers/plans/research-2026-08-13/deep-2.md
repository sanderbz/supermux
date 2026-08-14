# Grok Bot — Cross-surface integration & navigation (evidence report)

Evidence: `bot-dom.html` (rendered app replica), `bot-css.txt` (full stylesheets), `grokbot-rules.css`, `bot-styles.json` (906 computed-geometry records), `docs-*.txt`, `hn-49261514.txt`, reviews, ~60 PNGs. Derived working files written during analysis: `/tmp/claude-1000/-opt-projects-supermux/0ce1fa02-9bc2-41c3-b2c6-7b2814d510c0/scratchpad/anim-rules.txt` (118 transition/animation rules), `.../app-rules.txt` (197 app-component rules), `.../shell-dom.txt` (cleaned shell markup).

**Key methodological finding:** the marketing page ships the **real app component CSS** (chunk `42fak_zm5_c89.css`), including selectors the replica never instantiates — `.baby-grok-bot-side-pane`, `.baby-grok-bot-screen-*`, `.baby-grok-bot-compose-popover`, `.baby-grok-bot-choice-*`, `.baby-grok-bot-pinned-tile`, `.baby-grok-bot-message-panel`. Those are product specs, not marketing mock-ups.

---

## 1. The shell

### 1.1 One substrate, three tinted columns

```css
.baby-grok-bot-shell{
  display:grid;
  grid-template-columns: minmax(0,auto) minmax(0,1fr) minmax(0,auto);
  background: var(--grok-bot-shared-substrate);      /* #fcfcfca6 light · #1c1c1a9e dark */
  -webkit-backdrop-filter: var(--grok-bot-glass-backdrop-filter); /* blur(80px) saturate(180%) */
  border-radius: inherit; overflow: hidden; position: relative;
}
```

The single most important structural fact: **the whole window is one glass surface; the columns are translucent tints on top of it.** The sidebar explicitly declares `--grok-bot-sidebar-backdrop-filter: none` and paints only `--grok-bot-sidebar-tint` (`#fbfbfb59` = 35% alpha light, `#14141447` = 28% dark). The chat paints `--grok-bot-chat-fill: color-mix(in srgb, var(--grok-bot-bg-elevated) 86%, transparent)` (84% dark). Nothing re-blurs. One blur, three alphas — that is why the columns read as regions of one app rather than three panels.

Measured (bot-styles.json, 976×660 shell): sidebar-slot `280×660`, chat `696×660`, side-pane column collapsed to 0. Shell radius 24px; float shadow `.baby-grok-bot-window-float{box-shadow:0 14px 40px #00000029, 0 0 0 .5px #0000000d}`.

Separators are hairlines, never coloured borders: `.baby-grok-bot-sidebar:after` is a `0.5px` absolute strip at `right:0`; the chat header is `border-bottom:.5px solid var(--grok-bot-border-default)`; the side pane is `border-left:.5px`.

### 1.2 Window chrome

- `.baby-grok-bot-traffic-lights` — `position:absolute; top:0; left:16px; height:var(--grok-bot-toolbar-height); z-index:6; pointer-events:none`, 12px dots with `inset 0 0 0 .5px rgba(0,0,0,.2)`. It is **not** inside the sidebar; it floats over the shell so the sidebar can scroll/collapse underneath it.
- `.baby-grok-bot-traffic-lights-spacer{width:52px}` inside `.baby-grok-bot-sidebar-header__lead` reserves the space. Token: `--grok-bot-titlebar-inset: 52px`.
- Toolbar row height is **one token**, `--grok-bot-toolbar-height: 44px`, used by both the sidebar header and the chat header → the two columns' first rows align to the pixel.
- Sidebar width `--grok-bot-sidebar-width: 280px` plus a drag handle: `<div role="separator" aria-orientation="vertical" aria-label="Resize sidebar" class="absolute inset-y-0 -right-1.5 z-10 w-3 cursor-col-resize">` — a 12px hit target straddling the hairline.
- Parameterised-but-flush tokens `--grok-bot-sidebar-inset:0px` / `--grok-bot-sidebar-radius:0px` exist so a "floating sidebar card" variant is a two-value change, not a refactor.

### 1.3 Z-layer ladder (exact, from CSS)

| z | element |
|---|---|
| 1 | `.baby-grok-bot-chat` (and the composer `<form class="relative z-[1]">`) |
| 3 | `.baby-grok-bot-sidebar-slot`, `.baby-grok-bot-side-pane`, chat `<header class="z-[3]">` |
| 4 | `.baby-grok-bot-compose-header` |
| 5 | `.baby-grok-bot-compose-popover` |
| 6 | `.baby-grok-bot-traffic-lights` |
| 20 | `.baby-grok-bot-screen-layer` (Computer overlay + scrim) |
| 30 | `.baby-grok-bot-mention-popover` |
| 50 | cursor-presence layer (`pointer-events-none absolute inset-0 z-50`, holds the "You" cursor ghost) |

Two things worth stealing: (a) the chat is the **bottom** layer, not the top — chrome floats over it, so the transcript scrolls under the header pill and the composer fade; (b) the presence layer sits above even the Computer overlay, because "who is driving" must never be occluded.

### 1.4 Glass hierarchy — four recipes, deliberately different

| tier | filter | fill |
|---|---|---|
| shell substrate | `blur(80px) saturate(180%)` | `#fcfcfca6` / `#1c1c1a9e` |
| agent-title pill | `blur(28px) saturate(165%)` (dark 150%) | `elevated 78%` (dark 76%) |
| top glass | `blur(24px) saturate(120%)` | — |
| raised (composer, compose popover) | `blur(20px) saturate(160%)` | `elevated 70%` (dark 68%) |
| sidebar | **none** | tint only |

The rule is inverted from the usual: **the further "down" the layer, the heavier the blur.** The base substrate blurs 80px (it does the wallpaper-abstraction work); floating chrome blurs only 20–28px (it only needs to separate from text passing beneath). The sidebar blurs nothing.

### 1.5 Which content lives where — three fidelities of the same object

The Computer exists at three levels and the product moves between them without changing its identity:

1. **Inline card** in the transcript (`.baby-grok-bot-card` titled "Computer", `data-tone=warning` badge, then an `aspect-[16/10]` live preview) — anim-hero-05, mob-03.
2. **Side pane** (`.baby-grok-bot-side-pane`) — the persistent docked variant.
3. **Screen layer** (`.baby-grok-bot-screen-layer`) — the modal overlay, z20, scrim, 16/10 frame.

The header identity button's accessible name is literally `aria-label="Open Sales Outbound's computer"`, and the top-right toggle is `aria-label="Open computer" aria-pressed="false"` — **`aria-pressed`, i.e. a toggle, not a route.** The Computer is a *state of the current conversation*, never a destination you navigate away to.

### 1.6 The side pane (spec, from CSS)

```css
.baby-grok-bot-side-pane{ z-index:3; position:relative; overflow:hidden; min-width:0; max-width:100%; min-height:0 }
.baby-grok-bot-side-pane__inner{
  position:absolute; inset:0 0 0 auto;                       /* right-anchored, natural width */
  border-left:.5px solid var(--grok-bot-border-default);
  background: color-mix(in srgb, var(--grok-bot-current-agent-tint) 6%, transparent);
  display:flex; flex-direction:column; min-height:0;
}
```

Two mechanics:

- **Accent tint at 6%** of the *current agent's* colour. The pane is not a neutral panel; it is visibly "this bot's" panel. Same variable that colours mentions (14%), choice-selected (8% fill / 55% border) and the card-title hover underline.
- `inset:0 0 0 auto` on an absolutely-positioned inner inside an `auto` grid column is the **width-animation trick**: animate the column's width 0→N and the inner never reflows or squashes; content slides in at full size instead of being re-typeset every frame. (Same reason the roster-row entrance is a transform, not a height animation.)

---

## 2. Transitions between surfaces

### 2.1 Complete inventory — 118 rules extracted, diffed against the master plan

**Keyframes present** (24 total; app-relevant subset):

```css
@keyframes baby-grok-bot-entry-enter   {0%{opacity:0;transform:translateY(8px)scale(.97)} to{...}}
@keyframes feature-entry-pop-in        {identical}
@keyframes baby-grok-bot-pending-in    {identical}
@keyframes baby-grok-bot-pending-label-in{0%{opacity:0;transform:translateY(5px)} to{...}}
@keyframes baby-grok-bot-row-enter     {0%{opacity:0;transform:translate(-10px)} to{opacity:1;transform:translate(0)}}   ★
@keyframes baby-grok-bot-receipt-check {0%{opacity:0;transform:scale(.4)} to{...}}
@keyframes baby-grok-bot-typing-dot    {0%,55%,to{opacity:.25} 25%{opacity:.7}}
@keyframes baby-grok-bot-mount-fade    {0%{opacity:0}}
@keyframes baby-grok-bot-spin          {to{transform:rotate(360deg)}}
@keyframes baby-grok-bot-portal-agent-cursor{                                                                            ★
  0%{opacity:0;top:12%;left:34%} 8%{opacity:1} 20%{top:24%;left:52%} 36%{top:36%;left:38%}
  52%{top:48%;left:58%} 68%{top:60%;left:42%} 84%{top:72%;left:54%} to{opacity:1;top:78%;left:38%}}
@keyframes tooltip-in  {0%{opacity:0;transform:scale(.96)translateY(2px)} to{...}}                                       ★
@keyframes tooltip-out {inverse}                                                                                          ★
@keyframes context-menu-in {0%{opacity:0;transform:scale(.95)translateY(-4px)} to{...}}                                  ★
@keyframes context-menu-out{inverse}                                                                                      ★
```

**Already in the master plan** (all confirmed, values unchanged): entry-enter `.28s cubic-bezier(.2,.9,.3,1.15) both` with `[data-fresh]>… {animation-duration:.42s}`; pending `.28s` + label `.35s cubic-bezier(.2,.8,.3,1)`; receipt-check `.28s cubic-bezier(.22,1,.36,1)` from `scale(.4)`; typing dot `1.3s ease-in-out infinite` with static base opacities `.25/.45/.7`; spinner `2.4s linear infinite`; mount-fade `1s cubic-bezier(.22,1,.36,1) both`; badge/action morphs `.26s`; hover `.12s background-color`; card-title hover underline `1.5px` / `text-underline-offset:3px` / accent-coloured.

**★ NEW — not in the plan's list:**

| # | rule | value | what it choreographs |
|---|---|---|---|
| 1 | `.baby-grok-bot-agent-row--enter` | `.45s cubic-bezier(.22,1,.36,1) both` · `translate(-10px)→0` | **Roster rows enter horizontally**, transcript entries vertically. Different axis = different surface identity. Also the slowest arrival (0.45s vs 0.28/0.42s). |
| 2 | `.baby-grok-bot-portal-agent-cursor` | `2.6s cubic-bezier(.4,0,.2,1) both`, 8 waypoints in `top/left` % | Ghost cursor drifting across the Computer preview = "the agent is driving". Percentage waypoints ⇒ works at any frame size. |
| 3 | `.avatar-row__pill` | `background/box-shadow/color/**padding** var(--avatar-row-morph)=.4s ease`; `[data-open]{padding-left:calc(pad + chip*.5)}`; siblings `margin-left:calc(size*-.24)` | Multi-agent facepile morph (§3.2). Animating **padding** is what makes the pill grow out of the avatar. |
| 4 | `.remote-desktop-dock-item` | `transform .18s cubic-bezier(.22,1,.36,1), filter .18s`; `@media(hover:hover)` hover `translateY(-1.5px) scale(1.1)`, active `translateY(-.5px) scale(.96)` | macOS-dock magnification inside the Computer frame — the embedded OS behaves like an OS. |
| 5 | `.remote-desktop-dock-app-icon` | `filter .18s, opacity .18s`; `:not([data-visible])` → `saturate(.72) brightness(.86) opacity .68` | Non-foreground apps desaturate rather than disappear. |
| 6 | `.feature-swap>*` | `grid-area:1/1; transition:opacity .26s` | **Same-cell crossfade swap.** Two badges stacked in one grid cell, one `data-hidden`; state changes crossfade in place with zero layout shift. This is how `● You're in control` ↔ `⟳ Working` swaps. |
| 7 | `.feature-take` / `[data-dimmed]` | in `.52s cubic-bezier(.22,1,.36,1)` / out `.3s cubic-bezier(.4,0,.6,1)` | **Asymmetric enter/exit** — the screen handover fades in slowly, dims out fast. |
| 8 | `.grok-bot-mark__head`,`__eye` | `transition: fill .6s` | The mascot recolours over 600 ms — the slowest transition in the product. Theme flips and identity changes are felt as a slow tint, not a snap. |
| 9 | Base-UI popovers | `[data-starting-style]→tooltip-in 150ms ease-out`; `[data-ending-style]→tooltip-out 100ms ease-in`; context menus `scale(.95) translateY(-4px)` | Exit is always faster than entry (100 vs 150 ms). |
| 10 | `.baby-grok-bot-screen-close` | `.12s background-color`, `#00000080 → #000000ad`, `backdrop-filter:blur(8px)` | Overlay dismiss affordance, 26px, `top:10 right:10`. |
| 11 | `.baby-grok-bot-screen-banner__done` | `.12s opacity`, hover `.86` | "I'm done, continue" pill. |
| 12 | `.baby-grok-bot-choice-option` | `.12s background-color, border-color`; `[data-selected]` accent border 55% + accent fill 8% | Choice cards. |
| 13 | `.baby-grok-bot-choice-confirm` | `.12s opacity`; `:disabled{opacity:.4}`; hover `.88` | Confirm gating. |
| 14 | `.baby-grok-bot-compose-result` | `.12s background-color`; `[data-highlighted]{background:var(--grok-bot-bg-active)}` | Palette row highlight driven by a **data attribute** ⇒ keyboard and mouse highlight identically. |
| 15 | `.baby-grok-bot-window-action`, `.baby-grok-bot-system-agent` | `.12s background-color, **color**` | Chrome buttons and inline agent chips animate colour too, not just fill. |
| 16 | `.feature-recording__screen:after` | `transition: box-shadow .4s`; `inset 0 0 0 2px text@14%` + `inset 0 0 40px transparent` | The **recording/attention ring** on a screen surface — a 400 ms inset glow, not a border swap. |
| 17 | `.ios-glass` | `transition: background .16s, border-color .16s` | Mobile glass controls. |
| 18 | `.baby-grok-bot-sidebar-list[data-fade-top]/[data-fade-bottom]` | `mask-image: linear-gradient(...)`, `--baby-grok-bot-list-fade: 36px` | Scroll-edge fades toggled by data attributes; both can be on with a 4-stop mask. |
| 19 | `@container (max-width:160px){.baby-grok-bot-agent-row__time{display:none}}` | — | Container-query progressive disclosure inside the roster row. |
| 20 | `[data-demo-offscreen] *,:before,:after{animation-play-state:paused!important}` | — | Offscreen surfaces have animations **paused**, not removed. |
| 21 | reduced-motion twins | 8 separate `@media (prefers-reduced-motion:reduce)` blocks | Every animated component has a colocated kill. Typing dots keep their static staggered opacities `.25/.45/.7` so the row still *reads* as three dots. |

Notably absent: **no `view-transition-name` anywhere**, no FLIP libraries in CSS. All cross-surface continuity comes from *not unmounting* things (§3) plus opacity/transform.

### 2.2 Opening a bot from the roster

Nothing "navigates". Evidence chain:

- The roster row is a `<button data-active>` inside a persistent `<aside>`; selection is `.baby-grok-bot-agent-row[data-active]{background:var(--grok-bot-sidebar-selected)}` (5.5% light / 7.5% dark wash), animated by the row's own `transition:background-color .12s`.
- The shell root carries the per-agent theme as **inline custom properties**:
  ```html
  <div class="baby-grok-bot" data-theme="cursor-light"
       style="--grok-bot-current-agent-tint:light-dark(var(--color-brand-yellow-350),var(--color-brand-yellow-450));
              --grok-bot-current-agent-bubble:…; --grok-bot-current-agent-bubble-ink:#FFFFFF;
              --grok-bot-current-agent-accent:…; --grok-bot-current-agent-coat:#F19D38;">
  ```
  Switching bots is **one variable write on the root**. Everything downstream recolours simultaneously and for free: side-pane tint (6%), mention chips (14%), `[data-tone=accent]` badges (14%), choice-selected (8%/55%), card-title hover underline, the pending avatar's coat (`--fg: var(--grok-bot-current-agent-coat)`).
- The chat column, header and composer are never remounted. The header identity crossfades inside a fixed 44px slot: `<div class="relative shrink-0" style="height:var(--grok-bot-toolbar-height)"><div class="absolute inset-x-0 top-0" style="opacity:1">…` — an absolutely-positioned layer inside a fixed-height box, so header content can fade/swap while the row height is guaranteed constant. Zero layout shift.
- Transcript entries mount with `.baby-grok-bot-entry-enter` only when the container carries `[data-fresh]` (0.42s); a seeded backlog animates at 0.28s or not at all, plus one `.baby-grok-bot-mount-fade` (`1s cubic-bezier(.22,1,.36,1) both`) for the container.

### 2.3 Opening the Computer overlay — full choreography

```css
.baby-grok-bot-screen-layer{ position:absolute; inset:0; z-index:20;
  display:flex; align-items:center; justify-content:center; container-type:size }
.baby-grok-bot-screen-scrim{ position:absolute; inset:0; background:#00000061; cursor:default }
.baby-grok-bot-screen-frame{ aspect-ratio:16/10;
  height: min(100cqh - 72px, 62.5cqw - 45px, 512px); position:relative; overflow:hidden }
.baby-grok-bot-screen-shell{ position:relative; display:flex; padding:12px; padding-top:50px }
.baby-grok-bot-screen-shell .baby-grok-bot-screen-frame{ z-index:1;
  height: min(100cqh - 118px, 62.5cqw - 50px, 494px) }
.baby-grok-bot-screen-shell__surface{ position:absolute; inset:0; background:var(--grok-bot-bg-elevated);
  border-radius:22px; box-shadow:0 20px 52px -16px #00000059 }
.baby-grok-bot-screen-banner{ position:absolute; top:12px; left:12px; right:12px; height:32px; z-index:1;
  border-radius:12px; padding:0 4px 0 12px; display:flex; align-items:center; gap:12px;
  background: color-mix(in srgb, var(--grok-bot-text-warning) 13%, var(--grok-bot-bg-elevated)) }
```

Mechanics that matter:

- **`position:absolute; inset:0` — scoped to the shell, not portalled to `<body>`.** In `anim-hero-03.png` the sidebar, traffic lights and header stay visible and in place under the 38%-black scrim. You never lose your place; the app frame is still there around the overlay. This is the single biggest difference from a conventional full-screen route.
- **`container-type:size` + `cqh/cqw` sizing.** `62.5cqw` is exactly `10/16` — the frame's height is clamped by the container's *width* through the aspect ratio, by its height, and by an absolute 512px ceiling, all in one `min()`. No JS measuring, no ResizeObserver, correct at any window size and inside the side pane.
- **Scrim is a real element with `cursor:default`** → click-outside-to-dismiss, and the cursor doesn't lie about what's clickable.
- **Two nested variants**: bare `screen-frame` (inline in the transcript card at 16/10) and `screen-shell` (the overlay: adds a 22px elevated surface, `padding-top:50px` = 12px inset + 32px banner + 6px gap, and a `0 20px 52px -16px` shadow). Identical content, two chrome levels.
- **Take-back-control banner**: warning-tinted (13% warning mixed into elevated — not a saturated alert), with an emphasis-filled `I'm done, continue` pill at the right. The badge on the inline card crossfades between `● You're in control` and `⟳ Working` **in the same grid cell** (`.feature-swap>*{grid-area:1/1;transition:opacity .26s}`) — control handover is a 260 ms in-place morph.
- **Presence layer above everything** (`z-50`): a cursor glyph + a `bg-black/50 px-2 py-0.5 text-[10px] rounded-full` label reading `You`. In agent-driven mode the same slot runs `.baby-grok-bot-portal-agent-cursor` (2.6 s, 8 waypoints) in the agent's colour.
- The Teach-a-task variant reuses the *same banner geometry* with a neutral label and an `×` (`clean-stage1-*.png`: "Weekly Reporting is watching and learning"), plus a `◉ Teach a task` pill (`.feature-recording__teach`, `transition:transform .12s, background .12s`) and the 400 ms inset attention ring.
- Exit: `.feature-take[data-dimmed]{opacity:0; transition:opacity .3s cubic-bezier(.4,0,.6,1)}` against entry `.52s cubic-bezier(.22,1,.36,1)` — **entry 520 ms, exit 300 ms**, matching the popovers' 150/100 asymmetry.

### 2.4 Entering/exiting settings

No settings *screen transition* exists in the captured DOM, and that is itself the finding. The docs place settings in a separate app section (`Settings → General → Auto-review`, `Settings → Plugins`, `Settings → Beta`) — never replacing the conversation. Per-bot configuration is reached *from the conversation*: "Open the Bot, choose **View conversation details**, then open **Routines**". IA rule: **global preferences leave the conversation; per-bot configuration is a pane hanging off the conversation.**

### 2.5 Mobile screen-to-screen navigation

Evidence: `mobel-mobilephonescreen.png` (iOS app), `mob-00.png` (replica at 390px), `mob-03.png`.

- **iOS conversation**: the transcript is full-bleed and scrolls *under* three floating controls — a `<` back chevron in a glass circle (left), the **header pill** (accent avatar + name, rounded-full, glass), and a Computer button in a glass circle (right). In the screenshot the transcript text is visibly clipped behind the pill, proving there is no opaque nav bar. Mobile chrome is **the same three affordances as desktop** — back-chevron *is* the sidebar, pill *is* the header identity, monitor *is* the computer toggle. Nothing invented, nothing dropped.
- **Composer on mobile**: `+` in its own circle *outside* the field, then a rounded-full field with the mic inside on the right. Desktop packs the same three elements *inside* one pill. Same parts, different packing.
- **Roster → conversation at narrow widths does not swap screens** — the sidebar collapses to an avatar rail (`.baby-grok-bot-sidebar[data-collapsed]`: rows centred at `padding:6px`, `__body`/`__unread` `display:none`, footer stacks vertically, scrollbar 6px→3px, list `padding-inline:6px`) and the chat stays. Collapse is **one data attribute**, all CSS, no JS layout branch.
- The roster row degrades further by **container** query, not media query: `@container (max-width:160px){.baby-grok-bot-agent-row__time{display:none}}` on `.baby-grok-bot-agent-row__body{container-type:inline-size}`. The row adapts to its pane, not the viewport — correct in a resizable sidebar.
- Cross-device continuity is a stated product promise: "message a Bot from your phone or desktop … and **pick up the same thread later on either surface**". The Japanese hands-on review confirms the mobile app is deliberately reduced (send requests, watch whether bots are running, tap the screen if needed; detailed config stays on desktop).
- Back gestures: no CSS evidence (native iOS). The desktop overlay's "back" is scrim-click + the 26px close button; the shell never pushes history.

---

## 3. Continuity devices

### 3.1 Things that never unmount

| element | persists across |
|---|---|
| `<aside class="baby-grok-bot-sidebar">` | every bot switch, every Computer open (dimmed under the scrim, still legible) |
| chat header pill (avatar + name, in a fixed 44px slot with an absolutely-positioned crossfading inner) | bot switch, computer toggle |
| composer (`.baby-grok-bot-composer`, placeholder `Message <bot>`) | everything except the overlay |
| sidebar footer identity (28px `AS` initials chip + "Armand Segall") | everything — the human is always on screen |
| traffic lights (z6, `pointer-events:none`) | everything including the overlay |
| presence layer (z50) | everything, by construction |

### 3.2 The avatar-row: a facepile that morphs to name the actor

```css
.avatar-row{ --avatar-row-pad:calc(var(--avatar-row-size)*.16);
             --avatar-row-chip:calc(var(--avatar-row-size) - 2*var(--avatar-row-pad));
             --avatar-row-overlap:.24; --avatar-row-morph:.4s; isolation:isolate; display:flex }
.avatar-row__pill{ height:var(--avatar-row-size); padding:var(--avatar-row-pad); border-radius:9999px;
  transition: background .4s ease, box-shadow .4s ease, color .4s ease, padding .4s ease }
.avatar-row__pill[data-open]{ padding-left: calc(var(--avatar-row-pad) + var(--avatar-row-chip)*.5) }
.avatar-row__pill + .avatar-row__pill{ margin-left: calc(var(--avatar-row-size)*var(--avatar-row-overlap)*-1) }
.avatar-row__spread{ overflow:hidden }   /* label reveal */
```

Measured: open pill `175×32` with `padding:5.12px 5.12px 5.12px 16px`; closed pills `32×32` overlapping `-7.68px`; each pill carries its *own* agent-hue background + `inset 0 0 0 1px` ring (`rgb(242,254,255)` teal, `rgb(250,250,254)` purple, `rgb(255,249,251)` pink, `rgb(255,252,243)` amber).

In `clean-stage3-*.png` the open pill's chip slot holds **three typing dots in the agent's colour** and the label reads `Asking Research…`. One component answers three questions — who is here, who is acting now, what they're doing — and re-answers them with a 400 ms padding/colour morph instead of a re-render.

### 3.3 The roster row mirrors the transcript tail, live

```html
<button class="baby-grok-bot-agent-row" data-active title="Sales Outbound">
  <span class="baby-grok-bot-agent-row__avatar">…32px mark, --fg:#F19D38…</span>
  <div class="baby-grok-bot-agent-row__body" style="container-type:inline-size">
    <div class="flex items-center justify-between gap-2">
      <span class="truncate text-[14px] leading-5 tracking-[-0.15px]">Sales Outbound</span>
      <span class="baby-grok-bot-agent-row__time text-[12px] leading-4">1:45 PM</span></div>
    <div class="mt-px flex h-4 items-center gap-1.5">
      <span class="truncate text-[12px] leading-4">Typing…</span></div>
  </div>
</button>
```

Row = 254×53, avatar 32, `border-radius:10px`, `padding:8px`, `gap:8px`. The preview line is the **actual last transcript line, lowercased in the bot's voice** ("booked the venue and sent the confirmation around.", "sent. inbox at zero, 5 drafts parked for tomorrow."), and for the working bot it is replaced by live status in the **same slot, same 12/16 type, no badge** — `Typing…` in the DOM capture, `Checking what's connected. H…` in anim-hero-05 (byte-identical to the newest assistant bubble at that instant), `Done.` in crop-hero-app (identical to the final bubble). **The roster preview is the same string as the transcript tail, not a summary.**

Mount animation is `.baby-grok-bot-agent-row--enter` (0.45 s, `translate(-10px)`), so a newly-relevant bot slides in from the sidebar's own edge.

### 3.4 Timestamps tick

Across the timed capture set the roster times advance in lockstep while nothing else changes: `crop-hero-app` 1:42/10:41/8:41/5:41/9:41/7:41 → `anim-hero-05` 1:47/10:47/8:47/5:47/9:47/7:47 → `dark-hero-03` 1:51/10:51/8:51/5:51/9:51/7:51. Absolute clock times, recomputed on an interval, in a row whose timestamp is *itself* conditionally rendered by a container query.

### 3.5 Identity carried into prose

- `.baby-grok-bot-message-mention__face{height:1lh; margin-right:4px; display:inline-flex; vertical-align:top}` — a mention inside a message renders the bot's **face inline**, sized to one line-height so it never disturbs leading.
- `.baby-grok-bot-system-agent{margin:-1px -5px -1px -3px; padding:1px 5px 1px 3px; border-radius:999px; transition:background-color .12s,color .12s}` — an agent reference inside a *system* line is a `<button>` with hover fill (`--grok-bot-system-agent-pill/-ink`). Negative margins exactly cancel the padding so the pill costs zero layout. "Updated memory for ●Account Manager", "Messages from ●Account Manager and ●Chief" — every cross-bot event in the transcript is a **navigable link back to that bot**.
- `.baby-grok-bot-mention` in the composer: `background: color-mix(in srgb, var(--grok-bot-current-agent-accent) 14%, transparent); color: accent; border-radius:5px; padding:0 3px; font-weight:500`.

### 3.6 Group identity

The "Offsite crew" row renders three 18px marks at `left:7/top:0`, `left:0/top:14`, `left:14/top:14`, z1/2/3, each with `box-shadow: 0 0 0 2px var(--cursor-bg-elevated)` — a triangular facepile inside the same 32px slot a single avatar occupies. A group and a bot are the same row shape.

---

## 4. Settings / preferences IA

Three-tier scope model, explicit in the docs:

| scope | lives in | contents |
|---|---|---|
| **Account / global** | `Settings → General` | Agent → *Execution on Local Computer* (Always require approval / Always allowed / Never allowed; default **Ask every time**). `Settings → Plugins` (connectors + packaged skills, "**Yours**" tab) — *"Installed connectors are account-wide. Their availability is not isolated to one Bot."* `Settings → Beta` (Check for Updates; Update / Recover / Reset Agent Computer). Notifications, time zone, usage. |
| **Per-desktop** | `Settings → General → Auto-review` | *"Personal Auto-review rules are stored on the current desktop and synced to its Grok Bot computer. Verify them separately on another desktop installation."* — an honest, surfaced sync boundary instead of a fake-global setting. |
| **Per-bot** | from the conversation: *View conversation details → Routines* | Enable/pause, Test run, edit schedule/instructions, run history (20 most recent per routine, 50 routines per bot), delete (immediate, no undo). Private skills are **enabled per bot** under `Settings → Plugins → Yours`. |
| **Team / org** | Cursor dashboard → Grok Bot | team rules scoped to Cursor / Grok Bot / both, MCP allowlist, Cloud Agents toggle, member computers (Kill); coming: local-execution ceiling where members may go stricter but not looser. |

Rule lifecycle after creation (`Always allow`):
- Created **inline** in the approval card in the conversation (`Allow once` / `Deny` / `Always allow` on desktop; `Approve once` / `Deny` on iPhone — deliberately fewer options on mobile).
- Managed afterwards in `Settings → General → Auto-review` as two rule classes: **Require Approval** (always stops) and **Always Allow** (proceeds *only if* automated review finds no other reason to stop). **Conflict resolution is stated in the product docs: Require Approval wins.**
- Guidance is narrow-scope by example: "Always allow running `git status` in `/workspace/reports`", explicitly not "allow everything in the browser".

Notable IA decision: **there is no model picker at all**, "for members or admins", confirmed absent in the hands-on review's UI. A whole settings category was deleted rather than defaulted.

---

## 5. Onboarding — what concretely makes it good

1. **Progressive disclosure with a background task.** First run "introduces Bots, the shared computer, and routines, then asks which tools you use. These answers shape the first teammate suggestions; **they do not connect or modify those tools by themselves**. Computer setup runs in the background and the final step opens *Meet a future teammate*." Expensive provisioning is hidden behind the introduction, and the questionnaire is explicitly declared non-destructive — which removes the "what am I authorising?" hesitation.
2. **The last step is a choice between a suggestion and a blank**: pre-shaped teammates, or "Create your own" with exactly **three fields** — short name, one primary job, a description of how it should work.
3. **A five-minute first result that needs no connector and no login** is scripted (attach a document → "Summarize this in five bullets… Do not change the source file"). First success is decoupled from every integration risk.
4. **A named request template** teaches the mental model without a tutorial: Outcome / Sources / Constraints / Deliverable / Review point.
5. **Character selection at creation** — hands-on review: "Create Bot ではキャラクターの見た目を選べます". The identity you pick is then the accent that colours the entire app while that bot is focused (§2.2). Personalisation is load-bearing, not cosmetic.
6. **An escalation ladder repeated in every doc**: one-time task → correct it → save as skill → test on a second input → only then a routine. Nothing complex is reachable before something simple has worked.
7. **The claim is zero onboarding**: *"There wasn't anything to learn. It was just like bringing on a coworker. No automations to set up, no product quirks, no intricate naming."* The app is shaped like a messaging app so prior knowledge transfers wholesale — roster, unread previews, timestamps, composer, `@`-mentions, group chats.

---

## 6. Empty / loading / error surfaces

- **Loading (turn-level)**: `.baby-grok-bot-pending` — a 40px avatar in the current agent's *coat* colour (`--fg: var(--grok-bot-current-agent-coat)`) whose SVG carries `data-state="thinking"`, plus a 13px tertiary label on its own softer curve (two-stage stagger 0.28 s row / 0.35 s label). In the roster the same state renders as `Typing…` in the preview slot.
- **Loading (tool-level)**: `.baby-grok-bot-spinner{animation:2.4s linear infinite}` — deliberately slow; reads "working", not "hung". It lives *inside* a `[data-tone=warning]` badge, so the badge itself is the progress indicator.
- **Scroll-edge affordances** (the invisible work): `.baby-grok-bot-sidebar-list[data-fade-top]/[data-fade-bottom]` 36px mask fades; `.baby-grok-bot-composer-fade` — a 48px 4-stop gradient (`elevated 92% → 62% @36% → 22% @68% → transparent`) anchored `absolute inset-x-0 bottom-full` to the composer, not the scroller.
- **Errors**: full tone token set — `--grok-bot-text-danger` `#c0362c`/`#ff6b5e`, `-warning` `#b26a00`/`#e8a33d`, `-success` `#1f8a65`/`#4cc79b`, `-accent` `#0a84ff`/`#64b5ff` — consumed only as `color-mix(… 14%, transparent)` fills with full-strength text via `.baby-grok-bot-card-badge[data-tone=…]`. A failure and a success differ by one attribute value, never by a different component.
- **Recovery is deliberately duplicated, contextual + canonical**: *"When the computer is unreachable, use **Recover computer** from the error state"* (inline in the conversation) **and** `Settings → Beta` with three graded actions labelled by consequence: **Update** (rebuild latest image, preserve durable state) → **Recover** (replace unreachable computer, preserve durable state when offered) → **Reset** (return to last durable snapshot, *can discard recent unsaved work*). Docs add ordering guidance ("wait for active work to finish"; "see Troubleshooting for the least-destructive order"). Admin side adds **Kill** (delete the VM; durable storage kept; next session recreates).
- **Blocked states are explained, not just disabled**: a plugin blocked by team policy shows "Disabled by team admin", and sign-in attempts to that server are refused *with the same message*.
- **Idle policy**: "Grok Bot may ask whether to keep routines running after a long period away and pause them if there is no response. Review paused routines when you return." — a resource-safety state with a re-entry surface.

---

## 7. Keyboard & command surfaces

```css
.baby-grok-bot-compose-header{ z-index:4; height:var(--grok-bot-toolbar-height);
  border-bottom:.5px solid var(--grok-bot-border-default); padding:0 12px; display:flex; gap:8px }
.baby-grok-bot-compose-popover{ z-index:5; position:absolute; top:calc(100% + 6px); left:10px; right:10px;
  border:.5px solid var(--grok-bot-border-default); border-radius:12px;
  background:var(--grok-bot-raised-fill); backdrop-filter:blur(20px) saturate(160%);
  box-shadow:0 1px 2px #0000000f, 0 14px 36px -10px #00000047; overflow:hidden }
.baby-grok-bot-compose-results{ max-height:min(280px,46vh); padding:6px; overflow-y:auto;
  overscroll-behavior:contain; scrollbar-width:thin }
.baby-grok-bot-compose-result{ width:100%; padding:7px 8px; gap:10px; border-radius:8px;
  transition:background-color .12s }
.baby-grok-bot-compose-result[data-highlighted]{ background:var(--grok-bot-bg-active) }
.baby-grok-bot-mention-popover{ z-index:30; position:absolute; bottom:calc(100% + 10px); left:-6px;
  min-width:190px; max-width:280px; border-radius:10px; background:var(--cursor-bg-elevated);
  box-shadow:0 1px 2px #0000000f, 0 14px 36px -10px #00000047 }
.baby-grok-bot-mention-popover .baby-grok-bot-compose-result{ padding:4px 6px; gap:7px; border-radius:6px }
```

Three findings:

1. **One picker component, two anchors.** The `compose-popover` drops *below* a search header (`top:calc(100% + 6px)`, insets `left/right:10px` so it aligns to the field's optical edges); the `mention-popover` rises *above* the composer (`bottom:calc(100% + 10px)`, `left:-6px` anchored to the `@` token). Both reuse `.baby-grok-bot-compose-results/-result`, the mention variant only overriding padding and radius (6px rows in a 10px container vs 8px rows in a 12px container — **nested radii step down, never match**).
2. **Highlight is `[data-highlighted]`, not `:hover`.** Keyboard and pointer produce the identical visual state, so arrow-key navigation and mouse hover cannot disagree.
3. **`max-height: min(280px, 46vh)` + `overscroll-behavior:contain`** — the palette never eats the viewport and never scroll-chains into the transcript behind it.

Documented tokens: `@` = bots, groups, routines, connectors; `/` = saved skills. The composer is a `contenteditable` `role=textbox aria-multiline=true` with `data-empty` + `data-placeholder` (CSS `:before` placeholder), `min-height:20px`, `max-height:120px`, `overflow-wrap:anywhere`. No other shortcuts are documented — the surface is mouse-and-mentions first, consistent with the "messaging app" framing.

---

## 8. What reviewers say coheres, and where it breaks

**Coheres**
- *"There's a cohesion that's palpable"* — HN, on agent-to-agent comms being first-class rather than bolted on.
- *"Grok Bot simplifies the setup for this about as far as I imagine is possible, and frankly it's a pretty slick experience"* — HN, from someone who had hand-built the same thing with Telegram bots.
- *"Right now Grok Bot looks a lot easier to get started and maintain with a simpler UI (arguably better)"* than OpenClaw/Hermes — HN.
- *"I think the humanization of the agents is cute and makes sense UX wise"* — HN. The mascot/accent identity is read as a usability device; the Japanese review notes the "cuteness" is obvious on sight and that you pick the character at creation.
- *"There wasn't anything to learn… you're just chatting with a friend"* / *"like I have eight arms like an octopus, with every arm in concert"* — vendor quotes, but they name the mechanism: familiarity transfer and parallelism made legible.
- Hands-on: the cloud computer "操作感は軽め" (feels light) despite being remote — the inline-preview → overlay progression hides latency well.

**Breaks**
- **Sameness.** *"Interesting how everyone seems to be following OpenAI on UX. When I used Antigravity and they suddenly switched to Codex type UI I was very annoyed because I kept checking if this is Codex or Antigravity."* The chat-first agent shell is now generic; differentiation must come from what the *content* primitives are (this is exactly the plan's §5.6 argument).
- **Platform inconsistency at the seams.** *"GitHub login on iOS is just broken. GitHub gives 404 after logging in"*; the Linux download is offered on the site but the product isn't on Linux — *"This is super confusing"*. Both are failures *between* surfaces (web→app, site→product), not inside any screen.
- **The mobile app is admittedly partial** ("割り切った作り"), and iPhone approval controls are a strict subset (`Approve once`/`Deny`, no `Always allow`) — a rule creatable on desktop cannot be created on phone.
- **Cost blindness.** *"I've used more tokens this month than [in the last 5 years]"*, *"48% weekly usage left after 3 hours"*, and the docs confirm no Grok Bot spend cap. No usage surface exists inside the app.
- **The shared-computer model contradicts the per-bot identity the UI works so hard to build**: one computer, every login, and docs say outright not to treat separate Bots as a security boundary — yet nothing in the UI signals that.
- **Approvals are prose, not policy** (eesel) — Auto-review rules are model-evaluated natural language, so the beautifully-integrated approval card is backed by a soft guarantee.
- **Missing surface**: no human-to-human collaboration — *"it does so in a group chat app… I assumed it was like Buzz, allowing you to invite other humans"*. The group-chat shell sets an expectation the product doesn't meet.

---

## 9. Integration devices to adopt — ranked by impact

Ranking = (how much "one app" feeling it buys) × (how cheap it is in this repo). Each is a mechanic, not a principle.

### 1. Per-session accent as root custom properties, written once on the shell
**Mechanic.** On the app shell element set `--sm-session-tint`, `--sm-session-accent`, `--sm-session-ink`, `--sm-session-coat` from the existing 8-hue name-hash (plan §5.1 rule 2). Consumers read the variable, never the hash: side rail `color-mix(in srgb, var(--sm-session-tint) 6%, transparent)`; mention chip `color-mix(… accent 14%, transparent)` + accent text; choice-selected `border-color: color-mix(… accent 55%, transparent); background: color-mix(… accent 8%, var(--card))`; card-title hover underline `1.5px` / `text-underline-offset:3px` / `text-decoration-color: var(--sm-session-accent)`; thinking avatar `--fg: coat`.
**Why first.** Switching sessions becomes a single variable write; five surfaces recolour in lockstep with zero prop-drilling and zero re-render. It is the mechanism behind most devices below.
**Evidence.** Inline style on `.baby-grok-bot`; `--grok-bot-current-agent-{tint,bubble,bubble-ink,accent,coat}`.
**Repo note.** Keep the plan's surface-disjointness rule; just add *side pane at 6%* to the allowed accent surfaces.

### 2. One glass substrate, tinted columns — never a second blur
**Mechanic.** `#app-shell{background:var(--sm-substrate); backdrop-filter:blur(80px) saturate(180%)}`; sidebar `background:var(--sm-sidebar-tint)` (≈30% alpha of the chrome colour) with `backdrop-filter:none`; focus column `background: color-mix(in srgb, var(--card) 86%, transparent)` (dark 84%); separators are 0.5px absolute `:after` strips, never `border`. Floating chrome gets a *lighter* blur than the substrate: header pill `blur(28px) saturate(165%)` on `color-mix(var(--card) 78%, transparent)`; composer/popovers `blur(20px) saturate(160%)` on `color-mix(var(--card) 70%, transparent)`.
**Why.** This is what makes overview / focus / side rail read as regions rather than pages, and it avoids the muddy, expensive stacked-blur failure.
**Repo note.** Honour the plan's dark-theme correction — substrate on `--card` (#1c1c1e), not `--background`; gate `backdrop-filter` behind the existing hairline/DPR utility.

### 3. 3-column CSS grid + right-anchored absolute inner for the side pane
**Mechanic.** `grid-template-columns: minmax(0,auto) minmax(0,1fr) minmax(0,auto)`. The side-pane column animates `width: 0 → N`; its child is `position:absolute; inset:0 0 0 auto` so it keeps its natural width and never re-typesets during the transition. Same trick for the left rail.
**Why.** Panes open and close without reflowing the transcript — the #1 source of "this feels like a different app".

### 4. Overlay scoped to the shell, sized by container queries
**Mechanic.**
```css
.sm-screen-layer{ position:absolute; inset:0; z-index:20; display:flex; place-items:center; container-type:size }
.sm-screen-scrim{ position:absolute; inset:0; background:#00000061; cursor:default }   /* click to dismiss */
.sm-screen-frame{ aspect-ratio:16/10; height:min(100cqh - 72px, 62.5cqw - 45px, 512px) }
.sm-screen-shell{ padding:12px; padding-top:50px }
.sm-screen-shell__surface{ position:absolute; inset:0; border-radius:22px; background:var(--card);
  box-shadow:0 20px 52px -16px #00000059 }
.sm-screen-close{ position:absolute; top:10px; right:10px; width:26px; height:26px; border-radius:999px;
  background:#00000080; backdrop-filter:blur(8px); color:#fff; transition:background-color .12s }
```
Enter 520 ms `cubic-bezier(.22,1,.36,1)`; exit 300 ms `cubic-bezier(.4,0,.6,1)`.
**supermux mapping.** Full-screen terminal, the Attention-card peek, diff viewer, file viewer. Because the overlay lives inside the shell, the session rail and header stay visible and dimmed — you never lose the roster.

### 5. Roster row = literal transcript tail + live status in the same slot
**Mechanic.** Row 53px: 32px avatar · `gap:8` · body `container-type:inline-size` with [name 14/20 `-0.15px` · time 12/16 tertiary] over [preview 12/16 secondary, `truncate`]. The preview slot renders `chat_tail` verbatim when idle and the live activity label (`Reading src/…`) when active — **same slot, same type, no badge**. `@container (max-width:160px){.row__time{display:none}}`. Tile entrance `translate(-10px)→0`, `.45s cubic-bezier(.22,1,.36,1)` — horizontal, so the overview reads differently from the transcript's vertical pops.
**Why.** Gives the plan's `chat_tail` (§2.5) a proven shape and removes the need for a separate status line.

### 6. Same-cell crossfade for every in-place state change
**Mechanic.** `.sm-swap{display:grid} .sm-swap>*{grid-area:1/1; transition:opacity .26s}` + `[data-hidden]`.
**Use for.** Working ↔ Waiting ↔ Done badges, mode-chip changes, the `Chat | Terminal` label, context%/cost swaps, "You're in control" ↔ "Agent working". Zero layout shift, one duration (260 ms) already in the plan.

### 7. Fixed-height chrome slot with an absolutely-positioned crossfading inner
**Mechanic.** `<div class="relative shrink-0" style="height:var(--sm-toolbar-h)"><div class="absolute inset-x-0 top-0">…header…</div></div>`, with `--sm-toolbar-h: 44px` shared by the rail header and the focus header so the two columns' first rows align.
**Why.** Session switches and renderer toggles crossfade header contents with mathematically guaranteed zero layout shift — cheaper and more robust than the plan's `view-transition-name` on the pill (Grok ships **no** view transitions at all).

### 8. Clickable identity chips inside system lines
**Mechanic.** `.sm-system-agent{display:inline-flex; align-items:center; gap:4px; border-radius:999px; margin:-1px -5px -1px -3px; padding:1px 5px 1px 3px; transition:background-color .12s, color .12s}` with a hover fill; inline avatar `.sm-mention__face{height:1lh; margin-right:4px; vertical-align:top}`.
**Use for.** `Delegated from ●research`, `PR opened #47`, `Subagent ●explore finished`, `Host ●strato`. Negative margins cancel the padding so the pill costs zero layout in flowing text; every cross-session event in the transcript becomes a navigation affordance.

### 9. Presence facepile that morphs to name the actor
**Mechanic.** `--row-size:32px; --pad:calc(size*.16); --chip:calc(size - 2*pad); --overlap:.24; --morph:.4s`. Pills `border-radius:9999px`, siblings `margin-left:calc(size*-.24)`, each with its own hue fill + `inset 0 0 0 1px` ring. `[data-open]{padding-left:calc(pad + chip*.5)}` reveals a label inside an `overflow:hidden` spread; transition `background/box-shadow/color/padding .4s ease`. The open chip slot holds the 3-dot typing cluster while working, the avatar otherwise.
**Use for.** The overview header ("3 sessions active" collapsed to a facepile; the one that just changed state morphs open with its name for a few seconds) and the subagent group card (plan P4).

### 10. Sidebar collapse as one data attribute
**Mechanic.** `[data-collapsed]` on the rail → rows `justify-content:center; padding:6px`; `__body`/`__unread` `display:none`; footer `flex-direction:column; gap:6px; padding-inline:0`; list `padding-inline:6px`; scrollbar 6px→3px. Plus a 12px `role="separator" aria-orientation="vertical" aria-label="Resize sidebar"` drag strip at `inset-y-0 -right-1.5`.
**Why.** Narrow/mobile is a *collapse*, not a screen swap — zero JS layout branching.

### 11. Mask-gradient scroll-edge fades toggled by data attributes
**Mechanic.** `--fade:36px`; `[data-fade-top]`, `[data-fade-bottom]` and the combined 4-stop mask on any scroller; plus a composer fade `absolute inset-x-0 bottom-full h-12` with stops `card 92% → 62% @36% → 22% @68% → transparent`.
**Why.** Scroll affordance without a shadow, correct on glass; half-specced already in plan §5.2.

### 12. One picker component, two anchors, `[data-highlighted]` selection
**Mechanic.** Rows `padding:7px 8px; gap:10px; radius:8px; transition:background-color .12s`; `[data-highlighted]{background:var(--sm-bg-active)}` set by both keyboard and pointer. Container `max-height:min(280px,46vh); overscroll-behavior:contain; padding:6px; radius:12px`, raised glass, shadow `0 1px 2px #0000000f, 0 14px 36px -10px #00000047`. Anchor down (`top:calc(100% + 6px); left:10px; right:10px`) for a command/search field; anchor up (`bottom:calc(100% + 10px); left:-6px`, `min-width:190px; max-width:280px`, rows `4px 6px` radius 6) for the `@`/`/` token popover. **Nested radii step down; they never match.**
**Use for.** The plan's `@`-files and `/`-commands popovers (§3) and any future ⌘K.

### 13. Graded, consequence-labelled recovery — inline *and* canonical
**Mechanic.** The same action set offered twice: an inline "Recover" affordance in the error state, and a canonical list in settings ordered least→most destructive, each labelled by what it preserves — *Restart (keeps scrollback)* → *Recover (replaces the pty holder, keeps the transcript)* → *Reset (returns to last snapshot, discards unsaved work)*. Blocked things state *why* and refuse with the same sentence they display.
**supermux mapping.** Native-runtime holder recovery, stuck-pty recovery, session reset. The plan's Attention card is the inline half; the settings half is missing.

### 14. Reduced-motion twins, colocated, with static fallbacks that still read
**Mechanic.** Every animated component ships an adjacent `@media (prefers-reduced-motion:reduce)` block that sets `animation:none` **and** restores the informative static state (Grok keeps the typing dots' `.25/.45/.7` opacity stagger so the row still looks like three dots). Plus `[data-offscreen] *{animation-play-state:paused!important}` for tiles scrolled out of view.
**Why.** The plan already carves out functional spinners; the pause-offscreen rule is new and directly relevant to an overview grid of 20 animated tiles.

### 15. Three speeds, exits faster than entries, and one very slow identity transition
**Mechanic.** Adopt three durations — `.12s` (hover/press: background-color *and* colour), `.26s` (in-place morph), `.28/.42s` (arrival, `data-fresh`-gated) — plus `.45s` for roster-row arrival, `.4s` for the facepile morph, and **`.6s` for identity recolour** (`transition: fill .6s` on the avatar/monogram when accent or theme changes). Exits always faster than entries: popovers 150/100, overlays 520/300.
**Why.** A single slow transition reserved for identity is what makes a session switch feel like a place changing rather than a list re-rendering.

### 16. Three fidelities of the same object, never three components
**Mechanic.** Terminal/diff/file content renders as (a) an inline card preview at a fixed aspect ratio inside the transcript, (b) a docked side pane, (c) the shell-scoped overlay — all the *same* component with a `variant` prop that changes only chrome (bare frame → +banner / +surface / +close). Both the header identity button and a top-right toggle target it, and the toggle carries `aria-pressed`.
**Why.** It is the mechanism behind "the Computer is a state, not a place", and it maps exactly onto supermux's terminal ⇄ chat ⇄ changes-rail problem.
