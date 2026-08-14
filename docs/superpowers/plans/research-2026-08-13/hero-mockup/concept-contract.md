# The Grok Bot concept — and the concept contract for supermux's primary interface

Sources read: `deep-3.md` (management paradigms), `deep-2.md` (integration mechanics),
`wfresult-4-*.md` (design system), real pixels `grok/anim-hero-{00,02,08,12,20}.png`,
`grok/dark-hero-00.png`, `grok/mobel-babygrokbot.png`, `grok/mobel-mobilephonescreen.png`,
`grok/crop-many-bots.png`, and our rejected board `b0-mockups-v2/v3-{roster,full}-light.png`.

---

## 1. WHY Grok Bot reads as a team of colleagues and ours reads as a settings list

The difference is not craft. It is **what the interface claims exists behind it.**
Grok Bot claims *people*. Our board claims *processes with labels*. Every pixel then
follows from that claim, in both directions.

Eleven mechanisms carry the claim. They are load-bearing individually; together they are
the concept.

### 1.1 Identity exists before function — so there is someone there
A Grok Bot is created **empty and immediately open**, named `New Agent`, with no modal, no
form, no fields (`new-bots.md` steps 1–3; the `+` is a single 24×24 icon button, the only
child of the sidebar header). It greets you first: *"Hey Armand, good to meet you. What do
you want me around for? Anything concrete, or more of a general sidekick?"* (`anim-hero-00`).
The job arrives second.

Our rows are named `deploy-fix`, `render-bug`, `notify-hook`, `ci-green`. **The name IS the
function.** A thing whose name is its function is not a colleague; it is a job ticket. There
is no one there to greet you, because nothing exists apart from the task.

### 1.2 It renames itself — the moment it becomes someone
Transcript order in `bot-dom.html` / `anim-hero-02`: bot greets → user describes the job →
centred grey line **"Renamed to Sales Outbound"** → bot starts thinking. No form submission
sits between the message and the rename. The phrasing is agentless passive, identical in
register to *"Created routine 🕐 Overnight outbound"* and *"Updated memory for ⬤ Account
Manager"* — both unambiguously bot-authored.

This is the single cheapest "it's alive" event in the product, and it is corroborated in the
wild: HN commenter, *"I can assign a bug to 'Axiom' (**it named itself**) in YouTrack."*
An entity that chooses its own name has interiority. One that is handed a kebab-case slug by
a shell command does not.

### 1.3 The mark has a gaze
Every avatar is `<svg class="grok-bot-mark">` with `.grok-bot-mark__head` and
`.grok-bot-mark__eye`, `transition: fill .6s`, and a live `data-state="thinking"` attribute.
Eyes are **two asymmetric white ellipses** that change shape and direction between frames —
compare Sales Outbound in `anim-hero-00` (eyes open, glancing) with `anim-hero-08`
(narrowed slashes, working) with `anim-hero-20` (calm, done). Six of seven roster marks are
looking somewhere at any instant.

**An idle Grok roster still has ambient life, because seven faces are quietly blinking at
you.** Our marks — dome, puck, gem, wedge, arch — have no eyes at all. They are enamel
badges. A shape with a specular crescent and no gaze is a file-type icon, and a column of
file-type icons is, correctly, read as a settings list.

### 1.4 The bot speaks in its own lowercase voice, and the roster is where you hear it
Grok roster line 2, verbatim across `anim-hero-00`:
```
Chief             booked the venue and sent th…
Inbox Manager     sent. inbox at zero, 5 drafts parked for tomorrow.
Account Manager   invite's out to vicky. globex no…
Talent Scout      3 intros drafted in your voice, …
Expense Manager   report filed. 9 receipts, nothin…
Offsite crew      that leaves the pipeline. i'd spi…
```
Lowercase, first person, past tense, terse, unhedged, no subject pronoun. `deep-2.md §3.3`
proves it is **byte-identical to the newest assistant bubble at that instant** — not a
summary, not a status, *the actual last thing that person said.* On mobile the same register
carries the whole product: *"top 10 sending. rest stay queued."* (`mobel-mobilephonescreen`).

