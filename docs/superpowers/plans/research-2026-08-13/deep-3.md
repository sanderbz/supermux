# Grok Bot — Agent-Management Paradigms (research report)

Full report also written to `/tmp/claude-1000/-opt-projects-supermux/0ce1fa02-9bc2-41c3-b2c6-7b2814d510c0/scratchpad/grok-agent-management-report.md`. Newly fetched docs saved as `…/scratchpad/grok/new-*.md`; derived artifacts `…/grok/dom-nosvg.html`, `…/grok/dom-text.txt`, `…/scratchpad/crop-roster.png`.

Evidence base: on-disk capture + 8 docs pages newly fetched this session (`https://docs.x.ai/grok-bot/<page>.md`). Desktop app version per the DOM download link: **0.18.0**. Docs "Last updated: August 11, 2026".

Two evidence tiers, kept separate throughout:
- **DOCS** — normative, describes the shipping desktop/iOS app.
- **REPLICA** — the pixel-level in-page React reproduction of the app on x.ai/bot (`.baby-grok-bot-*` tree). Its component anatomy, tokens and geometry are real; its **data** (which bots, what order, what timestamps) is art-directed and is NOT evidence of behaviour. Flagged everywhere it matters.

---

## 0. Docs nav — complete enumeration (task item 9)

Extracted from the sidebar of the on-disk `docs-*.html` (`href="/grok-bot/…"`):

| Page | On disk before? | Status |
|---|---|---|
| `/grok-bot/overview` | no | **fetched** → `new-overview.md` |
| `/grok-bot/get-started` | yes | — |
| `/grok-bot/mobile` | no | **fetched** → `new-mobile.md` |
| `/grok-bot/bots` | no | **fetched** → `new-bots.md` ← *the* agent-management page |
| `/grok-bot/chat-and-collaboration` | no | **fetched** → `new-chat-and-collaboration.md` ← groups/@/threads/search |
| `/grok-bot/computer-and-apps` | yes | — |
| `/grok-bot/files-and-results` | no | **fetched** → `new-files-and-results.md` |
| `/grok-bot/skills-routines-and-automations` | yes | — |
| `/grok-bot/approvals-security-and-privacy` | yes | — |
| `/grok-bot/settings-and-notifications` | no | **fetched** → `new-settings-and-notifications.md` ← attention states |
| `/grok-bot/teams-and-enterprises` | yes | — |
| `/grok-bot/use-cases` | yes | — |
| `/grok-bot/troubleshooting` | no | **fetched** → `new-troubleshooting.md` |
| `/grok-bot/faq` | no | **fetched** → `new-faq.md` |

That is the whole nav — 14 pages, no hidden "managing bots" page beyond `bots`.

---

## 1. Creation flow

### 1.1 The affordance
DOCS (`new-bots.md`, "Create a Bot"), verbatim:
> 1. Choose **New** in the sidebar or press `Cmd/Ctrl+N`.
> 2. In **New chat**, select **Create new agent**.
> 3. Grok Bot creates and opens a Bot named **New Agent**.
> 4. Open **Bot actions → Edit Profile** to set its name, title, description, and avatar.
> 5. Start a conversation with a concrete task.

REPLICA confirms the affordance is a **single icon button**, not a labelled menu:
`bot-dom.html` → `<button type="button" aria-label="New agent" class="baby-grok-bot-sidebar-header__action" data-demo-target="sidebar-new-agent">` — 24×24 px, radius 6, the *only* child of `.baby-grok-bot-sidebar-header__actions`. Rendered as a bare `+` at the sidebar's top-right (`anim-hero-20.png`).

So: **`+` → "New chat" sheet → pick "Create new agent" *or* pick 2–6 existing bots (that makes a group).** One entry point, two outcomes. iOS: `new-mobile.md` — "Use the **+** control on the home screen to choose **New Agent** or **New Group Chat**."

The "New chat" sheet is a **search-first picker, not a form**: CSS ships `.baby-grok-bot-compose-header` (toolbar-height, bottom-hairline), `.baby-grok-bot-compose-field`, `.baby-grok-bot-compose-popover` (absolute, `top: calc(100% + 6px)`, radius 12, raised fill + backdrop-filter, `0 1px 2px #0000000f, 0 14px 36px -10px #00000047`), `.baby-grok-bot-compose-results` (`max-height: min(280px,46vh)`) and `.baby-grok-bot-compose-result[data-highlighted]` (keyboard nav) — all in `grokbot-rules.css`. **There is no create-agent modal with name/title/description fields**: the bot is created *empty and immediately open*, identity filled in afterwards (or by the bot itself, §2).

### 1.2 The three identity fields
DOCS (`docs-get-started.txt`, step 3) — the canonical example:
> **Name:** Piper · **Job:** Product performance · **Description:** Investigate product-performance questions using our observability tools. Preserve links and screenshots, separate evidence from hypotheses, and return a short summary with the highest-impact issue first. Never change production settings.

- **Name** — the display label. Surfaces (all from `bot-dom.html`): sidebar row name span (14 px/20/−0.15), chat header pill (13 px/18/−0.08), composer placeholder (`data-placeholder="Message Sales Outbound"`), computer button (`aria-label="Open Sales Outbound's computer"`), `@`-mention chips, system pills, row tooltip (`title="Offsite crew"`).
- **Job / title** — one line. **Where it surfaces is undocumented.** DOCS call it "title" in both edit surfaces (`new-bots.md` step 4; `new-settings-and-notifications.md` "Name, title, and description") and "Job" in onboarding. The replica ships `.baby-grok-bot-agent-title-pill` (`background: var(--grok-bot-agent-title-fill); -webkit-backdrop-filter: var(--grok-bot-agent-title-backdrop-filter)`) but it is **not instantiated anywhere in `bot-dom.html`**, and no capture shows a job title beside a name. **FINDING (absence): a real stored field with no proven display surface.** Treat it as prompt-shaping context, possibly detail-only.
- **Description** — the durable behaviour contract. DOCS are explicit (`new-bots.md`):
  > Use the conversation for task-specific instructions. Use the description for rules that should remain true:
  > **Description:** "Never send external messages without approval." **Message:** "Draft follow-ups for these twelve accounts."
  Safety-load-bearing: `new-faq.md` and `docs-approvals-security-and-privacy.txt` both say "Put standing boundaries in each Bot's description."

### 1.3 Templates / presets
**No template gallery, no clone-from-template.** What exists:
- **First-run suggestions.** `docs-get-started.txt`: onboarding "asks which tools you use. These answers shape the first teammate suggestions"; the final step opens **Meet a future teammate**, where you "Choose a suggested teammate … or choose **Create your own**." One-shot, tool-inferred, onboarding-only. Not a persistent library.
- **Bots can create bots.** `new-bots.md`: "Your existing Bots can also suggest or create a focused Bot when a job should have a long-lived owner. Ask before creating several Bots if you want to keep the roster small." The replica dramatises it — the group chat's last line is *"that leaves the pipeline. i'd spin up a dedicated agent."* (`dom-text.txt:55`).
- **Prose "good jobs" list instead of templates:** `new-bots.md` — "Good jobs include **Talent Scout**, **Expense Manager**, and **Bug Reproduction**. A job such as **General Helper** gives the Bot less guidance." Marketing's eight canonical roles (`dom-text.txt:106-113`, chips in `crop-give-job.png`): Sales Outbound, Talent Scout, Paid Media, Expense Manager, Product Performance, Bug Reproduction, Account Health, Chief of Staff.
- **Duplicate** is the only real "start from something" mechanism (§5.3).

