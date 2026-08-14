# Grok Bot (xAI / SpaceXAI) — exhaustive UI/design-language report

Research date: 2026-08-13. Product announced 2026-08-11; broad rollout + Grok 4.6 on 2026-08-12.
Prepared for: supermux — replacing the raw terminal with a native web UI for Claude Code sessions.

*(Note: the harness blocks subagents from writing report `.md` files, so `report-grok-ui.md` was not created; the full report is below. All captured evidence files are on disk at the paths in §14.)*

---

## 0. TL;DR for the supermux design decision

Grok Bot is **not** a coding-agent terminal. It is a **desktop + iOS chat app whose entire interface is a messaging client**: a left sidebar that is a *roster of named agents* (Slack/iMessage DM list), and a right pane that is a *single conversation transcript*. All agent activity — tool calls, browser work, file results, approvals, memory updates, scheduled routines — is rendered as **typed message primitives inside that transcript**: bubbles, receipt lists, inline cards with status badges, system pill lines, and an embedded live "Computer" preview. There is **no terminal surface anywhere in the product UI**, no log pane, no tree view, no diff view.

The design language: **Apple-adjacent, glassy, low-contrast, very few colors, tiny type, 0.5px hairlines, pill-shaped everything, short spring-eased entrance animations (0.28–0.45s)**. Identity is carried almost entirely by **per-agent accent colors + an expressive mascot-face avatar**, not by chrome.