Ours, verbatim from `v3-roster-light.png`:
```
deploy-fix     ● Editing scripts/deploy-self.sh
web            ● Needs input — approve the migration?
supermux       ● Done — 14 files changed, tests green
render-bug     ● cargo check failed — 2 errors
ci-green       ● Starting…
release-train    4 sessions · scrollback, launch-audit +2
```
Every one of these is **third-person prose we wrote about a process**, in the voice of a
monitoring system: gerunds ("Editing", "Running"), tool output ("cargo check failed — 2
errors"), and counts ("4 sessions · … +2"). Nobody is speaking. This one field is,
by itself, most of the "MSN-messenger clone" verdict: it's the field where a chat app puts
a human sentence and we put `top`.

### 1.5 Activity is social presence, not telemetry
When Sales Outbound works, line 2 does not gain a spinner or a badge. It is **replaced, in
the same slot, at the same 12/16 type, by `Typing…`** — then by the live transcript tail
(`Checking what's connected. H…`, `anim-hero-02`), then by `Done.` (`anim-hero-20`). The
preview line *is* the status line. There is no separate status widget anywhere in the roster.

We have three simultaneous telemetry channels per row: a 2.5px accent gutter bar, a red dot
in its own left gutter column, and a coloured status bullet prefixing line 2 — plus a status
word. Four encodings of one fact. That is a NOC wall, and it is why the eye reads "system
health" instead of "who's around".

### 1.6 The whole app tints to whoever you're talking to
Five live custom properties on the app root, derived from the focused bot
(`--grok-bot-current-agent-{tint,bubble,bubble-ink,accent,coat}`), consumed by the side-pane
wash at 6%, mention chips at 14%, accent badges, the pending avatar's `--fg`, and — the
detail that proves the intent — the **card-title hover underline is drawn in the current
agent's colour at 1.5px**. Talk to Sales Outbound and the room is amber. You are in
someone's office, not in a settings pane.

Our accent is confined to a 2.5px bar and the mark itself. Nothing else in the app knows who
you're with, so switching rows changes a badge, not a place.

### 1.7 The roster is a DM list — with all the social grammar that implies
- Wall-clock timestamps that **tick**: `1:47 PM`, `10:47 AM`, `Yesterday` (verified advancing
  1:42 → 1:45 → 1:47 → 1:51 across captures). "When did this person last talk to me."
  Ours: `now`, `2m`, `6m`, `9m`, `1h` — uptime deltas. "How long has this process been in
  this state."
- One dot for unread, on the avatar corner, **no count** — `Inbox Manager` in `crop-roster`.
- A group chat (`Offsite crew`) is **the same 254×53 row shape** as a person, with a
  1-over-2 triangular facepile of the actual member marks, each ringed 2px in the page
  colour. A team is a crew, not a folder.
- Flat list, one search field, one `+`. No sections, no filters, no sort control. The IA is
  *deliberately thinner than ours* — and reads warmer, because thinness is what a contacts
  list looks like.
- The footer is **you**: a 28px `AS` initials chip + "Armand Segall", persistent across every
  screen including the full-screen overlay. Agents get faces; the human gets initials. That
  asymmetry is what tells you who the manager is.

### 1.8 Handoffs read as colleagues talking, not as a graph
Three primitives, all captured:
1. **In-flight pill** (`crop-many-bots`, `clean-stage3-03`): `[sender faces] ( ●●● Asking
   Research… ) [recipient face]` — a *sentence with a verb*, the dots in the agent's colour,
   the label in the **recipient's** accent, marks ringed on both ends, and the pill physically
   morphing open (`padding/background/box-shadow .4s`) as the baton passes. Verbs vary:
   "Asking Research…", "Looping in Comms…", "Sending to Chief…", "Pinging Travel…".
2. **Arrival divider** (`anim-hero-12`, `-20`): centred `Messages from ⬤ Account Manager and
   ⬤ Chief`.
3. **Coloured provenance in the prose itself**: *"⬤ Account Manager sent over the Acme +
   Globex threads and ⬤ Chief flagged the priority accounts. Both are folded into tonight's
   list."* Each chip = the sender's face at `height:1lh` + name in the **sender's** hue, and
   each chip is a `<button>` that navigates to them.

Our equivalent, in full: a pill reading `◆ supermux → web ◑`. An arrow between two node
glyphs. That is a dependency graph edge. Nobody is talking.

### 1.9 The system narrates itself into the conversation
`Renamed to …`, `Created routine 🕐 Overnight outbound`, `Updated memory for ⬤ Account
Manager` — centred, 13px, secondary ink, own transcript entry, agent chips clickable.
**There is no settings screen where things silently change.** The transcript is the audit
log, the management surface, and the org's memory, all one artifact. Every event that in our
product would be a toast or a hidden DB write is, in Grok, something a colleague mentions.

### 1.10 The receipts are prose, not a tool-call UI
The entire "tool call" surface is a plain bubble of `✓ **Salesforce** → list pulled · 52
accounts` lines. Bold tool, arrow, outcome, `·`-separated counts. No icons, no boxes, no
expand/collapse, no JSON. It is written the way a competent colleague reports back at the end
of the day. We ship terminal scrollback and call it transparency.

### 1.11 It is one seamless place, and it is beautiful on purpose
One glass substrate (`#fcfcfca6` + `blur(80px) saturate(180%)`), three tinted columns, 24px
window radius, **all borders 0.5px, never 1px**, elevation from backdrop-filter + hairline
rather than shadow. Two motion curves do 90% of the work: `cubic-bezier(.2,.9,.3,1.15)` for
anything arriving (a 15% overshoot pop) and `cubic-bezier(.22,1,.36,1)` for anything
settling. Badges **morph in place** over .26s (`Working → Action needed → Done`) instead of
swapping. Every animation has a colocated `prefers-reduced-motion` twin.

And the marks themselves are **candy-gloss spheres with a real light source top-left**, in
bright, high-lightness, high-chroma hues: `#54B9A6` `#F19D38` `#6464EF` `#885CF5` `#3C82F6`
`#ED712E`. They are joyful. They are the only saturated thing on a near-white page, so the
page reads as calm *and* the people read as alive.

**Summary of the concept in one line:** *Grok Bot is not a UI for managing agents. It is a
messaging app whose contacts happen to be software, and every design decision defends that
fiction.* Our board defended measurable correctness instead — and correctness was never the
claim being made.

---

## 2. THE GAP LIST — what our rejected mockup got wrong, per element

Merciless, specific, and split into concept (C) and craft (V). Referenced against
`v3-roster-light.png` / `v3-full-light.png` vs the Grok frames.

### The deliverable itself
- **G1 (C).** We shipped a **decision board**, not a product. Title: *"supermux session
  identity marks — B0 decision board (spec v3)"*, followed by *"OWNER DECISIONS ON THIS
  BOARD"*. Grok's comparable artifact is a running application. A board asks the owner to
  adjudicate; a product asks him to feel something.
- **G2 (C).** We rendered our own engineering **into the surface**: `ΔE 1.96 from card —
  sub-JND`, `#222224 dark (ΔE 2.96)`, `measured L* 38–52 vs the Grok reference's 50–72`,
  `greyscale(1)` proof grids, `PIXEL PROBES — flat swatches sampled by the report script`.
  The interface displays its own QA harness. Nothing in Grok's product shows a number about
  itself.
- **G3 (C).** Eight labelled sections (A–G + probes) of **isolated primitive strips**: roster,
  rail, header pill, facepiles, greyscale proof, control pairs, swatches. The complaint
  "isolated primitives instead of the seamless whole" is literally the table of contents.
- **G4 (C).** **There is no conversation anywhere in the deliverable.** Zero bubbles, zero
  sentences, zero voice. We designed the address book of a messaging app and never designed a
  message. The entire concept lives in the transcript, and we skipped the transcript.
- **G5 (C).** **The human is absent.** No footer, no initials, no name, no "you". Grok's
  `AS · Armand Segall` never unmounts. Without the one human on screen, a roster of workers
  has no manager and reverts to being a list of resources.

### The roster row — the element that decides everything
- **G6 (C).** **Names are slugs.** `deploy-fix`, `render-bug`, `notify-hook`, `ci-green`,
  `mobile-ui`, `term-fix`, `kimi-code`, `release-train`. Kebab-case, lowercase, machine-safe.
  vs `Chief`, `Sales Outbound`, `Talent Scout`, `Offsite crew`. Ours are branch names. Theirs
  are job titles you'd read on a door.
- **G7 (C).** **Line 2 is telemetry in our voice, not speech in theirs.** `Editing
  scripts/deploy-self.sh` / `cargo check failed — 2 errors` / `4 sessions · scrollback,
  launch-audit +2`. Not one of those sentences was uttered by the agent. Single largest
  concept miss in the file.
- **G8 (C).** **Status is chrome, not presence.** We prefix line 2 with a coloured bullet and
  a state word (`● Starting…`, `● Running the hook test suite`). Grok replaces the whole line
  with `Typing…` and adds nothing. Our version says "process state = starting"; theirs says
  "she's about to say something".
- **G9 (V/C).** **Three redundant attention channels.** Left gutter bar (2.5px accent),
  separate red dot in its own column, and the status bullet — plus the word. Grok: one dot on
  the avatar. Ours reads as an alerting console, and the gutter column pushes the mark off the
  left edge so the row loses its "avatar first" reading.
- **G10 (V).** **Relative durations instead of wall-clock.** `now / 2m / 6m / 9m / 21m / 1h`.
  Uptime, not last-contact. Grok's `1:47 PM` / `Yesterday` is the single word-level cue that
  says "conversation". Ours says "monitoring".
- **G11 (V).** **Name weight is too heavy and too small.** Ours reads ~13px/600 — a table
  header. Grok: 14px/20, tracking −0.15, medium. Heavy small caps-adjacent labels are what
  file managers do.
- **G12 (V).** **Row rhythm is wrong.** Ours packs 10 rows tight with a hairline-free stack
  and no breathing room; Grok's is 254×53 with `radius 10 / padding 8 / gap 8` and `gap-0.5`
  between rows, on a 280px sidebar with 16px left inset. Ours feels like a table body; theirs
  feels like a list of people.
- **G13 (V).** **No row-enter motion, no ticking, nothing live.** Grok rows slide in
  (`translateX(-10px)`, .45s expo-out), timestamps recompute on an interval, eyes move. Our
  roster is a still image of a roster.

### The marks
- **G14 (C).** **No face. No eyes. No gaze.** Fatal. Our marks are heraldic silhouettes with
  a crescent highlight — dome/puck/gem/wedge/arch. Grok's are heads that look at you and
  change expression with `data-state`. This is the difference between an icon set and a cast.
- **G15 (V).** **Hues are dark, muddy and desaturated.** Our own report admits L* 38–52 vs
  Grok's 50–72 — olive, oxblood, plum, mustard, dark teal. On white they read as *dirty*.
  Grok's `#F19D38 / #54B9A6 / #885CF5` at high chroma read as *sweet*. We optimised contrast
  ratio and lost the candy.
- **G16 (V).** **Highlight is a sticker, not a light source.** A single flat crescent arc,
  identical on every shape, at the same angle regardless of form. Grok's marks have a soft
  specular from a consistent top-left source, with the head's own fill transitioning at .6s.
  Ours look printed; theirs look moulded.
- **G17 (C).** **We invented a taxonomy no one asked for.** Five shapes × four details × six
  hues, deduped by rule, with a documented `shape × detail × coat` grammar. Grok has ~three
  silhouettes used loosely and lets colour and *eyes* do the work. Our combinatorial system is
  a spec for uniqueness; theirs is a cast of characters. Uniqueness was never the felt problem.
- **G18 (V).** **The status ring / notch mutilates the silhouette.** Our §G "control" pairs
  literally measure the calm-vs-attention silhouette delta and admit `v2's badge ate ~32px of
  the dot and left a concave notch`. Grok never overpaints the mark: state lives in the eyes
  and in one corner dot.

### Colour, surface, texture
- **G19 (V).** **Pure white cards on grey, with near-black ink.** Cold, high-contrast, office
  software. Grok's substrate is `#fcfcfca6` with `blur(80px) saturate(180%)`, sidebar
  `rgba(251,251,251,0.35)`, selected row `rgba(10,10,10,0.055)`. Warm, translucent, quiet.
- **G20 (V).** **1px borders and hard edges.** Grok is **0.5px everywhere** — composer, cards,
  popovers, separators — with elevation from backdrop-filter, not shadow. Ours has no
  translucency at all, so nothing sits *on* anything.
- **G21 (V).** **No photography, no gradient, no depth anywhere.** Grok's transcript carries
  a 16:10 embedded desktop preview with a real warm sunset-mountain wallpaper (`anim-hero-08`,
  `-12`), radius ~12, inside a card. That single photographic rectangle is what makes the whole
  column feel like a place. Our board is 100% flat vector on flat fills.
- **G22 (V).** **Corner radii are too tight and inconsistent.** Grok: window 24, bubble 16,
  card 16, row 10, message-panel 10, mention chip 5, everything else 999. One deliberate
  ladder. Ours reads as a 6–8px house style with no top end, so nothing feels soft.

### Everything that is simply missing
- **G23 (C).** **No app tint.** Selecting a row changes a 2.5px bar. Nothing else in the
  interface knows who you're with.
- **G24 (C).** **No self-naming, no rename event, no system lines at all.** No `Renamed to…`,
  no `Created schedule…`, no `Linked board issue…`. Our identity is assigned, silently, by us.
- **G25 (C).** **Delegation as a graph edge.** `◆ supermux → web ◑` — no verb, no motion, no
  recipient colour, no clickability, no dots. Grok's `(●●● Sending to Chief…)` is a sentence
  mid-utterance.
- **G26 (C).** **No arrival divider, no coloured provenance chips in prose.** The single most
  transferable idea in the entire research corpus, absent.
- **G27 (C).** **Teams are a count.** `release-train · 4 sessions · scrollback, launch-audit
  +2`. Grok's `Offsite crew` gets the same row as a person, a real composite facepile of its
  members' marks, and its last remark. Ours announces cardinality; theirs introduces a crew.
- **G28 (C).** **No mobile artifact.** Grok's concept survives to a 390px phone and a collapsed
  18px rail *because the mark is a face* (`mobel-babygrokbot`: the rail is seven faces and
  nothing else). We shipped an 18px greyscale proof grid instead of a phone.
- **G29 (V).** **No motion vocabulary.** No arrive curve, no settle curve, no in-place badge
  morph, no reduced-motion twins. Our "states" are static side-by-side pairs — a diagnostic
  format, which is exactly what the owner called calculated.

---

## 3. THE CONCEPT CONTRACT

Fifteen statements the primary interface must satisfy. Each is **falsifiable** — a stated
test that can fail on a screenshot or in a DB query — and each is mapped to the mechanism
that powers it. If a build fails any of these, it does not carry the concept, regardless of
how it measures.

---

**C1 — Every session speaks with a name and a face, never a slug.**
No kebab-case identifier appears anywhere in the default interface: not in the roster, the
header, the composer placeholder, the mobile rail, or any chip. The slug is reachable on
hover, in detail, and via an explicit "copy for agent" affordance — nowhere else.
*Powered by:* `sessions.display_name` (0019 — immutable `name` slug already split from the
mutable label) + deterministic mark derived from `hash(name)`.
*Falsifier:* grep a full-app screenshot's text layer for `-` inside a name. One hit fails.

**C2 — A session names itself in its first exchange, and the rename is narrated.**
Within the first turn, the agent proposes and applies a human display name and a one-line
job. The change appears as a centred system line in that session's transcript
(`Renamed to Release Train`), in the agent's own passive voice. Never a silent write.
*Powered by:* agent-callable `PATCH /api/sessions/:name {display_name, desc}` + a
`system-event` chat entry + `audit` (0007).
*Falsifier:* create a session, give it one instruction; if the roster still shows the slug
after the first assistant turn, it fails.

**C3 — The roster's second line is the agent's own last words, verbatim, in its voice.**
Byte-identical to the tail of the transcript. Never composed by us, never third-person, never
tool output, never a count. If the agent hasn't spoken yet, the line is empty — not filled
with telemetry.
*Powered by:* `chat_tail` (last assistant text from the native runtime transcript), fallback
`sessions.task_summary` only when it is itself agent-written.
*Falsifier:* diff the roster line against the last assistant message in that session. Any
divergence — including our own truncation prose or a gerund like "Editing…" — fails.

**C4 — While working, that same slot carries social presence, not telemetry.**
`Typing…` / `Thinking…` / `Done.` in the same slot, same type, same ink. No spinner, no
badge, no progress bar, no percentage, no coloured bullet in line 2.
*Powered by:* `session_runtime.last_status ∈ active|waiting|idle|stopped|starting` mapped
through a fixed presence lexicon.
*Falsifier:* any glyph other than text in the roster's line 2 fails.

**C5 — The face is the status indicator; the row carries no status chrome.**
The mark's eyes carry `data-state` (working / waiting / idle / stopped). There is no status
dot, no gutter bar, no ring, and nothing ever overpaints or notches the silhouette.
*Powered by:* `last_status` → `data-state` on the mark SVG; accent hue from the session's
colour slot.
*Falsifier:* silhouette-diff the mark between calm and every attention state. Any non-zero
pixel delta outside the eyes fails.

**C6 — Exactly one attention channel exists in the roster: one dot on the face.**
Three tiers (*needs attention* > *unread* > *working*) collapse into: dot present, dot absent,
and presence text. No second encoding of the same fact anywhere in the row. Counts are
permitted only where the count is itself the content (queued steering messages, pending board
issues) and never on the mark.
*Powered by:* `last_status` + inbound `delegations` + unseen-transcript delta.
*Falsifier:* count the visual encodings of "needs input" in one row. More than one fails.

**C7 — Opening a session tints the whole app to that agent.**
Four custom properties are written on the app root on focus and consumed by at least: the
header, mention chips (14%), the composer focus ring, card-title hover underline (1.5px, agent
hue), and any side-pane wash (~6%). Semantic status colours never use the agent accent, and
the agent accent never encodes state.
*Powered by:* `--sm-agent-{tint,accent,coat,bubble}` on the shell, from the session's colour
slot; `light-dark()` per scheme.
*Falsifier:* screenshot two different sessions focused; if more than the mark and one bar
differ, it passes — if only the mark and a bar differ, it fails.

**C8 — Cross-agent provenance renders in prose, in the sender's colour, with the sender's face.**
When work arrives from another session, the receiving transcript shows a centred divider
(`Messages from ⬤ web and ⬤ deploy`) and the body opens with inline chips: the sender's mark
at `height:1lh` plus the sender's display name in the sender's hue. Each chip is a button that
navigates to that session.
*Powered by:* `delegations` (0005, `from_session`/`to_session`/`prompt`/`ts`) + SSE →
chat-renderer mention primitive.
*Falsifier:* run `POST /api/agents/delegate` between two sessions. If the receiving
transcript shows no divider and no coloured chip, it fails.

**C9 — A delegation in flight is a sentence with a verb and a face at each end.**
`[sender face] ( ●●● asking web… ) [recipient face]` — animated dots, label in the recipient's
accent, both marks ringed in the page colour, the pill morphing open rather than appearing.
Never an arrow between two glyphs.
*Powered by:* `delegations` + live status; avatar-row morph primitive.
*Falsifier:* the rendered pill contains no verb, or contains `→`. Either fails.

**C10 — Everything the system does is narrated into the conversation.**
Rename, schedule created, board issue linked, worktree created, model/mode change, provider
switch, compaction boundary, delegation sent — all render as centred 13px secondary system
lines with clickable entity chips, in the transcript, at the moment they happen. Nothing that
changes a session's identity or capabilities happens only in a settings pane or a toast.
*Powered by:* `audit` (0007) + `schedules` (0003/0014/0020) + board (0002/0013) → one
`system-event` chat primitive.
*Falsifier:* perform each of the eight events above; every one that produces no transcript
line fails.

**C11 — Timestamps are wall-clock and they tick.**
`1:47 PM`, `Yesterday` — recomputed on an interval, and the first element dropped when the
roster narrows (container query, not media query). Never elapsed-duration (`9m`, `1h`) in the
roster.
*Powered by:* `sessions.last_send` + `@container (max-width:160px)`.
*Falsifier:* any `m`/`h` suffix in a roster timestamp fails; a static timestamp across two
captures 60s apart fails.

**C12 — The one human is on screen at all times, exactly once.**
Persistent footer: initials chip + name, present on every surface including full-screen
overlays and mobile. Agents are marks; the human is initials. The asymmetry is deliberate and
never inverted.
*Powered by:* local profile / host identity.
*Falsifier:* any screen where the human's identity is absent, or where the human is rendered
with an agent-style mark, fails.

**C13 — A team is a crew, not a folder.**
A team renders in the identical row shape as a single session, with a composite avatar built
from its real members' marks (1-over-2 triangular cluster, 18px, each ringed 2px in the page
colour), and its second line is the crew's last spoken line — never a member count or a list
of slugs.
*Powered by:* `sessions.team_name` (0017) + `dismissed_teammates` (0022) + member marks.
*Falsifier:* the team row shows a number, or a different row height/shape than a session row.
Either fails.