### 1.4 Avatar / mascot — assignment mechanics
The avatar is a **single vector mascot mark, recolored and reshaped per bot** — never a photo, never initials (initials are reserved for the *human*: `<div class="flex size-7 … rounded-full text-[10px]">AS</div>` in `.baby-grok-bot-sidebar-footer`).

From `bot-dom.html`:
- Each avatar: `<div style="--fg: <hex>; --bg: var(--grok-bot-bg-editor, #FFFFFF);"><span class="grok-bot-lazy [grok-bot-mark--fill]">…svg…</span></div>` — 32 px in rows, 18 px in the chat header and group stacks.
- The SVG is `class="grok-bot-mark"` with sub-parts `.grok-bot-mark__head` / `.grok-bot-mark__eye`, and carries a live state attribute: **`data-state="thinking"`** on the pending avatar. → *the mascot itself is the activity indicator.* Corroborated: the Sales Outbound eyes differ between `anim-hero-02.png` (working) and `anim-hero-20.png` (done).
- Observed per-bot colours (exact `--fg` hexes): Chief `#54B9A6` · Sales Outbound `#F19D38` · Inbox Manager `#6464EF` · Account Manager `#885CF5` · Talent Scout `#3C82F6` · Expense Manager `#ED712E`.
- Observed per-bot **silhouettes** (zoomed `crop-roster.png`; collapsed rail `mobel-babygrokbot.png`): **circle** (Chief, Sales Outbound, Talent Scout, Expense Manager), **triangle** (Inbox Manager), **squircle/rounded-diamond** (Account Manager). Eye treatment also varies (two slashes vs two round dots).
  → **The identity token is `shape × colour × eye-style`, not colour alone.** It stays legible at 18 px, in a collapsed rail, and for colour-blind users — a pure colour chip would not.
- **Who assigns it: unproven.** DOCS say the avatar is *editable* ("Open **Bot actions → Edit Profile** to set its name, title, description, and **avatar**", `new-bots.md`; "…**Agent settings** … Name, title, and description / **Avatar** / **Notifications**", `new-settings-and-notifications.md`). **No doc and no capture shows the picker's inventory** — pick shape+colour? pick from a grid? upload? And since a new bot is created as "New Agent" *before* Edit Profile is ever opened, an initial avatar must be auto-assigned; the rule (round-robin / hash / first-unused) is **not documented and not observable**. FINDING (absence).

### 1.5 The whole-app tint follows the active bot
The app root carries five live custom properties derived from the focused bot (`bot-dom.html`, on `.baby-grok-bot`):
```
--grok-bot-current-agent-tint:        light-dark(var(--color-brand-yellow-350), var(--color-brand-yellow-450));
--grok-bot-current-agent-bubble:      light-dark(var(--color-brand-yellow-450), var(--color-brand-yellow-350));
--grok-bot-current-agent-bubble-ink:  #FFFFFF;
--grok-bot-current-agent-accent:      light-dark(var(--color-brand-yellow-450), var(--color-brand-yellow-350));
--grok-bot-current-agent-coat:        #F19D38;
```
Consumers in `grokbot-rules.css`: `.baby-grok-bot-side-pane__inner { background: color-mix(in srgb, var(--grok-bot-current-agent-tint) 6%, transparent) }`, `.baby-grok-bot-mention { background: color-mix(… accent 14% …); color: var(--…accent) }`, `.baby-grok-bot-card-badge[data-tone=accent]`, `.baby-grok-bot-pending__avatar { --fg: var(--grok-bot-current-agent-coat) }`. The ramp behind it is the 9-hue × 17-step `--color-brand-{brown,red,orange,yellow,green,cyan,blue,violet,magenta,gray}-{100…700}` system in `bot-styles.json:rootVars` (467 props). **Each agent's colour is a ramp slot, and the app themes itself to whoever you're talking to**, with `light-dark()` picking a different step per scheme.

---

## 2. Naming / renaming

### 2.1 The observed system pill
`bot-dom.html`, transcript, immediately after the user's job description:
```html
<div class="baby-grok-bot-entry-enter mt-3 first:mt-0">
  <div class="flex min-w-0 items-center justify-center gap-1.5 overflow-hidden py-1 text-[13px] leading-4"
       style="color: var(--cursor-text-secondary);">
    <span class="truncate">Renamed to Sales Outbound</span>
  </div>
</div>
```
Centered, 13 px, secondary ink, its own transcript entry (rendered: `anim-hero-02.png`). Same primitive as **"Created routine 🕐 Overnight outbound"** (`anim-hero-20.png`, `mobel-babygrokbot.png`) — so this is a general **system-event line**, not rename-specific chrome. CSS: `.baby-grok-bot-system-pill` (999 radius, `padding: 1px 7px 1px 3px`, `gap: 4px`, weight 500) and `.baby-grok-bot-system-agent` — the *interactive* variant: `button.baby-grok-bot-system-agent { cursor: pointer }`, hover → `background: var(--grok-bot-system-agent-pill); color: var(--grok-bot-system-agent-ink)`. **Agent names inside system lines are clickable chips that navigate to that bot.**

### 2.2 Who renamed it
**The bot renamed itself.** Chain of evidence:
1. `new-bots.md`: a new bot is "named **New Agent**" at creation.
2. Replica transcript order (`dom-text.txt:61-65`): bot greets *"Hey Armand, good to meet you. What do you want me around for? Anything concrete, or more of a general sidekick?"* → user types the job → **"Renamed to Sales Outbound"** → bot goes to `Thinking`.
3. No user action sits between the message and the rename; nothing in the transcript is a form submission; and the phrasing is agentless passive ("Renamed to X"), the same voice as "Created routine X" and "Updated memory for ⬤ Account Manager" (`dom-text.txt:93-94`, `crop-many-bots.png`) — both unambiguously bot-authored.

**Both paths exist.** User-initiated rename documented twice: `new-bots.md` "Open the Bot menu to change its name or description"; `new-settings-and-notifications.md` "…**Agent settings** … Name, title, and description". The system pill is the **audit line for either author** — the transcript is the single log of identity changes.

### 2.3 Display name vs identity
**Grok has no visible slug.** No handle, no `@sales-outbound`, no id anywhere in the DOM, the docs, or any capture. `@`-mentions render as the *display name* with the bot's face inline (`.baby-grok-bot-message-mention` + `.baby-grok-bot-message-mention__face`, `height: 1lh`, `margin-right: 4px`). Consequence: **renaming silently rewrites every mention, and there is no stable user-facing identifier to automate against.** A deliberate "it's a person, not a record" stance — and a real cost.

Name changes appear to animate rather than snap: both the row and header name spans carry `style="…opacity: 1; transform: none;"` (`bot-dom.html`), i.e. motion-driven elements whose steady state is the identity.

---

## 3. Roster organization