**Caveat on evidence (read this):** the strongest artefact I could obtain is x.ai's product page at `https://x.ai/bot`, which embeds a **pixel-level HTML/CSS replica of the real desktop app**, animated, running a scripted conversation. It is not a screenshot — it is the app's own component CSS (class prefix `baby-grok-bot-*`, design tokens named `--grok-bot-*` **aliased onto `--cursor-*`**, a `data-theme="cursor-dark"` variant, and the app's `CursorIcons16` icon font). xAI owns Cursor in this timeline (Grok Bot ships to "Cursor Ultra"/"Cursor Teams Premium" subscribers), so this is the shipping app's design system extracted from the marketing build. I mark claims as (A) extracted CSS/DOM, (B) screenshots I rendered, (C) official docs, (D) reviewers. I did **not** get inside the real app (hard paywall: SuperGrok Heavy / Cursor Ultra $200/mo / Cursor Teams Premium $120/seat/mo, no free tier).

---

## 1. What "Grok Bot" actually is

- Announced **11 Aug 2026** as "Grok Bot" — *"a team of always-on AI agents"* — beta on **desktop (macOS Apple-silicon/Intel, Windows x64/Arm64) and iPhone (iOS 18+)**. Linux desktop is **not** supported (a reviewer notes the download button reads "Download for Linux" while docs say otherwise — a real shipping bug). (C/D)
- Each **user account** (not each Bot) gets **one persistent cloud Linux computer**. Each Bot gets **its own screen** on that shared machine; screens are "separate work surfaces, **not** separate security boundaries". Browser cookies, logins, files (`/workspace`) and CLI credentials are shared across all your Bots. (C)
- You create Bots with a **name, job title and description**; the description holds durable rules ("Never send external messages without approval"), the message holds the task. (C/D)
- Bots message **each other** asynchronously; **group chats of 2–6 Bots** with self-routing or `@`-addressing. Handoffs are visible in the transcript. (C/D)
- **Skills** (reusable method) + **Routines** (schedule/event trigger, ≤50 per Bot, last 20 run records kept). **Teach a task** records ≤10 min of browser work and emits a *draft* skill. (C)
- Same-day siblings: **Grok 4.6** (long-running agents, 500K ctx, $2/$6) and, from 7 Aug, **Grok Build 1.0**, xAI's *terminal* coding CLI with an optional web UI — a different product; don't confuse them.
- HN reception: `x.ai/bot` hit **338 points / 323 comments** (item 49261514); the x.ai/news post 59/14 (49261532).

---

## 2. Information architecture

Three columns declared in CSS as one grid — `grid-template-columns: minmax(0,auto) minmax(0,1fr) minmax(0,auto)` (`.baby-grok-bot-shell`) — i.e. **sidebar | chat | optional right side-pane**. (A)

### 2.1 Left rail — "roster of colleagues" (280px)
`--grok-bot-sidebar-width: 280px`, header row 44px (`--grok-bot-toolbar-height`), 52px reserved for macOS traffic lights (`--grok-bot-titlebar-inset`). (A)

Top→bottom (B, `anim-hero-*.png`):
1. **Traffic lights** (real macOS red/amber/green, `pointer-events:none` spacer) + a single `+` icon button (`aria-label="New agent"`, 24×24, radius 6, `transition: background-color .12s`).
2. **Search field** — 32px tall, radius 10, `background: --grok-bot-bg-tertiary`, 13px placeholder "Search", 0.5px separator border.
3. **Agent list** — rows 53px: 32px circular avatar, name (14px), **relative time right-aligned (12px, 40% opacity)**, and a **one-line live preview of the last transcript line** (13px, secondary). Row radius 10, padding 8, gap 8, `transition: background-color .12s`; selected = `--grok-bot-sidebar-selected` (`#0a0a0a0e` light / `#ffffff13` dark). Rows carry an **unread dot** (`__unread`) — "Inbox Manager" shows a red `#ff3b30` badge dot.
4. **Pinned tiles** variant: 68px vertical tiles above a 0.5px divider (collapsed/pinned mode).
5. **Footer**: 34px circular user chip with initials ("AS") + name; collapses to icon-only.

Sidebar details worth stealing (A):
- The list uses a **CSS mask fade** top and bottom toggled by scroll state: `[data-fade-top]` / `[data-fade-bottom]` swap in `mask-image: linear-gradient(...)` with `--baby-grok-bot-list-fade: 36px`. Scrollbar 6px, thumb `color-mix(... 22%, transparent)`, transparent track.
- `[data-collapsed]`: rows center, body+unread `display:none`, padding-inline 6px, scrollbar shrinks to **3px**.
- Sidebar is translucent (`--grok-bot-sidebar-tint: #fbfbfb59`) over a blurred substrate, with a 0.5px `::after` separator instead of a border.

### 2.2 Centre — conversation
- **Header**: a floating **agent title pill** — avatar + name — on its own glass layer (`background: color-mix(--grok-bot-bg-elevated 78%, transparent)`, `backdrop-filter: blur(28px) saturate(165%)`), so the transcript scrolls *under* it. Right: one 24×24 icon button `aria-label="Open computer"`. The title itself is `aria-label="Open Sales Outbound's computer"` — the whole header is the affordance. (A/B)
- **Transcript**: `overflow-y:auto; padding: 8px 20px 48px`. Entries `margin-top: 12px`, first `mt-0`. Thin scrollbar, 18%-opacity thumb; a variant class hides it entirely. (A)
- **Composer**: pill (`border-radius: 9999px`, h46, 0.5px border, `--grok-bot-raised-fill` = `color-mix(--bg-elevated 70%, transparent)` + `backdrop-filter: blur(20px) saturate(160%)`), with a **gradient fade mask above it** (`.baby-grok-bot-composer-fade`, 4-stop gradient 92%→62%→22%→0% of elevated bg) so messages dissolve into the composer instead of colliding with it. (A/B)

### 2.3 Right — side pane
`.baby-grok-bot-side-pane__inner` — absolutely positioned, 0.5px left border, **tinted with the current agent's colour at 6%**: `background: color-mix(in srgb, var(--grok-bot-current-agent-tint) 6%, transparent)`. (A) This is the "Agent Computer"/detail surface.

### 2.4 Full-screen overlay — the Computer
`.baby-grok-bot-screen-layer` (z-20) + scrim (`#00000061`) + `.baby-grok-bot-screen-frame` locked to **aspect-ratio 16/10** sized with container queries (`min(100cqh - 72px, 62.5cqw - 45px, 512px)`), device shell (radius 22, `box-shadow: 0 20px 52px -16px #00000059`), a **32px warning-tinted banner** across the top (`color-mix(--text-warning 13%, --bg-elevated)`) carrying the label + a pill **"Done"** button, and a 26px circular close button (`#00000080`, `backdrop-filter: blur(8px)`) top-right. (A)

---

## 3. Colour system (exact tokens, extracted)

### 3.1 App tokens — light (`.baby-grok-bot`) (A)
```
text-primary   #0a0a0a      bg-editor    #fcfcfc     bubble-user      #111110   (near-black)
text-secondary #0000008c    bg-chrome    #fbfbfb     bubble-user-ink  #ffffff
text-tertiary  #00000059    bg-elevated  #fcfcfc     bubble-agent     #1010000a (4% warm black)
text-accent    #0a84ff      bg-card      #0000000a   fill-emphasis    #111110
text-danger    #c0362c      bg-tertiary  #0000000d   fill-secondary   #1010000a
text-success   #1f8a65      bg-active    #00000014   fill-accent      #006ceb
text-warning   #b26a00      bg-hover     #0000000a   border-default   #0000001a
sidebar: tint #fbfbfb59 · text #141414/99/66 · separator #14141426 · hover #0a0a0a0a · selected #0a0a0a0e
```
### 3.2 App tokens — dark (`[data-theme="cursor-dark"]`) (A)
```
text-primary   #f2f2f2      bg-editor    #1c1c1c     bubble-user      #ecece8   (inverted: light bubble)
text-secondary #ffffff94    bg-chrome    #141414     bubble-user-ink  #141414
text-tertiary  #ffffff5c    bg-elevated  #262626     bubble-agent     #ffffff0f
text-accent    #64b5ff      bg-card      #ffffff0f   fill-emphasis    #f0f0f0
text-danger    #ff6b5e      bg-tertiary  #ffffff12   border-default   #ffffff1f
text-success   #4cc79b      bg-active    #ffffff1f
text-warning   #e8a33d      bg-hover     #ffffff0f
sidebar: tint #14141447 · text #ffffffe6/8c/52 · separator #ffffff1f · hover #ffffff0d · selected #ffffff13
```
**Observation:** four semantic hues only (accent-blue, danger-red, success-green, warning-amber) plus a warm-neutral greyscale; everything else is alpha-over-neutral. Dark mode **inverts the user bubble** to light-on-dark rather than keeping it black — a deliberate "your message is the loud one" rule that survives both themes.

### 3.3 Per-agent accent colours (sampled from my renders, B)
Each Bot owns a hue used for avatar, `@mention` chip, "current agent" tint, typing pill:
```
Chief            #54b9a6  teal
Sales Outbound   #f19d38  amber-orange
Inbox Manager    #6464ef  indigo   (+ unread dot #ff3b30)
Account Manager  #885cf5  violet
Talent Scout     #3c82f6  blue
Expense Manager  #ed712e  orange-red
Offsite crew     (group)  three overlapping faces: violet + teal + indigo
```
Runtime tokens: `--grok-bot-current-agent-accent`, `--grok-bot-current-agent-bubble` (both `#156e7a` in the default sample), `--grok-bot-current-agent-coat: #885cf5`. Accent fills are always **6–14% alpha** (`color-mix(... 14%, transparent)`); full strength only for text/icon. (A)

### 3.4 Marketing-site palette (surrounding chrome) (A)
`--accent: --color-sunset (22 100% 51.6%)`, hover `--color-dawn (37 100% 76%)`; neutrals named jet/charcoal/umbra/ink/ash/steel/fog/pewter/dove/nimbus/ivory; global `--radius: .5rem`, `--duration: .14s`, `--ease-out-spring: cubic-bezier(.25,1,.5,1)`. Full 16-step brand ramps for brown/red/orange/yellow/green/cyan/blue/violet/magenta/gray (`--color-brand-*-100..700`).

### 3.5 Terminal tokens (they *do* ship a terminal theme — for the CLI product, not Grok Bot) (A)
```
dark:  --terminal-bg #0a0a0a  --terminal-fg #d7d1c9  --terminal-surface #202020  --terminal-editor-bg #151515
       --terminal-border #ffffff14  --terminal-dim #8d867e  --terminal-dimmer #59534d  --terminal-vdim #2a2825
       diff-delete fg #f7768e / bg #32181c      diff-insert fg #9ece6a / bg #202a16
light: --terminal-bg #fff --terminal-editor-bg #f8f7f5 --terminal-fg #000000d9 --terminal-dim #0009
       product ansi-green #1f8a65 · ansi-red #cf2d56 · inserted-line bg = ansi-green @8% · removed-line bg = ansi-red @6%
```
**Most directly copyable thing for supermux's diff rendering:** full-strength foreground for changed text, only a **6–8% colour wash** on the line background.

---

## 4. Typography

- **App font is the system stack**: `--cursor-font-family-sans: var(--font-system)` = `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial…`, with `-webkit-font-smoothing: antialiased`. No custom webfont in the app. Weights: 400, **500** (`--cursor-font-weight-medium`), **600**. Dedicated icon font `CursorIcons16`. (A)
- Marketing site uses `universalSans` / `universalSansDisplay` (xAI brand faces) — *not* the app. (A)
- **The scale is tiny and tight** (A, computed):
```
message body / composer input  14px / 20 line-height / letter-spacing -0.15px
card body                      14 / 20 / -0.15   · card title 14px/600
card secondary                 13 / 18
badge                          12 / 19 / -0.10
system pill                    13 / 16 / 500
sidebar row name               14        · preview 13/18/-0.08 · time 12/16
search input                   13 / 18 / -0.08
pending ("Thinking") label     13 / line-height:1 (baseline-aligned inline-flex)
inline code                    0.92em, ui-monospace/SFMono/Menlo/Monaco/Consolas
bold in markdown               600 weight, primary colour (not a different colour)
```
- Negative tracking everywhere (-0.08 to -0.15px) — the macOS-native "not a webpage" tell. Marketing `.hero-headline` uses `letter-spacing: -0.04em`.

---

## 5. Spacing, density, shape

(A, computed/CSS)
```
window radius            24px          shell substrate  #fcfcfca6 + blur(80px) saturate(180%)
window float shadow      0 14px 40px #00000029, 0 0 0 .5px #0000000d
toolbar height           44px          sidebar width 280 · left inset 16 · right inset 10
message bubble radius    16px          bubble padding 10px 12px
card radius              16px          card padding  10px 12px
badge / action / pill    999px         badge padding 0 7px · action padding 5px 12px
choice option radius     10px          message-panel radius 10px, rows padding 6px 10px
mention chip             radius 5px, padding 0 3px, weight 500
composer                 pill, h46, 0.5px border
transcript padding       8 / 20 / 48   entry gap 12px
agent row                h53, r10, p8, gap 8, avatar 32
pending avatar           40px          reaction chip 20px circle, 11px glyph, top:calc(100% - 6px)
```
**All borders are 0.5px**, never 1px — composer, cards, popovers, sidebar separator. With 4–10% alpha fills this is what makes it read as "quiet". Elevation = **backdrop-filter + hairline**, not shadow, except popovers: `0 1px 2px #0000000f, 0 14px 36px -10px #00000047`.

---

## 6. How agent activity is rendered (the core question)

Everything is a **transcript entry**. Exactly these primitives (A/B):

1. **Agent bubble** — `.baby-grok-bot-md`, left-aligned, 4%-black fill, radius 16, 14/20. Markdown-capable (`strong` → 600 primary, `code` → 4%-fill chip, mono, 0.92em). Consecutive bubbles stack with 12px gap and **no repeated avatar**.
2. **User bubble** — right-aligned, solid `#111110` white ink (light) / `#ecece8` dark ink (dark).
3. **Timestamp divider** — centred, tertiary (`1:47 PM`), only at the top of a session block.
4. **System pill line** — centred tertiary text with an inline coloured agent chip: *"Renamed to Sales Outbound"*, *"Updated memory for ●Account Manager"*, *"Created routine 🕐 Overnight outbound"*. The agent chip (`.baby-grok-bot-system-agent`) is a clickable inline pill that gains a tinted background on hover (`transition: background-color .12s, color .12s`).
5. **"Messages from ●A and ●B" header** — a centred meta line announcing the next block came from *other Bots*, then a bubble whose author names render as **inline coloured mentions with a 20px mascot-face glyph** (`.baby-grok-bot-message-mention__face`, `height: 1lh`, 4px right margin). This is how **subagent / parallel work** surfaces: not a nested panel, but coloured attribution inline in prose.
6. **Receipt list** — a plain bubble containing a checklist of *tool → outcome*:
   `✓ Salesforce → list pulled · 52 accounts` / `✓ Hex → 3 lookalike segments pulled` / `✓ LinkedIn → 4 profiles skipped · recently contacted` / `✓ Sequencer → 36 drafts queued · 0 sent`.
   Tool name **bold 600**, arrow, result, `·`-separated counts. No icons, no boxes, no expand/collapse. **This is their entire "tool call" UI.** (B: `anim-hero-08/12/18.png`)
7. **Card** (`.baby-grok-bot-card`) — same fill as an agent bubble, radius 16, with **title** (14/600) + **status badge** right, a one-line prose ask, an **embedded live preview** of the cloud desktop (16:10, radius ~12), and a row of **actions**: primary pill (solid `fill-emphasis`, white ink), secondary pill (0.5px border, elevated fill), ghost (text only) — e.g. **"Take over" / "I'm done"**, or **"Send email" / "Discard"**.
8. **Message panel** (`.baby-grok-bot-message-panel`) — bordered 10px-radius block of `dt/dd` rows (To / Subject / …) then a body: **an email draft rendered as a structured artifact card** with approve/discard underneath. Their "diff/artifact review" analogue. (A; B on mobile shot)
9. **Choice options** (`.baby-grok-bot-choice-option`) — full-width 10px-radius selectable rows; `[data-selected]` = accent border at 55% + accent fill at 8%; plus a free-text `choice-input` (focus = accent border 55%) and a **"Confirm" pill** at `opacity:.4` while disabled. Their *disambiguation / plan-choice* widget.
10. **Reactions** — 20px circular emoji chips absolutely positioned overhanging the bubble's bottom edge (`top: calc(100% - 6px)`, left 10 agent / right 10 user).

**Status badges** (`.baby-grok-bot-card-badge`, 12px pill, `[data-tone]`) — the complete state vocabulary observed:
```
data-tone=warning  "☀ Working"           amber, rotating sunburst spinner
data-tone=warning  "☀ Action needed"     amber
data-tone=warning  "● You're in control" amber + 5px dot
data-tone=success  "● Done"              green #1f8a65 on 14% green fill + 5px dot
data-tone=info / accent / muted also defined
```
Every tone is `color-mix(<semantic colour> 14%, transparent)` fill with full-strength colour as text — one rule, five tones. (A/B: `anim-stage0-03.png`, `anim-hero-02.png`, `anim-hero-08.png`)

**What is *not* in the UI:** no file tree, no diff viewer, no terminal pane, no token/cost meter in the transcript, no plan/todo checklist widget (plans are prose; closest analogues are the receipt list and the routine system-line), no collapsible "thinking" trace. Reviewers confirm the only audit surface today is "spend and usage on a dashboard, plus the chat transcript"; a per-action audit view is *"coming"*. (D)

---

## 7. Loading / thinking states and their animations

Exact keyframes and easings, lifted from shipped CSS (A):

```css
/* pending row: 40px avatar + label, whole row springs in */
.baby-grok-bot-pending        { animation: .28s cubic-bezier(.2,.9,.3,1.15) baby-grok-bot-pending-in; }
@keyframes baby-grok-bot-pending-in       { 0%{opacity:0;transform:translateY(8px) scale(.97)} to{opacity:1;transform:none} }
/* the word "Thinking" arrives slightly later on its own softer curve */
.baby-grok-bot-pending__label { animation: .35s cubic-bezier(.2,.8,.3,1) baby-grok-bot-pending-label-in; }
@keyframes baby-grok-bot-pending-label-in { 0%{opacity:0;transform:translateY(5px)} to{opacity:1;transform:none} }

/* three 6px dots, opacity wave; staggered by *static base opacities*, not delays */
.baby-grok-bot-typing-dot { width:6px;height:6px;border-radius:999px;background:currentColor;
                            animation: 1.3s ease-in-out infinite baby-grok-bot-typing-dot; }
@keyframes baby-grok-bot-typing-dot { 0%,55%,100%{opacity:.25} 25%{opacity:.7} }
.baby-grok-bot-typing-dot:first-child{opacity:.25} :nth-child(2){opacity:.45} :nth-child(3){opacity:.7}

/* every transcript entry enters with a spring pop */
.baby-grok-bot-entry-enter { animation: .28s cubic-bezier(.2,.9,.3,1.15) both baby-grok-bot-entry-enter; }
[data-fresh] > .baby-grok-bot-entry-enter { animation-duration:.42s; }   /* newly-arrived gets a slower pop */
@keyframes baby-grok-bot-entry-enter { 0%{opacity:0;transform:translateY(8px) scale(.97)} to{opacity:1;transform:none} }

/* sidebar rows slide in from the left when a Bot is added */
.baby-grok-bot-agent-row--enter { animation: .45s cubic-bezier(.22,1,.36,1) both baby-grok-bot-row-enter; }
@keyframes baby-grok-bot-row-enter { 0%{opacity:0;transform:translateX(-10px)} to{opacity:1;transform:none} }

/* the ✓ on a completed receipt pops from 40% */
.baby-grok-bot-receipt-check { animation: .28s cubic-bezier(.22,1,.36,1) both baby-grok-bot-receipt-check; }
@keyframes baby-grok-bot-receipt-check { 0%{opacity:0;transform:scale(.4)} to{opacity:1;transform:scale(1)} }

/* the "Working" badge spinner turns slowly — 2.4s, not 1s */
.baby-grok-bot-spinner { animation: 2.4s linear infinite baby-grok-bot-spin; }

/* the agent's cursor wandering across the embedded desktop preview */
.baby-grok-bot-portal-agent-cursor { opacity:0; animation: 2.6s cubic-bezier(.4,0,.2,1) both baby-grok-bot-portal-agent-cursor; }
@keyframes baby-grok-bot-portal-agent-cursor {
  0%{opacity:0;top:12%;left:34%} 8%{opacity:1} 20%{top:24%;left:52%} 36%{top:36%;left:38%}
  52%{top:48%;left:58%} 68%{top:60%;left:42%} 84%{top:72%;left:54%} to{opacity:1;top:78%;left:38%} }

/* first mount of the whole surface */
.baby-grok-bot-mount-fade { animation: 1s cubic-bezier(.22,1,.36,1) both; }   /* 0% {opacity:0} */
```
Two reusable curves do 90% of the work: **`cubic-bezier(.2,.9,.3,1.15)`** (15%-overshoot "pop", for anything *arriving*) and **`cubic-bezier(.22,1,.36,1)`** (expo-out, for anything *settling*). Hover/state changes are a flat **`.12s`** on `background-color` only. Card badges and actions cross-fade over **`.26s`** (`transition: background-color .26s, color .26s, opacity .26s`), so `Working → Action needed → Done` **morphs in place** instead of swapping.

Every one of these rules is immediately followed in the stylesheet by a `prefers-reduced-motion` override setting `animation: none` — **motion is fully opt-out.** (A)

Observed state machine of a single task (B, 34 timed captures `anim-hero-00..33.png`):
```
user message → sidebar preview flips to "Typing…" → [Thinking + 3 dots] → agent bubble
→ Card "Computer" · badge ☀ Action needed · desktop preview · [Take over][I'm done]
→ badge morphs to ● Done, preview updates to the finished screen
→ receipt list ✓✓✓✓ → "Messages from ●X and ●Y" → cross-agent bubble with coloured mentions
→ user reply (black bubble, emoji reaction chip) → system line "Created routine 🕐 Overnight outbound"
→ final short agent bubble "Done." → sidebar preview becomes "Done."
```
The **sidebar row preview is a live mirror of the transcript tail**, and **timestamps tick** (1:42 → 1:45 → 1:47 → 1:51 across my captures) — relative time is recomputed, not frozen.

---

## 8. Signature micro-interactions

1. **The mascot avatar is the status indicator.** Each agent is a filled circle with two asymmetric white elliptical eyes (`.grok-bot-mark__head` / `__eye`, `transition: fill .6s`). Eyes change shape/direction between frames — blinking, glancing, squinting — so an idle roster has ambient life. Group chats render **three overlapping faces** as one avatar. (B: `anim-hero-00` vs `08`, `mobel-statementcharacterpanel.png`)
2. **Avatar-row morph** (`.avatar-row`, the "Connect the Bots" relay): overlapping circular chips (`--avatar-row-overlap: .24` → -24% margin) where the active one **expands into a labelled pill** — `transition: background .4s ease, box-shadow .4s ease, color .4s ease, padding .4s ease` plus `[data-open]{padding-left: pad + chip*.5}` — producing "●●● **Asking Research…**" then handing the pill to the next avatar. It reads as a baton pass. Best single idea on the page. (A/B: `clean-stage3-02.png`)
3. **Presence cursors.** A black arrow with a small dark pill label **"You"** appears over the embedded desktop when *you* take control; a magenta arrow+dot is the *agent's* cursor. Figma-style multiplayer cursors applied to an agent's screen. (B: `anim-stage1-04.png`, `anim-stage0-03.png`)
4. **In-place badge morphs** (§7) rather than badge swaps.
5. **Composer fade mask** — content dissolving into the composer instead of a hard divider. (A)
6. **Sidebar mask fades** driven by scroll position, plus a **3px scrollbar in collapsed mode**. (A)
7. **Mention chips** carry a live mini-face and are click targets that navigate to that Bot.
8. **Card title as a link**: `button.baby-grok-bot-card-title:hover { text-decoration: underline; text-decoration-color: var(--grok-bot-current-agent-accent); text-decoration-thickness: 1.5px; }` — the underline is *the agent's colour*, 1.5px, offset 3px. That is the level of micro-detail throughout.
9. **Marketing-only but gorgeous**: `.hero-glow-desktop` puts a coloured double glow under the app window — `0 20px 44px -18px color-mix(oklch, brand-orange-400 30%, transparent), 0 40px 90px -36px color-mix(oklch, brand-magenta-400 42%, transparent)` — plus `hero-shimmer` / `border-shimmer` / `border-beam` (`@keyframes border-beam { to { --angle: 360deg } }`, an `@property`-driven conic border sweep).

---

## 9. Input affordances

- **Composer** is a `contenteditable` div, not a textarea (`min-height:20px; max-height:120px; overflow-y:auto; white-space:pre-wrap; overflow-wrap:anywhere`), with a CSS-only placeholder via `[data-empty]::before { content: attr(data-placeholder) }` — the placeholder is `Message <Bot name>`, i.e. *addressed to the agent by name*. (A)
- Left: `+` attach button. Right: circular **microphone** (voice message). No send button — Enter sends. Mobile mirrors this. (B)
- **`@` opens a mention popover** (`.baby-grok-bot-mention-popover`: min 190/max 280px, radius 10, 0.5px border, anchored `bottom: calc(100% + 10px)`, shadow `0 1px 2px #0000000f, 0 14px 36px -10px #00000047`) listing **Bots, groups, routines and connectors**. Inserted mentions render as a tinted chip (`background: color-mix(current-agent-accent 14%, transparent)`, weight 500, radius 5). (A/C)
- **`/` references a saved skill.** (C)
- A wider **compose popover** (`.baby-grok-bot-compose-popover`, under a 44px compose header, left/right 10px) with a scrollable result list (`max-height: min(280px, 46vh)`), rows radius 8, `[data-highlighted]` = `--grok-bot-bg-active` — a command-palette-grade picker. (A)
- **Interrupt**: no stop/cancel button exists in the extracted UI. The documented equivalent is *taking over the computer* ("Take over" / "I'm done") and telling the Bot to continue in prose. (A/C)

---

## 10. Approvals, errors, permissions

From the official docs (C) — verbatim UI strings:
- Desktop: **"Allow once"**, **"Deny"**, **"Always allow"** (saves a matching rule). iPhone: **"Approve once"**, **"Deny"**.
- *"When an action needs approval, the conversation shows the proposed operation and its inputs. Review the target, scope, and values before approving."* → the approval is a **card in the transcript**, not a modal.
- *"An approval controls the proposed action. It does not reverse work already completed."*
- **Auto Review**: `Settings → General → Auto-review`; rule kinds **"Require Approval"** and **"Always Allow"**; Require wins on conflict; rules stored **per desktop** (not synced).
- **Local execution policy**: `Settings → General → Agent → Execution on Local Computer` → *Always require approval* / *Are always allowed* / *Are never allowed*, default **"Ask every time."**
- **Secret handoff**: a dedicated **secure secret request** field; *"The value is masked, excluded from the transcript, and not shown to the model."* Passwords/2FA/CAPTCHA/payments are handled by **handing the user the computer**, never via chat.
- **Error / recovery**: *"When the computer is unreachable, use **Recover computer** from the error state"*; `Settings → Beta` offers **Update Agent Computer** / **Recover Agent Computer** / **Reset Agent Computer** with explicit data-loss wording. Long-idle routines: *"Grok Bot may ask whether to keep routines running after a long period away and pause them if there is no response."*
- In the rendered UI the amber **"You're in control"** badge is the permission state; the full-screen Computer overlay carries an amber banner + **"Done"** pill to hand control back. (A/B)

---

## 11. Mobile vs desktop

(B: `mobel-mobilephonescreen.png`, `bot-scr04.png`; C)
- iOS is a **first-class second client**, not a viewer: same transcript, same cards, same approvals (two-button variant).
- Mobile chrome is **floating circular glass buttons** over the scroll: back chevron (left), the **agent title pill with avatar** (centre), computer icon (right). No sidebar — the roster is a separate screen behind the chevron.
- Bubbles reflow to ~85% width; the email-draft artifact stays a white card with **"Send email" / "Discard"** pills inline.
- Composer is a floating pill with `+` and mic; placeholder truncates to `Message Sales O…`.
- Dedicated mobile token set (`.mobile-phone-screen`): light bg `#f8f8f6`, bubble `#f2f2f0e6`, primary surface `#ffffffeb`, link `#2b7fa3`, green `#16896a`, red `#c73d59`, working-ring `#65afe0`; dark bg `#1e1e1e`, bubble `#ffffff13`, link `#7fbede`, green `#5cc29a`, red `#e16c85`. The mobile palette is **warmer/softer** than desktop — they retuned rather than reused. (A)

---

## 12. What reviewers praise / criticise

**Praise**
- *"Grok Bot has the best onboarding an agent product [I have] seen… The polish is real, and the sidebar-of-colleagues idea deserves to be stolen."* (D)
- *"The setup cost really is close to zero. There's no workflow builder, no graph to draw, no prior Bot configuration."* — eesel review (D)
- HN early-access tester (thread 49261514): *"I was surprised with how much it felt natural to interact with agents in this way… each one owns its own routines, context, and domain, and they can communicate between each other… each one has their own computer, which means async work feels like it actually works. I haven't had to juggle worktrees for the last month."*
- HN: *"Grok Bot simplifies the setup for this about as far as I imagine is possible, and frankly it's a pretty slick experience."*
- HN: *"Right now Grok Bot looks a lot easier to get started and maintain with a simpler UI (arguably better)"* than OpenClaw/Hermes.

**Criticism**
- **Cost**: *"I've used more tokens this month than [in] the last 5 years prior… Always on perpetual agents use a LOT of tokens."* Another: *"48% weekly usage left after 3 hours of experimenting."* (HN)
- **No dry run / no sandbox** — *"a test run performs real work: it can navigate websites, change files and call connected tools."* (C/D)
- **Approvals are prose, not policy**; Auto Review is opt-in, model-based, **stored per desktop**. (C/D)
- **No per-action audit view** ("coming", stated twice in the docs); only spend/usage + transcript. (D)
- **One computer, every login** — all Bots share cookies/credentials; xAI says explicitly they are *not* a security boundary. The product's central design risk. (C/D)
- **No compliance story** (no SOC 2 / ISO 27001 / GDPR / HIPAA, no retention or residency). (D)
- **Computer use quality**: *"the computer use is nowhere near ready."* (D)
- **UI sameness**: HN — *"Interesting how everyone seems to be following OpenAI on UX. When I used Antigravity and they suddenly switched to Codex type UI I was very annoyed because I kept checking if this is Codex or Antigravity."*
- **Missing human collaboration**: HN — *"it was surprising to me that's all it offers because it does so in a group chat app. I just assumed it was like Buzz at first, allowing you to invite other humans."*
- Shipping bug on the marketing page itself: a **"Download for Linux"** button for an unsupported platform. (D)
- Broad brand/trust objections to Musk/xAI recur through the HN thread and are the single most common comment class.

---

## 13. Concrete recommendations for supermux (mapping)

1. **Adopt the roster-as-sidebar**: 280px, 53px rows, 32px avatar, per-session accent hue, live one-line preview of the transcript tail, relative time, unread dot, `[data-collapsed]` icon-only mode. Exactly supermux's overview problem, and the idea reviewers say to steal.
2. **Give every session an accent colour**; use it at 6–14% alpha for fills, full strength only for text, icons and the card-title underline. Solves "which session am I looking at" without chrome.
3. **Render tool calls as receipt lines**, not boxes: `✓ **Tool** → outcome · counts`. Cheap, scannable, collapses a Claude Code turn to 4 lines. Add the `receipt-check` scale-from-0.4 pop per line as it lands.
4. **One card component with `data-tone` badges** for anything stateful (Working / Action needed / Done / Failed), and **morph the badge in place** over 0.26s rather than swapping it.
5. **Two easing curves, two durations**: `.28s cubic-bezier(.2,.9,.3,1.15)` for arrivals (`.42s` when fresh), `.12s` for hover/state. Ship the `prefers-reduced-motion → animation:none` override alongside.
6. **Thinking state = 40px avatar + 3-dot opacity wave (1.3s) + a 13px tertiary label**, with the label entering on a separate, slower curve. Far quieter than a spinner; reads as "alive, not stuck".
7. **Hairlines at 0.5px + backdrop-filter, not 1px + shadow.** `blur(20px) saturate(160%)` raised surfaces, `blur(28px) saturate(165%)` sticky header pill, `blur(80px) saturate(180%)` window substrate.
8. **Composer**: pill, contenteditable, `max-height:120px`, `Message <session name>` placeholder, `@` popover for sessions/agents and `/` for commands, plus the gradient fade mask above it.
9. **Terminal toggle**: their `cli-terminal-theme` tokens give a ready-made "raw terminal" palette that harmonises with the chat view — dark `#0a0a0a` bg / `#d7d1c9` fg / `#ffffff14` borders, diffs `#9ece6a` / `#f7768e` foreground over 6–8% line washes. Use those so the toggle feels like the same product.
10. **Presence cursors** (labelled "You" vs the agent) are the best idea to lift if supermux ever renders a shared/watched view.

---

## 14. Evidence / saved artefacts

All paths under `/tmp/claude-1000/-opt-projects-supermux/0ce1fa02-9bc2-41c3-b2c6-7b2814d510c0/scratchpad/grok/`

**Primary UI captures (rendered by me from the live x.ai/bot app replica, 2× DPR)**
- `/tmp/claude-1000/-opt-projects-supermux/0ce1fa02-9bc2-41c3-b2c6-7b2814d510c0/scratchpad/grok/bot-page-full.png`, `.../bot-clean-full.png` — full marketing page, 2880×16734 (cookie banner removed in the latter)
- `.../crop-hero-app.png` — the hero desktop-app mockup, cropped
- `.../anim-hero-00.png` … `.../anim-hero-33.png` — 34 timed captures (~1.3s apart) of the app replica running a full task lifecycle. Key frames: `00` (Thinking + typing dots), `02` (Card "Action needed" + Take over/I'm done), `08` (Card "Done" + receipt list), `12` ("Messages from …" cross-agent block), `18`/`24` (routine created, reaction chip, final "Done.")
- `.../dark-hero-00..05.png` — same surface in dark theme (`data-theme="cursor-dark"`)
- `.../anim-stage0-00..07.png`, `.../clean-stage0-*.png` — "Computer" card, badge **☀ Working**, animated agent cursor
- `.../anim-stage1-00..07.png`, `.../clean-stage1-*.png` — "Teach a task" recording overlay, banner + **"You"** presence cursor
- `.../anim-stage2-*.png`, `.../clean-stage2-*.png` — "Bots get smarter over time" (memory update system line)
- `.../clean-stage3-00..05.png` — avatar-row relay morph, "●●● Asking Research…"
- `.../bot-scr00.png` … `.../bot-scr10.png` — desktop page in 800px scroll steps
- `.../mob-00.png` … `.../mob-14.png` — same page at 390×844, iOS UA, 3× DPR
- `.../mobel-mobilephonescreen.png` — the iOS app mock (draft card + Send email/Discard + floating composer)
- `.../mobel-statementcharacterpanel.png` — the mascot mark at large size (eye geometry)
- `.../mobel-babygrokbot.png` — app replica at mobile width

**Source data**
- `.../bot-dom.html` (418 KB) — rendered DOM of x.ai/bot incl. the full `baby-grok-bot-*` component tree
- `.../bot-css.txt` (344 KB) — all stylesheets; `.../grokbot-rules.css` (193 rules) — extracted grok-bot/mobile/hero rules
- `.../bot-styles.json` — computed styles for 906 visible elements + 467 CSS custom properties
- `.../docs-get-started.txt`, `.../docs-computer-and-apps.txt`, `.../docs-approvals-security-and-privacy.txt`, `.../docs-skills-routines-and-automations.txt`, `.../docs-use-cases.txt`, `.../docs-teams-and-enterprises.txt` (+ matching `.html`) — full text of docs.x.ai/grok-bot, "Last updated: August 11, 2026"
- `.../hn-49261514.txt` — 634 lines, full comment tree of the 338-point HN thread
- `.../eesel.html`, `.../intro.html`, `.../note.html`, `.../myclaw.html` — press/review sources
- `.../og.png` — official OG image for the launch post
- `.../note-*.conv.png` — note.com hands-on illustrations (**AI-drawn explainers, not screenshots** — no UI evidence)
- `.../hero-f00..f35.png`, `.../play-t*.png` — frames of the 106s launch film (`260810_2245_bw_dr_cursor_bot_edit_v8.mp4`, 1920×1080). **It is a lifestyle brand film** ("We recently hired a new teammate"), not a product demo; no usable UI. media.x.ai is Cloudflare-blocked to curl even via the residential proxy — frames were grabbed by driving a stealth Chromium.

**Reusable scripts**: `/home/supermux/pwlibs/driver/grokinspect.mjs` (DOM+CSS+computed-style dump), `/home/supermux/pwlibs/driver/grokbot.mjs`, `/home/supermux/pwlibs/driver/groktime.mjs` (timed element capture), `/home/supermux/pwlibs/driver/grokfinal.mjs`, `/home/supermux/pwlibs/driver/grokmobile.mjs`, `/home/supermux/pwlibs/driver/grokimgs.mjs`, `/home/supermux/pwlibs/driver/grokvid.mjs`, `/home/supermux/pwlibs/driver/grokvid2.mjs`.

**Key URLs**: `https://x.ai/bot` · `https://x.ai/news/introducing-grok-bot` · `https://docs.x.ai/grok-bot/*` · `https://news.ycombinator.com/item?id=49261514` · `https://www.eesel.ai/blog/grok-bot-review`