**C14 — The primary interface is a conversation on first paint; the terminal is a fallback.**
Opening a session shows bubbles, receipts, cards and system lines — not a VT grid. Terminal
scrollback is reachable in one explicit action and is never the default view, never the empty
state, and never what the roster previews.
*Powered by:* native runtime transcript + chat renderer over the server-side VT grid.
*Falsifier:* a cold open that paints monospace before it paints a bubble fails.

**C15 — Nothing in the interface is a measurement of the interface, and every state change morphs.**
No ΔE, contrast ratio, pixel dimension, token count of our own chrome, or QA grid is ever
visible to the user. State changes (badge tone, presence label, name, accent) cross-fade or
morph in place over ~.26s using two curves — `cubic-bezier(.2,.9,.3,1.15)` for arriving,
`cubic-bezier(.22,1,.36,1)` for settling — and every animated rule has a colocated
`prefers-reduced-motion` twin whose static fallback still reads.
*Powered by:* one motion token set; `@media (prefers-reduced-motion: reduce)` beside each rule.
*Falsifier:* any user-visible number describing the UI's own rendering fails; any badge that
swaps rather than morphs fails; any animation without a reduced-motion twin fails.

---

### The one-sentence test the whole contract serves

> Screenshot the roster with all product-specific nouns blurred. If a stranger reads it as a
> **messaging app's contact list**, the concept is carried. If they read it as a
> **dashboard, a settings pane, or a CI board**, it is not — and no amount of measured
> correctness will change that verdict.

Our rejected board fails that test at a glance. Grok's frame passes it at a glance. That, and
not ΔE, is what we are building against.