### 3.1 Structure — a flat chat list, nothing more
`bot-dom.html`, sidebar top→bottom:
```
aside.baby-grok-bot-sidebar                       (280px, resizable, translucent rgba(251,251,251,0.35))
├── .baby-grok-bot-sidebar-header                 (44px)  → traffic-light spacer + ONE action: aria-label="New agent"
├── label.baby-grok-bot-chat-search               (32px, radius 10, bg rgba(0,0,0,.05))
│     └── input[type=search][aria-label="Search chats"][placeholder="Search"]
├── .baby-grok-bot-sidebar-list                   (flex-1, scroll, pad 0 10 8 16, masked top/bottom fade)
│     └── div.flex.flex-col.gap-0.5
│           └── button.baby-grok-bot-agent-row ×7   ← FLAT. no <ul>, no headings, no <details>
└── .baby-grok-bot-sidebar-footer                 (user avatar "AS" + "Armand Segall")
```
Plus `<div aria-label="Resize sidebar" role="separator" aria-orientation="vertical" class="absolute inset-y-0 -right-1.5 w-3 cursor-col-resize">`.

**FINDING (absence): no folders, no sections, no tags/labels, no colour-groups, no saved views, no filters, no sort control, no manual reordering.** The only structural affordance is the pinned/unpinned split (§3.3). Bots and group chats live in **one undifferentiated list** — a group chat is just another row (`title="Offsite crew"`, 3-face avatar) sitting between two bots.

### 3.2 Row anatomy (exact — `bot-styles.json:res` computed styles + DOM)
`254 × 53 px`, `border-radius: 10px`, `padding: 8px`, `gap: 8px`, rows `gap-0.5` apart.
- avatar `32×32`, wrapper `border-radius: 9999px`.
- line 1: name `14px/20/−0.15px`, truncate + `flex-1` · right: `.baby-grok-bot-agent-row__time` `12px/16`, ink `rgba(20,20,20,.4)`, `shrink-0`.
- line 2: `h-4` strip, `12px/16`, secondary ink — the **last message preview** *or* a live status string. In the replica the active row's line 2 is `Typing…` (`bot-dom.html`), later `Checking what's connected. H…` (`anim-hero-02.png`) then `Done.` (`anim-hero-20.png`) — a live-updating field, not a static snippet.
- active row: `button[data-active]` → `background: var(--grok-bot-sidebar-selected)` (computed `rgba(10,10,10,0.055)`).
- `title="<name>"` native tooltip on every row.
- Responsive: `.baby-grok-bot-agent-row__body { container-type: inline-size }` + `@container (max-width:160px){ .baby-grok-bot-agent-row__time { display:none } }` — **the timestamp is the first thing to go when the sidebar narrows.**
- Entry animation: `.baby-grok-bot-agent-row--enter { animation: .45s cubic-bezier(.22,1,.36,1) both baby-grok-bot-row-enter }`.

### 3.3 Pinning
DOCS (`new-bots.md`, "Pin or hide a Bot"):
> * **Pin** active Bots to keep them at the top of the sidebar.
> * **Hide from sidebar** removes a Bot from the main list without deleting its work.
> * Open **Show hidden chats** at the bottom of the sidebar, then choose **Unhide**, to restore a hidden Bot.
> Hiding does not pause the Bot or its routines.

CSS confirms a first-class divider: `.baby-grok-bot-sidebar-pinned-divider { background: var(--grok-bot-sidebar-separator); height: .5px; margin: 6px 4px }` — a hairline rule, **not** a "Pinned" text header. The pinned block is visually implicit, Slack/Messages-style.

**The pinned-tiles variant is real and separate from pinned rows:**
`.baby-grok-bot-pinned-tile { border-radius: 12px; flex-direction: column; align-items: center; gap: 6px; width: 68px; min-width: 0; padding: 6px 4px }` + `[data-active] { background: var(--grok-bot-sidebar-selected) }`. A 68 px column tile (avatar over name) → pinned bots can render as a **horizontal tile strip above the list** (the iMessage pattern). Not captured in any screenshot; the class exists but is un-instantiated in `bot-dom.html`. High confidence it ships (own active state + radius), unknown when it's chosen over rows.

iOS: `new-mobile.md` — "**Swipe actions** provide quick access to common conversation controls such as pin and hide."

### 3.4 Collapse mode
A real avatar-only rail, one attribute on the aside:
```css
.baby-grok-bot-sidebar[data-collapsed] .baby-grok-bot-agent-row { justify-content:center; padding:6px }
.baby-grok-bot-sidebar[data-collapsed] .baby-grok-bot-agent-row__body,
.baby-grok-bot-sidebar[data-collapsed] .baby-grok-bot-agent-row__unread { display:none }
.baby-grok-bot-sidebar[data-collapsed] .baby-grok-bot-sidebar-list { padding-inline:6px; scrollbar-width:thin }
.baby-grok-bot-sidebar[data-collapsed] .baby-grok-bot-sidebar-list::-webkit-scrollbar { width:3px }
.baby-grok-bot-sidebar[data-collapsed] .baby-grok-bot-sidebar-footer { flex-direction:column; gap:6px; padding-inline:0 }
.baby-grok-bot-sidebar[data-collapsed] .baby-grok-bot-sidebar-footer__name { display:none }
```
Captured: **`mobel-babygrokbot.png`** — the rail with 7 marks (teal circle; orange circle *active, on a rounded-square selection plate*; indigo triangle; violet squircle; blue circle; orange circle; 3-face group), a `+` above the footer, and the human's `AS` chip at the bottom. Strongest argument for shape-not-just-colour: **in collapsed mode the mascot IS the entire label.**
Note it explicitly **hides the unread element** — collapsed mode trades attention signal for density. Arguably a bug; do not copy.

### 3.5 Search
Affordance: `input[type=search][aria-label="Search chats"][placeholder="Search"]`, 32 px, always visible, directly under the header — not behind a shortcut, not a modal.

What it matches (DOCS, `new-chat-and-collaboration.md`, "Find prior work"):
> Use the search or command palette to:
> * Switch between Bots and groups
> * Find prior messages
> * Find files, links, and routines
> * Open settings and common actions
> * Jump back to the matching place in a conversation
>
> Search availability can vary during rollout. If cross-conversation results are not available, open the relevant Bot and use its conversation history.

iOS (`new-mobile.md`): "…find conversations and available **message, file, link, or routine** results."

So: a **unified entity search** — conversation names + transcript content + attachments + links + routines + app commands — that **deep-links back into the matching position in the transcript**. Result rows reuse the picker primitives (`.baby-grok-bot-compose-results` / `-result[data-highlighted]`): **sidebar search, the New-chat picker and the command palette are one component.** The "availability can vary during rollout" line is xAI admitting cross-conversation search wasn't fully shipped at launch.

### 3.6 Unread / badges
- Element: `.baby-grok-bot-agent-row__unread` (referenced only in the collapsed-mode hide rule; its own styling is inline/token-driven).
- Rendered: **a single red dot at the top-right of the avatar, no count** — `crop-roster.png`, "Inbox Manager" (indigo triangle) carries it; no other row does. Same-frame proof it's state not decoration: the same bot has *no* dot in `mobel-babygrokbot.png`.
- **No numeric badge anywhere in the roster.** The only counted badge in the system is the OS **dock badge** (§8).

### 3.7 Sort order — the honest answer
**Undocumented, and the replica is not evidence.** Docs state only "Pin active Bots to keep them at the **top** of the sidebar" (`new-bots.md`) — pinned-first is the sole stated rule. Nothing states the ordering of unpinned bots.

The replica's order is **provably art-directed, not recency**: Chief (`Yesterday`) sits at #1 above Sales Outbound (`1:47 PM`), and Expense Manager (`9:47 AM`) sits *below* Talent Scout (`5:47 AM`) — timestamps visible in `crop-roster.png` / `anim-hero-20.png`. Neither recency, nor alphabetical, nor grouped. Do not model behaviour on it.

Inference (medium confidence): Messages/Slack-style **pinned-first, then most-recent-activity**, hairline between the blocks. But state plainly: **Grok Bot exposes no sort control to the user at all** — no such affordance in the DOM, the class list, or any doc.

---

## 4. Group chats

### 4.1 Creation
DOCS (`new-chat-and-collaboration.md`):
> 1. Choose **New** in the sidebar.
> 2. In **New chat**, select **two to six Bots**.
> 3. Open the group, then **edit its generated name** if needed.
> 4. Describe the shared outcome and who owns the next step.
>
> On iPhone, use **+ → New Group Chat**. **Group membership can be edited later.**

The multi-select in the same "New chat" picker *is* the group constructor: 1 pick = a DM, 2–6 = a group. **The group name is auto-generated at creation** (the replica's is "Offsite crew" — informal and human, not "Chief + Inbox Manager + Account Manager").

**Limit:** 2–6 members. **Cap:** "An account can have up to **50 Bots and group chats combined**" (`new-bots.md`) — groups consume roster budget.

### 4.2 Routing semantics
> * Write normally to let the participating Bots **decide who should respond**.
> * Type `@` and select a Bot when one teammate owns the request.
> * Mention multiple Bots when the request genuinely needs each of them.
> * Use `@everyone` **sparingly** for a group-wide update.

**Self-routing is the default; `@` is an override.** The docs' own kickoff example is a three-way explicit assignment:
> @Researcher gather the source material and link every claim. @Writer turn the findings into a launch draft. @Reviewer check the draft against the sources and list only blocking issues. Do not publish anything.

Known asymmetry, stated: "Your messages in a group can include attachments. **Bot-to-group handoff messages are currently text-only**, so a Bot should send an image directly to another Bot when that teammate must inspect it."
Also stated: "Ask for a single owner at each stage. **Too many parallel handoffs can create duplicate work and noisy updates.**" — xAI documenting its own fan-out failure mode.

### 4.3 The group avatar (exact construction)
From `bot-dom.html`, the "Offsite crew" row — a 32×32 relative box, three 18×18 absolutely-positioned marks:
```
mark 1  left: 7px  top: 0px   z-index:1   --fg:#54B9A6   (Chief, teal circle)
mark 2  left: 0px  top: 14px  z-index:2   --fg:#6464EF   (Inbox Manager, indigo triangle)
mark 3  left: 14px top: 14px  z-index:3   --fg:#885CF5   (Account Manager, violet squircle)
each: overflow:hidden; border-radius:9999px; box-shadow: 0 0 0 2px var(--cursor-bg-elevated, #fff)
```
A **triangular 1-over-2 cluster with a 2 px page-coloured ring on each face**, composited from the *actual member marks* — shape and colour preserved (`crop-roster.png`, bottom row). Only three faces regardless of member count (max 6); no "+3" overflow chip.

### 4.4 A group's identity vs its members'
A group is **thin by design**:
- ✅ has: a (generated, editable) name, a composite avatar, a membership list, a transcript, a roster position, pin/hide, search, `@everyone`.
- ❌ has NOT: a description/job field (descriptions attach only to Bots), a settable avatar, its own memory (`new-faq.md`: "**A Bot** can retain stable preferences, role context…"), its own routines (`docs-skills…`: "A **routine** assigns a workflow to **one Bot**"; "Deleting a Bot also removes routines owned by that Bot"), its own screen on the computer ("**Each Bot** gets its own screen"), or a per-conversation notification switch (`new-settings-and-notifications.md`: "**Group chats do not have the same per-Bot notification switch.**").
- ❌ **cannot contain humans.** HN, comparing to Block's Buzz (`hn-49261514.txt:382`):
  > "It seems like Grok Bot is just a personal agent swarm. … I just assumed it was like Buzz at first, allowing you to invite other humans to work with the bots. **Bot-to-bot only group chat is useful**, but I also really love Buzz's vision for team collaboration with many humans and many bots in the same chat interface."
  Corroborated structurally by `docs-teams-and-enterprises.txt`: every member gets their own computer and their own Bots; nothing there shares or co-owns a Bot or a group. Grok's "team" is a *billing/policy* boundary, not a collaboration surface.

→ **A group is a routing context, not an agent.** Its identity is entirely derived from its members.

### 4.5 How handoffs render
Three distinct primitives, all captured:
1. **Direct 1:1 handoff (no group).** `new-chat-and-collaboration.md`: "A Bot can send an asynchronous message to another Bot. The receiving Bot wakes, handles the request, and can reply later. **You can see the handoff in the conversation.**"
2. **The in-flight pill.** `clean-stage3-03.png` / `crop-many-bots.png`: `[sender faces] ( ●●● Sending to Chief… ) [recipient face]` — sender marks stacked left, a rounded pill with a 3-dot typing animation, text in the *recipient's* accent colour, recipient mark on the right, each mark ringed. Verb varies with handoff type (`dom-text.txt:97-104`): "Asking Research…", "Looping in Comms…", "Sending to Chief…", "Pinging Travel…".
3. **The arrival divider + inline mentions.** `anim-hero-20.png`, centred above the incoming block:
   `Messages from  ⬤ Account Manager  and  ⬤ Chief`
   then the body opens with coloured chips: `⬤ Account Manager sent over the Acme + Globex threads and ⬤ Chief flagged the priority accounts.` Each chip = mark + name in that bot's colour (`.baby-grok-bot-message-mention` + `__face`), and per the CSS the chip is a hoverable button (`.baby-grok-bot-system-agent`) that navigates.
   → **Cross-agent provenance is rendered in the receiving bot's transcript, in the sender's colour, at the point of arrival.** The single most transferable idea in the product.

---

## 5. Lifecycle

### 5.1 Hide (Grok's "archive")
- "**Hide from sidebar** removes a Bot from the main list **without deleting its work**." Restore via "**Show hidden chats** at the bottom of the sidebar" → **Unhide**.
- "**Hiding does not pause the Bot or its routines.**" ← a *visibility* filter only. A hidden bot keeps running schedules, keeps consuming usage, can still message you.
- `docs-approvals-security-and-privacy.txt` ("Remove access and working data") treats hide as the soft half of decommissioning: "Pause or delete related routines. … **Hide or delete Bots** that should no longer appear in Grok Bot."
- **FINDING (absence): no separate archive concept, no archive view beyond the hidden-chats disclosure, and no bulk operations of any kind.**

### 5.2 Delete
`new-bots.md`:
> Deleting a Bot removes its **active profile, conversation, and routines** from Grok Bot. **Shared computer files and sign-ins are not isolated by Bot and may remain on the computer.** Backend retention follows the applicable Cursor terms.
> If you may need the work later, hide the Bot instead.

`docs-skills-routines-and-automations.txt`: "Deleting a routine is immediate and has **no undo**. **Deleting a Bot also removes routines owned by that Bot.**" `new-faq.md` repeats it. **No trash, no undo, no export-before-delete.**

The blast-radius asymmetry is the notable fact: **deleting the agent does not delete its side effects** — logins, cookies, `/workspace` files, and anything already done in external systems survive.

### 5.3 Duplicate
`new-bots.md`:
> Duplicate a Bot when you want the same role as a starting point for a different scope—for example, one Account Health Bot per region.
> The copy is named "`<name>` copy" and carries the **profile, settings, enabled skills, routines, and avatar**. It does **not** copy conversation history, learned memory, or chat attachments. Rename it and provide the new scope before assigning work.

This is the templating story: **a bot is its own template.** Copying *routines* but not *memory* is a deliberate and correct split — config is portable, earned context is not.

---

## 6. Routines & skills as management surfaces

### 6.1 IA placement
| Thing | Scope | Where it lives |
|---|---|---|
| **Skill** | **Global** ("Skills are available across your Bots") | authored in chat ("save the process we just used as a skill called …"); managed at **Settings → Plugins** (**Marketplace** to discover, **Yours** for installed plugins & private skills). Per-bot enable: "Installed private skills can be enabled per Bot. If a skill does not appear in the `/` menu, open it under **Settings → Plugins → Yours** and enable it for the current Bot." |
| **Routine** | **Per-bot** ("A routine tells **one Bot** when to run a workflow") | **Bot → View conversation details → Routines** |
| **Connector/plugin** | **Account-wide** ("Installed connectors are account-wide. Their availability is not isolated to one Bot.") | Settings → Plugins |

**Global capability, per-agent schedule, account-wide access.** Clean, and worth copying wholesale.

Routine actions (`docs-skills…`): enable/pause · **Test run** · edit schedule/instructions · inspect recent success & failure history · delete. Mobile is read-mostly (`new-mobile.md`): inspect schedule/next-run/instruction and toggle **Active**; "Editing the schedule or instruction, viewing run history, testing, and deleting a routine currently require the desktop app."

### 6.2 The limits (verbatim)
> A Bot can own up to **50 routines**, and the app keeps the **20 most recent run records** for each routine.
> An account can have up to **50 Bots and group chats combined.** (`new-bots.md`)
> The desktop composer accepts up to **six attachments** at a time. Documents/images/audio ≤ **25 MB**, videos ≤ **200 MB**. (`new-files-and-results.md`)
> Teaching records visible computer interaction for up to **ten minutes**. (`docs-skills…`)

### 6.3 The routine chip in the transcript
`anim-hero-20.png` / `mobel-babygrokbot.png`: **`Created routine  🕐 Overnight outbound`** — centred system line, clock glyph, routine name as a chip; same `.baby-grok-bot-system-pill` family as "Renamed to …". What triggered it in the replica: the user typed *"The top 10 look good. Send it. **Run this every week.**"* → the bot created the routine and logged it. **Automation is created conversationally and confirmed as a transcript artifact**, not in a scheduler UI.

### 6.4 "Teach a task"
Opened from **a one-to-one Bot conversation + its computer view** → "Teach a task" → describe the intended result → perform the workflow once → stop → review the drafted skill → test on a safe example before scheduling. Constraints: browser workflows only, ≤10 min, no microphone audio, "the learned skill is a **draft**", gradual rollout, and **not on iPhone** (`new-mobile.md`). Explicitly **not** available in a group chat.

### 6.5 Idle-routine pausing
> To control unattended usage, Grok Bot **may ask whether to keep routines running after a long period away and pause them if there is no response.** Review paused routines when you return. (`docs-skills…`)

A dead-man's-switch on automation. Where the prompt appears is unspecified. FINDING (partial absence).

---

## 7. Cross-agent addressing — full `@` semantics

Canonical (`docs-skills…`): "Type `/` in the desktop composer to reference a saved skill; use `@` for **Bots, groups, routines, and connectors**." Restated in `new-chat-and-collaboration.md` and `docs-computer-and-apps.txt` ("In chat, type `@` to attach the connector to the task. Type `/` to reference a saved skill").

The popover: `.baby-grok-bot-mention-popover { z-index:30; border:.5px solid var(--grok-bot-border-default); background: var(--cursor-bg-elevated); border-radius:10px; min-width:190px; max-width:280px; position:absolute; bottom: calc(100% + 10px); left:-6px; box-shadow: 0 1px 2px #0000000f, 0 14px 36px -10px #00000047 }` — opens **upward** from the composer, narrow, and reuses `.baby-grok-bot-compose-results/-result` with tighter padding (`4px 6px`, radius 6, gap 7). **One picker, four entity types, three call sites.**

| `@` type | In a 1:1 chat | In a group | Evidence / confidence |
|---|---|---|---|
| **Bot** | Addresses *another* bot → an **asynchronous handoff**: "The receiving Bot wakes, handles the request, and can reply later. You can see the handoff in the conversation." | Assigns the request to that member; suppresses self-routing. | DOCS, high |
| **Group** | Sends work *into* a group conversation from elsewhere. | — | DOCS list groups as `@`-able; **resulting behaviour never described.** FINDING (absence) |
| **Routine** | Presumably "run / use this saved workflow". | same | DOCS list it; **no doc anywhere states what mentioning a routine does.** FINDING (absence) |
| **Connector** | "**attach the connector to the task**" — scopes this turn to a specific tool instead of letting the bot choose. | same | DOCS (`computer-and-apps`), high |
| **`@everyone`** | n/a | group-wide broadcast, "use sparingly" | DOCS, high; also iOS |
| **`/skill`** | separate namespace, not `@` | same | DOCS, high |

Chip colour is deliberately asymmetric: while typing, `.baby-grok-bot-mention` uses the **current agent's** accent (`color-mix(… --grok-bot-current-agent-accent 14% …)`); inside a *delivered* message, `.baby-grok-bot-message-mention` uses the **mentioned** bot's colour + face (`anim-hero-20.png`: violet "Account Manager", teal "Chief").

---

## 8. Notifications / attention model

Canonical (`new-settings-and-notifications.md`, "Understand attention states"):
> The Bot list distinguishes:
> * **Needs attention** for a question, approval, or handoff
> * **Unread activity** for a new result
> * Working or typing status
>
> Opening a conversation marks its current activity as read. Use the Bot menu to **mark a conversation read or unread manually**.

Three levels — and **"needs attention" is a distinct roster-level state from "unread"**, driven by *question | approval | handoff*.

Surfaces:
- **Row line 2 carries working/typing status as text**: `Typing…` (`bot-dom.html`), `Checking what's connected. H…` (`anim-hero-02.png`), `Done.` (`anim-hero-20.png`). No separate spinner — the preview line *is* the status line.
- **Row avatar** carries the red unread dot (§3.6) and the mascot's own `data-state` animation.
- **Approval requests land in the transcript, not the roster**, as a card + badge: `Computer` card with `⟳ Action needed` (`anim-hero-02.png`) → `.baby-grok-bot-card-badge[data-tone=warning] { background: color-mix(in srgb, var(--grok-bot-text-warning) 14%, transparent); color: var(--grok-bot-text-warning) }` with a 5 px `__dot`. Tones: `info | warning | success | accent | muted`. Actions render as buttons under the card: **Take over / I'm done** for takeovers; **Allow once / Deny / Always allow** on desktop, **Approve once / Deny** on iPhone (`docs-approvals-security-and-privacy.txt`). Also seen: `☀ Working` (`clean-stage0-04.png`).
  → **The roster only says "needs attention"; the *what* lives in the conversation.** No approval inbox, no cross-bot queue, no "3 pending approvals" surface anywhere. FINDING (absence) — and, at 50 bots × 50 routines, a genuine scaling gap.
- **OS notifications are per-bot opt-in**: "Turn on **Notifications** in a Bot's settings to receive an operating-system or mobile notification when that Bot finishes or needs input. **Group chats do not have the same per-Bot notification switch.**" Suppression: "Notifications are normally suppressed while Grok Bot is focused. The **sidebar and dock badge** still show unread activity." iOS: device permission **and** the bot's setting must both allow; "Mobile push delivery is rolling out and may not yet be enabled for every account."
- **In-app errors are a fourth, separate channel**: "Errors appear above the composer in **Notifications**. You can dismiss one notice or clear the list. Some notices include **Copy request ID**." — "Clearing a notice removes the notification, not the underlying external action or Bot history."
- **Idle-routine pause prompt** — §6.5.
- Troubleshooting confirms the roster is a first-class status surface: "A Bot appears stuck → **Check the status shown in the sidebar and conversation.**" (`new-troubleshooting.md`).

---

## 9. Outside voices (HN + reviews) on management UX

- **Per-domain separation is the value, and it's felt.** `hn-49261514.txt:152` (jjcm, month-long early-access user):
  > "Biggest advantage is **each one owns its own routines, context, and domain**, and they can communicate between each other. … by keeping the bots separated by domains, you end up getting **better results** out of them. Additionally though each one has their own computer, which means async work feels like it actually works. **I haven't had to juggle worktrees for the last month.**"
- **Anthropomorphising the roster reads as correct UX.** `hn:150`: "I think the **humanization of the agents is cute and makes sense UX wise**."
- **Bot-to-bot-only groups are a noticed limitation** — §4.4, `hn:382`.
- **A named agent gets treated as a real assignee.** `hn:408`: "I can **assign a bug to 'Axiom' (it named itself)** in YouTrack and the email notification causes it to wake up and start work." Independent corroboration that **self-naming** is a natural pattern, not an xAI quirk.
- **Reviewer summary of the management surface** (`eesel.plain.txt`): "Skills are reusable method definitions, routines schedule them, and a Bot can own up to 50 routines with the 20 most recent run records kept per routine. **Group chats take two to six Bots and let them self-route, or you address one with @.** Bot-to-Bot handoffs are asynchronous, and you can see them in the conversation."
- **No audit log.** `eesel.plain.txt`: "Does Grok Bot have an audit log? **Not yet.**" — consistent with the transcript *being* the log.
- **Cost blindness** is the top substantive criticism (`hn:152` "I've used more tokens this month than not this month"), with **no usage-per-bot surface** in the roster. FINDING (absence).

---

## 10. Consolidated absence list — what Grok Bot does NOT have

1. **No folders, sections, groups-of-bots, or nesting.** One flat list.
2. **No user-controlled tags, labels, or colour categories.**
3. **No sort control.** Pinned-first is the only stated rule; the default sort of unpinned bots is undocumented.
4. **No manual drag-reordering.**
5. **No filters or saved views** (no "needs-attention only", no "running only").
6. **No bulk operations.** One bot at a time, everywhere.
7. **No archive distinct from hide**; no trash, no undo on delete, no export.
8. **No cross-bot dashboard**: no approval inbox, no run/queue board, no per-bot usage meter, no audit log.
9. **No stable identifier / slug / handle.** Display name is the only identity.
10. **No humans in group chats**; no sharing a Bot with a teammate; no org bot library (the marketplace carries skills & plugins only).
11. **No numeric unread counts** (dot only); collapsed mode hides unread entirely.
12. **No group-level description, avatar, memory, routines, or notification switch.**
13. **No documented avatar-picker inventory** and no documented initial-avatar rule.
14. **No documented surface for the "title"/job field.**
15. **No documented semantics for `@group` or `@routine`.**
16. **No Linux desktop, no Android, no iPad** (`new-faq.md`).

---

## 11. Mapping table — Grok paradigm → supermux equivalent → adopt / adapt / skip

supermux concepts referenced: `sessions(name` slug PK`, display_name, desc, tags[] JSON, pinned, archived, provider, team_name, dir, branch, worktree, creator, task_summary, last_send, …)` (`server/migrations/0001_init.sql`, `0017`, `0019`); overview user-groups + section headers + sort modes `smart | alpha | custom` (`web/src/lib/sort-modes.ts`, `web/src/lib/overview-layout.ts`, `web/src/components/focus-mode/focus-strip-groups.ts`); board issues (`0002`, `0013`); delegate API (`0005_delegations.sql`, `POST /api/agents/delegate`); schedules (`0003`, `0014`, `0020`); teams (`0016`, `0017`, `0022`); web-push (`0012`); command palette (`web/src/components/command-palette/`); hosts (`0018`); audit (`0007`).

| # | Grok paradigm | Evidence | supermux equivalent | Verdict | Reason |
|---|---|---|---|---|---|
| 1 | Single `+` "New agent" in the sidebar header; no creation modal — bot opens empty as "New Agent" | `bot-dom.html` `aria-label="New agent"`; `new-bots.md` 1–3 | session-create flow | **Adapt** | Keep one `+`. But create *must* keep `dir`/`provider`/`worktree` — not cosmetic. Adapt to: `+` → picker with "New session" as the top row; defaults chosen, identity filled in later. |
| 2 | "New chat" picker doubles as group constructor (1 pick = DM, 2–6 = group) | `new-chat-and-collaboration.md` | — | **Skip** | supermux has no multi-session chat room; teams are hierarchical (lead + teammates), not a peer group. Don't retrofit. |
| 3 | Name + **job title** + description triple | `docs-get-started.txt` §3 | `display_name` + *(none)* + `desc` | **Adapt** | Adopt name/desc (already have). Skip the separate "title" — Grok can't even show where it renders (§1.2); `task_summary` already occupies that slot, live. |
| 4 | **Description = durable rules, message = this task** | `new-bots.md` | `desc` (free label today) | **Adopt** | Zero-cost doctrine change, real payoff: promote `desc` to "standing instructions for this session", surface it in the chat header. Pairs with CLAUDE.md/AGENTS.md. |
| 5 | Mascot avatar: one mark, per-agent **shape × colour × eye-style**, tinted via `--fg` | `bot-dom.html` hexes; `crop-roster.png`; `mobel-babygrokbot.png` | provider glyph + status colour only | **Adopt** | Highest-leverage single borrow. Deterministic identity mark per session (hash of the immutable `name` slug → shape+hue slot). Survives 18 px, collapsed rails, mobile, colour-blindness. `brand/` can source the marks. |
| 6 | **Whole-app tint follows the focused agent** (`--grok-bot-current-agent-{tint,bubble,accent,coat}`) | `bot-dom.html` root vars + `grokbot-rules.css` consumers | — | **Adapt** | Adopt as a *narrow* accent (focus header, mention chips, composer ring, side-pane wash ~6%), not a full re-theme. supermux status colours (active/waiting/idle) must stay unambiguous — an agent hue colliding with "waiting amber" is a regression. Scope to non-semantic surfaces. |
| 7 | **Mascot `data-state="thinking"`** — the avatar *is* the activity indicator | `bot-dom.html` `<svg class="grok-bot-mark" data-state="thinking">` | separate status dot/spinner on tiles | **Adopt** | Replaces chrome with identity. Map supermux's richer states (active/waiting/idle/stopped/rate-limited) onto mark states, keep existing colour semantics. |
| 8 | **Self-renaming**, logged as a transcript system line ("Renamed to Sales Outbound") | `bot-dom.html`; `dom-text.txt:61-65`; `new-bots.md` | `display_name` (user-set); `task_summary` (auto) | **Adopt** | supermux is *already* architected for it: `0019_session_display_name.sql` split immutable slug from mutable label precisely so renames are safe. Let the agent propose/apply a `display_name` after the first prompt and log a system line. Cheapest "feels alive" win. |
| 9 | No slug/handle at all; display name is identity | §2.3 | `name` slug (PK, tmux id, `$SUPERMUX_SESSION`, route, hook token) | **Skip (deliberately diverge)** | Grok's biggest structural weakness. supermux's slug is load-bearing for delegate, routes, hooks, scripts. Keep it; just stop *showing* it by default (show `display_name`; reveal slug on hover/detail + copy-for-agent affordances). |
| 10 | System-event lines as first-class transcript entries ("Renamed to…", "Created routine…", "Updated memory for ⬤ X") | `bot-dom.html`; `anim-hero-20.png`; `crop-many-bots.png` | — (chat renderer P1–P9) | **Adopt** | Add a `system-event` primitive: centered, 13 px, secondary ink, optional glyph + clickable entity chip. Home for events the terminal buries: rename, schedule created, board issue linked, delegation sent, worktree created, model/mode change, compaction boundary. |
| 11 | Clickable agent chips inside system/message text (`.baby-grok-bot-system-agent` hover → pill) | `grokbot-rules.css` | — | **Adopt** | Cheap; supermux has more entities to chip: session, board issue, schedule, host, team. |
| 12 | Row anatomy: 32 px mark · name · relative time · live preview/status line | `bot-styles.json:res` (254×53, r10, p8, g8); `crop-roster.png` | tiles + focus strip + picker | **Adopt** | Adopt the two-line row with a **live** third field for strip/picker/mobile. The plan's `chat_tail` (§2.5) *is* Grok's line 2. Keep tiles for the overview grid. |
| 13 | `@container (max-width:160px)` hides the timestamp first | `bot-css.txt` | — | **Adopt** | Trivial, correct, and supermux's strip is resizable. Container queries over media queries. |
| 14 | Sidebar collapse → avatar-only rail (`[data-collapsed]`) | `grokbot-rules.css`; `mobel-babygrokbot.png` | focus strip (has modes) | **Adapt** | Adopt the rail. **Do not** copy `[data-collapsed] .agent-row__unread{display:none}` — hiding attention state to save 8 px is a bug. Keep the dot collapsed. |
| 15 | Pinned-first + hairline `.sidebar-pinned-divider` (no "Pinned" header) | `grokbot-rules.css` | `pinned` + `idx_sessions_pinned(pinned DESC, last_send DESC)` | **Adopt** | supermux already sorts exactly this way at the index level. Adopt the *hairline* rather than a text header in strip/picker. |
| 16 | `.baby-grok-bot-pinned-tile` — 68 px avatar tiles for pinned items | `grokbot-rules.css` | — | **Adapt** | Good pattern for a **mobile** roster header (pinned sessions as a horizontal mark strip). Low priority; unproven in any capture. |
| 17 | **Flat list; no folders/sections/tags/sort control** | §3.1, §10 | user groups w/ section headers + 3 sort modes + drag + `tags[]` + team cards | **Skip — supermux is already ahead** | Adopting Grok's roster IA would be a **downgrade**. `focus-strip-groups.ts`/`overview-layout.ts` already deliver grouping+sorting Grok has no answer for. Borrow Grok's *row craft*, not its *information architecture*. |
| 18 | Always-visible sidebar search over conversations + messages + files + links + routines + commands, deep-linking into the transcript | `bot-dom.html` `aria-label="Search chats"`; `new-chat-and-collaboration.md` | `command-palette/` (hidden ⌘K) | **Adapt** | Adopt the *scope* (sessions + transcript + files + schedules + board issues + actions) and the **jump-to-position-in-transcript** result type — newly possible with the chat renderer. Keep the palette as the power path; add a persistent search field to strip/mobile roster. |
| 19 | One picker component for search + new-chat + `@`-mention (`.compose-results/-result[data-highlighted]`) | `grokbot-rules.css` | palette + session-picker + host-picker (separate) | **Adopt** | Consolidation is what makes it feel like one product. Concretely: one `<EntityPicker>` with a typed result union (session, issue, schedule, file, snippet, action). |
| 20 | Unread = **single red dot on the avatar**, no counts; opening marks read; manual mark read/unread | §3.6; `new-settings-and-notifications.md` | — | **Adapt** | Adopt dot-on-the-mark placement. Keep a **count** where meaningful (queued steering messages, pending board issues) — Grok's countless dot is a consequence of its 50-item cap; supermux runs more sessions with more discrete pending items. |
| 21 | **Three-tier attention model**: *needs attention* (question/approval/handoff) > *unread activity* > *working/typing* | `new-settings-and-notifications.md` | `last_status ∈ active\|waiting\|idle\|stopped\|unknown` + Attention card (plan §2.7) | **Adopt (align vocabulary)** | Better user-facing vocabulary than raw process status. Map: needs-attention ← `waiting` + permission-request + inbound delegation; unread ← new transcript entries since last view; working ← `active`. Align the plan's Attention card to the same three tiers. |
| 22 | Approvals live **only in the transcript**; no cross-agent approval inbox | §8, §10 | Attention card (per-session) | **Adapt — and beat it** | Adopt the in-transcript approval card (already planned). **Diverge** by adding the roster-level rollup Grok lacks; the overview is the right place, and permission-prompt blindness is known supermux pain. |
| 23 | Per-bot OS notification opt-in; suppressed while app focused; dock badge still updates; groups have no switch | `new-settings-and-notifications.md` | `push_subscriptions` + PWA | **Adopt** | Per-session toggle + focus-suppression + badge is exactly right and cheap; web-push already exists. |
| 24 | **Hide from sidebar** ≠ pause; "Show hidden chats" at list bottom → Unhide | `new-bots.md` | `archived` + `components/archived/` | **Adapt** | supermux `archived` is closer to Grok's *hide* than a true archive — align the language ("Hidden"/"Show hidden") and adopt the explicit contract that **hiding does not stop schedules**. Then decide deliberately whether supermux archive *should* pause `schedules` (Grok's choice is arguably wrong; state it either way in the UI). |
| 25 | **Delete removes profile + conversation + routines; side effects survive**; no undo; "hide instead" | `new-bots.md`, `new-faq.md`, `docs-skills…` | session delete (CASCADE across 10+ child tables) | **Adopt the honesty, not the finality** | Adopt the explicit "what delete does / does not remove" copy in the confirm dialog (worktree? branch? board issues? schedules? delegations?). **Keep** an undo window — Grok's no-undo is a liability, not a paradigm. |
| 26 | **Duplicate** → `"<name> copy"`, carries profile/settings/skills/routines/avatar, **not** history/memory/attachments | `new-bots.md` | — | **Adopt** | Genuinely missing and clearly useful: clone `desc`, `tags`, `provider`, `flags`, `mcp`, `auto_continue*` and `schedules` into a fresh slug + new worktree, without transcript. "One session per region/repo/branch" is the same use case as "one Account Health Bot per region". |
| 27 | **Skills global · routines per-agent · connectors account-wide** | `docs-skills…`, `computer-and-apps` | snippets (global) · schedules (per-session) · MCP (`mcp` col, per-session) | **Adopt as doctrine** | Already matches on two of three. Make the IA say it out loud: one "Library" (snippets/skills, global, per-session enable), schedules under session detail, MCP/hosts account-wide in Settings. |
| 28 | Routine detail at **Bot → View conversation details → Routines**: pause / test-run / edit / history / delete, keeping the **last 20 runs** | `docs-skills…` | `scheduler/` UI + `schedules` | **Adopt** | Especially **Test run** and **last-N run history incl. failures** — supermux has the plumbing (`0020_schedule_confirm_finish`) but the per-session IA placement + run-history list is the Grok win. |
| 29 | Automation created **conversationally**, confirmed by `Created routine ⏱ <name>` | `anim-hero-20.png` | schedules created in UI only | **Adopt** | With the chat renderer, let "run this every weekday at 8" from the composer create a `schedule` row and emit the system line. Big perceived-intelligence win, small implementation. |
| 30 | Idle-away prompt: "keep routines running?" → pause if no answer | `docs-skills…` | — | **Adapt** | Worth having as an *opt-in* guard for `auto_continue` + schedules on a long-idle instance. Frame as cost control. |
| 31 | `@` popover over **Bots · groups · routines · connectors**; `/` for skills; `@everyone` | `docs-skills…`, `new-chat-and-collaboration.md` | `/api/agents/delegate` (curl-only per CLAUDE.md) + snippets | **Adopt — biggest under-exploited supermux asset** | supermux **already has** cross-agent messaging but it's a curl incantation, invisible in the UI. Put `@` in the composer: `@<session>` → delegate; `/<snippet>` → insert; `@<schedule>`, `@<board-issue>`, `@<host>` as references. Skip `@group` (no groups) and `@everyone` (dangerous fan-out at supermux's session counts — Grok itself warns "use sparingly"). |
| 32 | Handoff **in-flight pill**: `[sender marks] (●●● Sending to Chief…) [recipient mark]`, verb varies | `clean-stage3-03.png`, `dom-text.txt:97-104` | delegation invisible in the UI | **Adopt** | Render an in-flight delegation pill in both transcripts. Varying verb is optional; the *marks-on-both-ends* composition is the substance. |
| 33 | **Arrival divider + coloured mention chips**: `Messages from ⬤ Account Manager and ⬤ Chief`, body opens with those chips | `anim-hero-20.png` | — | **Adopt (top-3 borrow)** | Clearest solution to "who caused this?" in a multi-agent transcript. Directly applicable to delegations, team teammate messages, scheduled-run output. |
| 34 | **Group avatar** = 3 member marks, 1-over-2 cluster, 18 px, 2 px page-coloured ring, z 1/2/3 | `bot-dom.html` exact offsets | team cards | **Adapt** | Use for **team** rows (lead + teammates) in strip/picker where supermux renders a heavyweight card today. Exact geometry reusable as-is. |
| 35 | Group = routing context only: generated name, no desc/memory/routines/notifications, counts toward the cap, bot-only | §4.4 | teams (`team_name`, `dismissed_teammates`) | **Skip (different model)** | supermux teams are Claude-native with a real lead/teammate hierarchy and on-disk config. Grok's flat 2–6 peer group is *weaker*; don't converge. Do borrow the **generated-name-then-edit** trick for team display names. |
| 36 | Caps: 50 bots+groups, 50 routines/bot, 20 run records, 6 attachments | `new-bots.md`, `docs-skills…`, `new-files-and-results.md` | none | **Skip the caps, adopt the *pruning*** | Don't cap sessions. But "keep the last 20 run records per schedule" is a sensible retention default supermux lacks. |
| 37 | Sidebar footer = human identity (`AS` initials + name); agents are marks | `bot-dom.html` `.baby-grok-bot-sidebar-footer` | — | **Adopt** | Establishes the "you are the one human here" frame that makes the roster read as teammates. Cheap; supermux's footer is unclaimed. |
| 38 | No per-bot usage/cost surface (top HN criticism) | `hn:152`; `eesel.plain.txt` | statusline tap → context% + cost (plan §2.3) | **Skip Grok, keep supermux's plan** | Already a deliberate divergence in plan §1. Reinforce: put cost/context on the roster *row*, not just the header — a differentiator Grok visibly lacks. |
| 39 | No audit log; the transcript **is** the log | `eesel.plain.txt` | `0007_audit.sql` exists | **Skip** | supermux already has an audit table. Do surface it *as* system lines in the chat renderer (row 10) — best of both. |
| 40 | Agents can **create other agents** ("i'd spin up a dedicated agent") | `new-bots.md`; `dom-text.txt:55` | delegate can't create sessions | **Adapt — carefully** | Attractive, and `creator` already anticipates provenance. Gate behind explicit approval: supermux has no 50-cap backstop, and per the concurrency rules an agent spawning worktrees unattended is a real hazard. |

---

## 12. Three-sentence takeaway for the plan extension

1. **Grok's agent management is deliberately, almost aggressively thin** — a flat pinned/unpinned chat list with one search box, one `+`, a dot for unread, hide/duplicate/delete, and nothing else; supermux's existing groups + three sort modes + tags + drag already exceed it, so the borrow is **row craft, identity system and event vocabulary, not information architecture**.
2. **Four ideas worth stealing wholesale**: the deterministic *shape × colour × eye-state* mascot as the universal session identity (rows, rails, mentions, group stacks, status); the **transcript-as-management-log** (rename / routine-created / memory-updated / handoff as centred system lines with clickable entity chips); the **arrival divider + sender-coloured mention chips** that make cross-agent provenance legible; and the **one picker for search + create + `@`-mention**.
3. **Where Grok is silent, say so in the plan**: no documented default sort, no avatar-picker mechanics, no surface for the job title, no `@group`/`@routine` semantics, no cross-agent approval or cost surface, and no undo on delete — those are supermux's openings, not gaps to imitate.
