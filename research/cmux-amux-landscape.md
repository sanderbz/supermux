# cmux + amux.io + Landscape — v3 Reference

> Research conducted 2026-05-21. Sources cited inline; full link list at end.

## Important naming clarifications upfront

Three different products share confusingly similar names. Get this clear before reading anything else:

1. **cmux (manaflow-ai/cmux)** — native macOS terminal built on Ghostty, for running AI coding agents. <https://github.com/manaflow-ai/cmux>. (The brief said "github.com/coder/cmux" — that repo does not exist. coder/mux exists and is a *different* product. cmux.com is the consumer-facing landing page that points to manaflow-ai/cmux.)
2. **Mux (coder/mux)** — desktop & browser app for parallel agentic development from Coder. <https://github.com/coder/mux>, docs at <https://mux.coder.com>.
3. **amux (mixpeek/amux + amux.io)** — open-source "agent control plane" — single-file Python server + web dashboard that drives Claude Code sessions inside tmux. <https://github.com/mixpeek/amux>.
4. **amux (jordanwebster/amux + amux.sh)** — separate, unrelated product. iOS-first agent multiplexer with a routing protocol. Use of the same name is coincidental.

This report treats mixpeek/amux as "current amux" since that's what amux.io promotes.

---

## TL;DR — five things v3 must do to be best-in-class

1. **First-class status taxonomy with visible reliability.** Working / Needs Input / Idle / Blocked / Crashed / Compacting — pushed reliably to a sidebar AND a system-tray-level surface. cmux issue #1027 shows this is currently the #1 visible failure mode in the category; whoever nails it wins.
2. **One-shot agent boot with skill/template + prompt.** `amux spawn <skill> "<prompt>"` should be the headline command. Today this requires manual register + start + send. Conductor, Cursor 3.0, and Mux all wrap boot in a single primitive.
3. **Workspace-isolated parallel sessions with git worktree, surfaced visually.** Sidebar shows branch, PR #, ports, last notification, last diff size — the cmux pattern, applied to amux's web dashboard.
4. **Agent-to-agent delegation as a real primitive, not just an HTTP endpoint.** amux already exposes a REST send/peek/claim API; v3 must turn that into a first-class "@worker-2 review this PR" mention pattern in the UI and chat history, with a visible delegation graph.
5. **Self-healing watchdog + checkpoints + replay.** amux already has watchdog (auto-compact, restart on corruption, replay last message). v3 adds Conductor-style checkpoints (named rollback points) and resumable session restore (the cmux feature) so overnight runs are recoverable from a known-good state, not just "still alive."

---

## cmux (manaflow-ai/cmux) deep-dive

### Architecture
- Native macOS, Swift + AppKit, built on libghostty for GPU-accelerated terminal rendering.
- Languages: Swift 80.7%, Python 11.3%, TypeScript 3.9%, Shell 1.8%, Go 1.2%.
- Reads terminal keybindings from `~/.config/ghostty/config`; cmux-specific shortcuts customizable in Settings.
- Distribution: DMG with Sparkle auto-updates; Homebrew tap `manaflow-ai/cmux`; nightly builds with separate bundle ID. Commercial "Founder's Edition" tier exists.
- Design philosophy: explicitly "a primitive, not a solution" — provides composable terminal + CLI + socket API instead of an opinionated workflow.

### Features list (verbatim from README + docs)
- **Vertical tabs sidebar** showing per-pane: git branch, PR status/number, working directory, listening ports, last notification text.
- **Notification system**: blue ring on pane + tab highlight + macOS desktop notification. Triggered by OSC 9/99/777 escape sequences, by `cmux notify` CLI, or by Claude Code hooks.
- **Splits**: horizontal and vertical inside tabs, with directional focus navigation.
- **Up to 9 workspace slots**, ⌘1–9 to jump.
- **Surfaces (tabs within workspaces)**, ⌘T new, ⌘⇧] / ⌘⇧[ to cycle, ⌃1–9 to jump.
- **In-app browser**: scriptable, accessibility tree snapshots, element refs, form fill, JS eval. Imports cookies/history from Chrome, Firefox, Arc, and 20+ browsers.
- **SSH workspaces**: `cmux ssh user@remote`. Drag-drop file upload via scp. Browser inside SSH workspace routes through remote network — automatic localhost access.
- **Session restore**: window/workspace/pane arrangement, working dirs, scrollback. **Agent resume hooks** explicitly restore Claude Code, Codex, Grok, OpenCode, Pi, Amp, Cursor CLI, Gemini, Rovo Dev, Copilot, CodeBuddy, Factory, Qoder. `autoResumeAgentSessions` flag in `~/.config/cmux/cmux.json`.
- **Custom resume bindings** via `cmux surface resume` with signature verification; environment tokens/passwords filtered out before persistence.
- **Socket API + CLI** for full programmatic control (create workspaces, split, send keystrokes, drive browser).
- **Custom commands** declared per project in `cmux.json`, surfaced in the command palette.
- **Command palette** ⌘⇧P, VS Code-style, fuzzy across actions/workspaces/surfaces (PR #1417, #358).

### Keyboard shortcuts that matter
| Domain | Shortcut |
|---|---|
| New workspace / jump | ⌘N, ⌘1–9, ⌘⇧W close, ⌘⇧R rename |
| Surfaces (tabs) | ⌘T new, ⌘⇧] next, ⌘⇧[ prev, ⌃1–9 jump |
| Splits | ⌘D horizontal, ⌘⇧D vertical, ⌥⌘ arrows to focus |
| Notifications | ⌘I open panel, ⌘⇧U jump to latest, ⌥⌘U dismiss |
| Browser | ⌘⇧L open browser pane, ⌘L focus URL, ⌘[ / ⌘] back/forward, ⌥⌘I devtools |
| Command palette | ⌘⇧P |

### UI patterns v3 should steal
- **Sidebar metadata density** — branch + PR + ports + last notification in one row per workspace. Massive context with zero clicks.
- **Notification rings** on the pane itself, not just a list elsewhere. The visual is unambiguous and matches macOS notification dot vocabulary.
- **Session restore that resumes the agent**, not just the shell. The agent-specific hook map is the gold standard.
- **Socket API + CLI parity** — every UI action is scriptable. This is the only way agents can drive their own multiplexer.
- **Resume bindings with signature verification + secret filtering** — security model worth copying verbatim.

### Things cmux does that v3 should NOT do
- **macOS-only, Swift-native.** amux's superpower is being a Python single file that runs anywhere with tmux. Don't trade that for native shine.
- **"Primitive, not a solution" stance.** Beautiful philosophy, but amux's positioning ("control plane") is opinionated by design — and the v2 user base wants opinions, not primitives. Stay opinionated.
- **No built-in board / no kanban / no CRM / no notes.** cmux deliberately defers all coordination to other tools. amux's competitive moat is *because* it includes these.
- **Per-PR thrash on shortcut bindings.** cmux had multiple PRs reshuffling ⌘⇧P, palette nav, etc. Lock the keymap early.

### cmux's documented status-indicator failure (lesson)
Issue [#1027](https://github.com/manaflow-ai/cmux/issues/1027): "Sidebar 'Running' and 'Needs Input' status indicators are flaky and unreliable." The fix the issue demands — "Needs Input should reliably appear whenever the agent is blocked waiting for user input, and both indicators should clear promptly when the state changes" — is the single most important UX bar for v3.

---

## amux.io marketing promises (current product audit)

amux.io's pages return 403 to non-browser clients, so I assembled the claim inventory from Google indexing snippets, the GitHub README, CLAUDE.md, and the SkillsLLM mirror.

### Promises the marketing site makes
| Claim | Source |
|---|---|
| "Open-source control plane for AI agents" | amux.io homepage |
| "Run dozens of parallel agent sessions from your browser or phone" | README + amux.io |
| "Web dashboard, kanban board, notes, CRM, email, browser automation, slash-command skills, and agent-to-agent orchestration" | README |
| "Self-healing watchdog auto-compacts, restarts, and replays the last message" | amux.io features |
| "Monitors context %, restarts on corruption, replays the last message, and unblocks stuck prompts, designed for unattended overnight runs" | amux.io features |
| "REST API where agents discover peers, send tasks, peek terminals, and atomically claim board items" | amux.io/features/agent-coordination |
| "SQLite-backed board has auto-generated keys, atomic CAS claiming, custom columns, and iCal sync" | features |
| "Installable PWA for iOS and Android plus a native iOS app on the App Store, with Background Sync replaying commands when you reconnect" | features |
| "No build step, no node_modules, no Docker — just save the file and it restarts itself" | README + CLAUDE.md |
| "Named cron-style recurring jobs with a built-in management UI" (scheduler) | search snippet of features page |
| "Project-level commands like /commit or /review-pr can be defined once and shared across the agent fleet" | search snippet |
| "Five pillars: lifecycle management, observability, fault tolerance, orchestration, and governance" | amux.io homepage |
| "Live status (working / needs input / idle), token stats, quick-action chips" on session cards | README |
| "/api/sessions/worker-1/send, /api/board/PROJ-5/claim, /api/sessions/worker-1/peek?lines=50" — concrete API surface | README |
| "Markdown documents with rich Quill editor, find-in-page, and inter-session sharing" (notes) | README |
| "Contacts, companies, interaction logs, follow-up tracking, and tags" (CRM) | README |
| "Channels — 1:1 inter-session messaging with @mentions" | README |
| Auto-press option 1 on rate-limit, resume after reset time | README |

### Promises kept by current amux
- Single-file Python server with auto-restart on save — yes, `amux-server.py` is the whole thing.
- Web dashboard on :8822 — yes.
- REST API for send/peek/claim — yes, documented endpoints exist.
- tmux-based isolation per session — yes.
- Watchdog with `/compact` trigger, corruption restart, stuck-prompt unblock — yes (per CLAUDE.md and README).
- Mobile PWA + native iOS app on App Store — confirmed on App Store.
- Kanban with atomic claim + iCal — yes (calendar.ics endpoint).
- Browser automation via /chrome-cdp — yes, but tied to user's live Chrome.
- Scheduler with cron-style jobs — yes (search snippets confirm).

### Gaps the marketing site implies but the current product under-delivers on
> These are the "v3 must fulfill" items.

1. **"Slash-command skills … shared across the agent fleet"** — there's no Claude-Code-style `/skill` discovery UI. v3 needs a real skill registry visible in the dashboard, invocable per session, with audit log.
2. **"Agent-to-agent orchestration"** — the primitives (REST send/peek/claim) exist, but the dashboard does not visualize delegation. There's no "who asked whom to do what" graph. The promise is "fleets coordinating without humans"; the reality is "humans still wire it up."
3. **"Live status: working / needs input / idle"** — exists conceptually but, like cmux, reliability is the hard part. v3 must drive this from tmux PTY heuristics + Claude Code hook callbacks + heartbeat checks, not just one signal.
4. **"Token stats / cost tracking"** — promised, but no per-model breakdown, no budget alerts, no spend caps. Mux and Conductor both surface this better.
5. **"Email / CRM / notes" first-class** — the modules exist but lack the polish of a Linear-grade product. CRM in particular reads as scaffolding.
6. **"Atomic task claiming, no two agents pick up the same ticket"** — works, but there's no surface for "agent A claimed PROJ-5, now PROJ-5 shows up in their session card with a back-link." The board and the session view are visually disconnected.
7. **"Browser automation via slash command"** — `/chrome-cdp` exists, but there's no `/browse <url>` skill or screenshot inline-display in chat. Conductor's Chrome integration shows what good looks like here.
8. **"Edit it; it restarts on save" — auditable in an afternoon** — true, but a single 4000+ line Python file is also brittle. v3 needs to keep the philosophy without the antipattern. Modular files that get *bundled* into the deployable single artifact is a better resolution.
9. **"Mobile PWA Background Sync replays commands on reconnect"** — works in theory; in practice, offline UX is thin and there's no conflict resolution when two devices queued commands.
10. **"Governance" pillar** — barely materialized. No RBAC, no per-session policy file (Mux ships one), no audit-grade event log, no secrets vault.

### One critical philosophical gap
The marketing positions amux as an *agent control plane*. Real control planes (Kubernetes, Nomad) expose: declarative desired state, reconciliation loop, structured events, RBAC, observability. amux today is closer to a *task supervisor with a dashboard*. v3 must either (a) deliver actual control-plane semantics — a `Workspace` resource you can `apply`, a controller that reconciles — or (b) reposition. The current gap between language and product is widening as Cursor 3.0 and Mux ship more polish.

---

## Conductor (Melty Labs / conductor.build)

Anthropic doesn't make Conductor — Melty Labs does. It's the most polished Mac-native parallel-runner.

### What Conductor got right (steal these)
- **One-step authentication reuse.** "Uses Claude Code however you're already logged in. If you're logged in with the Claude Pro or Max plan, Conductor will use that." Zero API key friction.
- **Three-step mental model**: Add repo → Deploy agents → Conduct. Marketing language matches product flow.
- **Diff viewer integrated**: side-by-side, multiline comment selection, "mark file as viewed," auto-revert on file change, GitHub review comment sync.
- **Checkpoints** — automatic snapshots, rollback to any prior turn. This is the missing piece in amux's watchdog story.
- **Spotlight testing** — sync changes back to the main repo for ad-hoc testing without leaving the workspace, hot-swap branches against a single running app instance.
- **Multi-model mode** — run Claude and Codex against the same prompt in different tabs, compare.
- **Command palette ⌘K** with PR/workspace/settings search; keyboard shortcuts sheet at ⌘/.
- **Workspace grouping by status**: backlog / in progress / review / done — kanban inside the agent runner itself.
- **Linear deep-link integration**: create a workspace from a Linear issue.
- **Per-repo "Files to copy"** auto-provisioning, per-repo setup scripts.
- **Auto-archive on PR merge** + History tab one-click restore.
- **Effort levels** (⌥T) and **Plan Mode** handoff between agents.
- **Workspace city naming with legendary tier tracking** — silly but it makes the product memorable.
- **Completion sounds + timed notification toasts with countdown rings** — pleasant feedback loops.
- **Chat table of contents, ⌘F chat search, instant summarization, context usage meter with breakdown on hover.**
- **Managed settings** at `~/.conductor/settings.json` for system-level config.
- **Continue on new branch** — sequential work without rebuilding the workspace.

### What v3 can learn beyond features
- Conductor is *opinionated and complete*. There's almost nothing to configure to get started. amux today asks the user to `register` a project with flags. v3 boot should be `amux .` in any repo.
- They ship cosmetic polish (colorblind themes, syntax themes, custom file icons). It signals craft.
- They publish a changelog with every shipped feature. amux should too.

---

## coder/mux (the "Mux" product)

Not the same as cmux. Coder's Mux is a desktop + browser app for parallel agentic dev. Worth a section because some features are unique.

- **Three execution runtimes**: local in-place, git worktree, SSH remote.
- **Plan Mode + Exec Mode** distinction inspired by Claude Code, with explicit mode prompts.
- **Opportunistic compaction** for context management + `/compact` command.
- **Best-of-N execution strategy** — same prompt fanned out to N agents/models, picks the winner.
- **Multi-model**: sonnet-4-*, grok-*, gpt-5-*, opus-4-* + Ollama + OpenRouter.
- **VS Code extension** for in-editor integration.
- **Rich markdown rendering** with Mermaid + LaTeX.
- **Mobile-responsive server-mode UI.**
- **MCP server config + GitHub Actions integration.**
- **Policy files + project secrets management + Agentic Git Identity setup.**
- **Vim mode + keyboard shortcut system.**
- **Workspace forking and sharing** + `.muxignore` file.
- **Context boundaries** (compaction + reset, distinct).

What v3 can learn: **policy files** (per-project YAML defining what agents can/cannot do) and **agentic git identity** (commits get tagged with the agent that authored them) are both governance primitives amux is missing.

---

## Cursor 3.0 (Composer + Agents Window)

Released April 2, 2026. The mainstream-IDE answer.

- **Agents Window**, opened via ⌘⇧P → Agents Window. Run "many agents in parallel across repos and environments: locally, in worktrees, in the cloud, and on remote SSH."
- **Up to 8 agents per prompt**, each in isolated worktree or remote VM worker.
- **Agent tabs**: view multiple chats at once, side-by-side or in a grid.
- **Cmd/Ctrl+I**: open Composer, multi-file task.
- **/worktree** slash command creates an isolated worktree.
- **/best-of-n** runs in parallel across multiple models, isolated worktrees, then compares.
- **Await tool** — agents can wait on background commands, subagents, or specific outputs (this is huge for orchestration).
- **Design Mode (⌘⇧D)** — annotate and target browser UI elements directly. Shift+drag to select; ⌘L to add to chat; ⌥+click to add to input.
- **Background Agents** — cloud-only, clone repo, complete tasks, create PRs while you keep working locally.
- **Composer-1 + Sonic** — Cursor's own low-latency edit models.

What v3 can learn: **Await tool semantics** (agent declares it's waiting for X, the multiplexer knows) and **/best-of-n** as a slash command are both clean abstractions.

---

## Claude Squad (smtg-ai/claude-squad)

Terminal-UI predecessor to most of this category.

- tmux + git worktrees + TUI for parallel agent management.
- Profiles (`~/.claude-squad/config.json`) for named agent program configs.
- `-y` experimental auto-accept (yolo).
- Shortcuts: `n` new, `N` new-with-prompt, `D` delete, `Enter`/`o` attach, `Ctrl-Q` detach, `s` commit/push, `c` checkout, `r` resume.
- Diff preview before applying.

What v3 can learn: **single-keystroke unmodified hotkeys inside an attached session** (`s` to commit, `r` to resume, `c` to checkout) is a fast pattern that web dashboards often forget. Quick-action chips on amux session cards should map to single-letter hotkeys when the card is focused.

---

## Warp (warp.dev) and the "agentic terminal" wave

- **Blocks**: every command + output is a discrete unit with exit code, duration, timestamp — selectable, copyable, shareable.
- **Agent Mode** (⌘↩ or `/agent`): conversation view, runs multi-step plans inline.
- **MCP-native**: databases, ticketing, cloud, internal APIs via single config.
- **Oz**: Warp's cloud orchestrator for background agents.
- Now dual-licensed MIT/AGPL-3, source on GitHub.
- Active AI: prompt suggestions, next-command, auto-diff for compiler errors — context-aware from shell history, branch, exit codes, recent block I/O.

What v3 can learn: **structured "blocks" for each agent turn** (prompt + tool calls + output + exit code + duration) make audit and replay trivial. amux's session view is currently a flat tmux peek; v3 should structure the chat history into Warp-style blocks.

---

## OpenAI Codex CLI

- **AGENTS.md** discovery chain (global `~/.codex`, then per-project) for boot-time instructions.
- **Subagents** as a first-class feature.
- **MCP server mode**: turn Codex CLI into an MCP server. Exposes `codex()` (start) and `codex-reply()` (continue) tools — keeps it alive across multiple agent turns. This is how Codex plugs into Agents SDK orchestration.
- **Symphony** — open-source orchestration spec for Codex (Project Manager → Designer → Frontend/Server/Tester subagents with scoped instructions and output folders).
- GPT-5.2-Codex default (May 2026), context compaction, Windows-strong.

What v3 can learn: **AGENTS.md precedence chain** is the pattern for project-level config. **Codex-as-MCP-server** is the pattern for letting one agent drive another — amux should expose each running session as an MCP server endpoint by default.

---

## OpenClaw (clarification)

The "openclaw" framework you removed from clawd-02 is positioned as an OS for AI agents: sessions, memory, tool sandboxing, access control, orchestration. Multiple downstream repos:

- **openclaw-managed-agents** — cloud service / SaaS layer.
- **openclaw-orchestrator** (multiple forks) — LLM-driven planner that breaks goals into subtasks, routes to specialized agents, iterates. SQLite-backed, real-time web dashboard. TypeScript + Zod-validated.
- **openclaw-mission-control** — operations dashboard.
- **openclaw-agents** — one-command 9-agent setup, group routing, safe config merge.

The orchestration model: **planner agent decomposes goal → router dispatches subtasks → specialized agents execute → iterator decides done/retry**. Heavy LLM-in-the-loop, opinionated, web-dashboard-first.

What v3 can learn (or explicitly reject): the planner→router→specialist→iterator loop is one valid model. amux's bias should be the opposite — let *humans* author the orchestration plan in skills/slash commands, and have agents *execute* it. Avoid recreating OpenClaw's heavy meta-LLM layer.

---

## Herdr (herdr.dev) — close competitor worth watching

- Tmux-style persistence + mouse-native panes.
- First-class agent state: **blocked / working / done / idle**.
- CLI + socket API (newline-delimited JSON) — agents can drive it.
- Operations: create workspace, split, run command, **wait for state change** (this is the cool one).
- Local, SSH, or thin-client-to-remote-host.

What v3 should match: the **wait-for-state primitive**. An agent should be able to spawn a worker and `amux wait <session> --state done --timeout 600` and the multiplexer blocks until the state transitions. This is what makes real delegation programmable.

---

## Best-in-class UX answers (synthesis)

### Booting a new agent with prompt/skill

**Best:** Conductor's flow + Cursor's slash commands + Claude Code's skill discovery:

```bash
amux spawn code-reviewer "review PR #243 and post comments"
amux spawn web-research --skill researcher "find the top 5 prompt-caching benchmarks"
```

From the web UI: a single "+" button → modal with two fields (skill picker, prompt) → "Run" → workspace appears in sidebar with status=Working immediately. No multi-step register/start/send dance.

### Sending a slash command to an existing running agent

**Best:** amux already has `amux send <name> <text>`. v3 should add:
- `amux do <name> /<skill> [args]` — explicit skill invocation, distinguishes from raw text input.
- From the UI: command palette ⌘K → "@worker-2 /review-pr" with typeahead on both target and skill.
- Slash commands available via @ mention inside one agent's chat that dispatches to a peer (Conductor + Claude Code @-mention pattern, applied across sessions).

### Failure / crash / context-window-full recovery

**Best (combine amux + Conductor):**
- Watchdog auto-detects: corruption → restart with last message replay; context >85% → auto-compact; stuck prompt → auto-press option 1 (already in amux).
- **Plus** named checkpoints (Conductor): before every destructive op, snapshot. UI shows checkpoint dots on the timeline; click to roll back.
- **Plus** structured block-based history (Warp): replayable from any block on restart, not just "last message."
- **Plus** rate-limit aware fleet pause + auto-resume after the reset time (amux already has this — keep it).

### Status indicators: waiting / thinking / running

**Best (combining cmux notification rings + Herdr state model + Claude Code hook signals):**
- Six explicit states: **Working / Thinking / Tool-running / Needs-Input / Idle / Crashed**.
- Each state has a distinct color **and** a distinct icon (not color alone — accessibility, plus Conductor ships colorblind themes for a reason).
- Multiple signal sources, all required to converge: PTY activity, Claude Code hook callbacks, heartbeat ping, last-message timestamp, presence of a known "waiting for input" prompt pattern.
- Visible in three places: session card in dashboard, OS-level notification badge, mobile push.
- "Needs-Input" specifically: ring on the card + sound + push + badge. Don't bury it.

### Agent-to-agent delegation

**Best:**
- @mention semantics in chat: `@worker-2 review this diff` is parsed, dispatches a message, and inserts a clickable link in both sessions.
- Delegation graph view: nodes = sessions, edges = "asked X to do Y" with timestamps. Auto-built from REST API call history.
- `amux delegate <from> <to> <prompt>` CLI command for scripted delegation.
- `amux wait <session> --state done` blocking primitive (Herdr).
- Codex-CLI-style: each amux session is an MCP server endpoint by default, so any agent can call any peer as a tool.

### Parallel session display

**Best (Conductor's workspace grouping + cmux's metadata-dense sidebar):**
- Default view: kanban-grouped sidebar (Backlog / Working / Needs Review / Done / Archived).
- Each card shows: name, model, status indicator, branch, PR #, ports, last-message timestamp, token spend, last notification.
- Click → opens full session view with chat history, diff, terminal peek, files.
- Optional grid view (Cursor agent tabs): up to 4 sessions side-by-side for synchronous monitoring.

### Keyboard shortcuts (lock these in v3)
| Action | Shortcut |
|---|---|
| Command palette | ⌘K |
| Shortcuts sheet | ⌘/ |
| Spawn new agent | ⌘N |
| Jump to session 1–9 | ⌘1–9 |
| Next / prev session | ⌘] / ⌘[ |
| Send message | ⌘↩ |
| Focus URL/composer | ⌘L |
| Search chat | ⌘F |
| Toggle agent grid | ⌘G |
| Open diff | ⌘⇧D |
| Toggle plan mode | ⌥P |
| Trigger checkpoint | ⌘⇧S |
| Rollback | ⌘⇧Z |
| New skill invocation | / (in composer) |
| @ mention peer | @ (in composer) |
| Toggle mobile-tail | ⌘⇧M |

These match Conductor (⌘K, ⌘/, ⌘N, ⌘1–9) and cmux (⌘L, ⌘D, ⌘1–9). Don't invent new ones where conventions exist.

### Templates / presets / "boot a code-reviewer agent"

**Best (Claude Code skills + Conductor profiles + Codex AGENTS.md):**
- Skills live in `~/.amux/skills/<name>/SKILL.md` and `.amux/skills/<name>/SKILL.md` (global + project).
- Each skill defines: model, system prompt, allowed tools, allowed paths, env, hooks.
- Skills are invokable three ways: CLI (`amux spawn <skill>`), slash command (`/<skill>` inside any session), command palette (⌘K → pick skill).
- Marketplace/registry: a way to share skills (curated `amux skill install <name>`).
- AGENTS.md precedence chain: project-level overrides global.

---

## v3 must-have features (ranked by impact)

1. **Reliable status taxonomy with hook + heartbeat + PTY fusion.** Working / Thinking / Tool-running / Needs-Input / Idle / Crashed. Push to UI, OS notification, mobile push.
2. **One-command agent spawn with skill + prompt.** `amux spawn <skill> "<prompt>"`. UI = "+ New" → 2-field modal → done.
3. **Slash-command skill system** (`.amux/skills/<name>/SKILL.md`) with project + global precedence, marketplace install, and inline invocation in any session.
4. **Session card sidebar with metadata density**: branch, PR, ports, token spend, last notification, last activity timestamp — kanban-grouped by status.
5. **Workspace isolation via git worktree by default** (not just tmux dir lock). Auto-archive on PR merge; one-click restore from history.
6. **Checkpoints + rollback** (Conductor pattern) layered on top of the existing watchdog (amux pattern). Pre-destructive-op auto-snapshot.
7. **First-class agent-to-agent delegation**: @mention in chat, delegation graph view, `amux delegate`, `amux wait --state done` blocking primitive, each session as an MCP-server endpoint.
8. **Structured chat blocks** (Warp pattern): every agent turn is a discrete block with prompt + tool calls + output + exit code + duration. Replayable from any block.
9. **Command palette ⌘K** with fuzzy search across sessions, skills, board items, settings.
10. **Best-of-N execution** (`/best-of-n` slash command, Cursor + Mux pattern): same prompt to N models, compare outputs side-by-side, pick winner.
11. **Plan Mode + Execute Mode** with explicit handoff between agents (Conductor + Mux pattern).
12. **Live diff viewer** with side-by-side, multiline-comment selection, "mark as viewed," GitHub review-comment sync.
13. **Spotlight testing**: hot-swap branches in a single running dev-server instance, sync changes back to main repo without leaving workspace.
14. **Multi-model support**: at minimum Sonnet 4.7, Opus 4.7, GPT-5.x, Codex, Gemini. Per-skill default model. Cost cap per session.
15. **Token + cost dashboard with budget alerts** and per-session, per-skill, per-day rollups.
16. **MCP server interface for each session** — any agent (or external orchestrator) can drive any amux session via MCP tools.
17. **Policy files per project** (Mux pattern): YAML defining allowed tools, paths, network, env. Loaded at session start; auditable.
18. **Agentic git identity**: every commit tagged with the agent that authored it (e.g. `Co-Authored-By: amux/code-reviewer`).
19. **Session restore that resumes the agent process** (cmux pattern), including chat history and tool state — survive amux server restart.
20. **Mobile-first push + queueing**: real push notifications for Needs-Input; offline command queue with conflict resolution on reconnect.

## v3 nice-to-have

21. Browser pane with cookie/session import from local Chrome (cmux pattern); inline screenshot rendering in chat.
22. SSH/remote workspaces (cmux pattern) for running agents on cloud machines.
23. VS Code extension (Mux pattern) for editor-side workspace integration.
24. Linear / Jira / GitHub-Issues deep-link → "create workspace from issue."
25. Workspace forking and sharing (Mux pattern).
26. Mermaid + LaTeX rendering in chat (Mux + Conductor).
27. Colorblind themes + multiple syntax themes (Conductor's craft signal).
28. Per-completion sounds (Conductor — silly, memorable).
29. Chat table of contents + summarization (Conductor).
30. Vim mode in composer (Mux).
31. Workspace renaming with auto-suggested "city" names (Conductor's legendary tracking — it's a UX moat).
32. iCal feed for board items (amux already has this — keep).
33. Email integration (amux already has — clean it up).
34. Built-in cron scheduler for recurring agent jobs (amux already has — surface it better).
35. Auto-merge PRs when CI passes (Conductor).
36. Continue-on-new-branch for sequential work (Conductor).

## v3 explicit non-goals

- **Don't become a terminal emulator.** cmux owns that. amux is the orchestrator that uses tmux underneath. Stay above the terminal.
- **Don't ship native-only.** The single-Python-file run-anywhere story is amux's distribution moat. Don't trade it for an Electron app.
- **Don't build a meta-LLM planner.** OpenClaw's planner→router→specialist→iterator loop is a feature, not a foundation. Let humans (or external agents) write skills; amux executes them.
- **Don't reinvent slash commands.** Match Claude Code's `.claude/skills/<name>/SKILL.md` shape so existing skills port over (`.amux/skills/<name>/SKILL.md`).
- **Don't replace VS Code / Cursor.** Be the *orchestrator* they call into via MCP, not a competing editor.
- **Don't depend on a cloud account for OSS users.** Local-first must remain real. Cloud is opt-in for hosting and sync.
- **Don't ship without RBAC + audit log if "governance" stays in the marketing copy.** Either deliver the governance pillar or remove the claim.
- **Don't add 30 modules of equal weight.** CRM, notes, email, kanban, scheduler — pick the 2 that integrate tightest with agent workflow (kanban + skills) and polish them; relegate the rest to optional plugins.
- **Don't ship status indicators you can't make reliable.** cmux issue #1027 is a public warning. If a state can't be reliably detected, don't display it.
- **Don't break the "edit single file, server restarts" workflow** for power users — even if the underlying codebase becomes modular.

---

## Sources

- [cmux GitHub (manaflow-ai)](https://github.com/manaflow-ai/cmux)
- [cmux.com landing](https://cmux.com/)
- [cmux issue #1027 — status flaky](https://github.com/manaflow-ai/cmux/issues/1027)
- [cmux PR #1417 — command palette nav](https://github.com/manaflow-ai/cmux/pull/1417)
- [cmux PR #358 — initial command palette](https://github.com/manaflow-ai/cmux/pull/358)
- [cmux keyboard shortcuts docs](https://cmux.com/docs/keyboard-shortcuts)
- [coder/mux GitHub](https://github.com/coder/mux)
- [Mux docs (mux.coder.com)](https://mux.coder.com/)
- [amux GitHub (mixpeek)](https://github.com/mixpeek/amux)
- [amux CLAUDE.md](https://github.com/mixpeek/amux/blob/main/CLAUDE.md)
- [amux.io homepage](https://amux.io/)
- [amux.io features](https://amux.io/features/)
- [amux.io agent coordination](https://amux.io/features/agent-coordination/)
- [amux.io FAQ](https://amux.io/faq/)
- [amux.io blog — best multi-agent orchestrators 2026](https://amux.io/blog/best-multi-agent-orchestrators-2026/)
- [amux.sh (Jordan Webster, unrelated)](https://amux.sh/)
- [amux on App Store](https://apps.apple.com/us/app/amux-agent-multiplexer/id6760410435)
- [Conductor homepage](https://www.conductor.build/)
- [Conductor changelog](https://www.conductor.build/changelog)
- [Conductor docs](https://www.conductor.build/docs/)
- [Claude Squad GitHub](https://github.com/smtg-ai/claude-squad)
- [Claude Squad site](https://smtg-ai.github.io/claude-squad/)
- [Claude Code subagents docs](https://code.claude.com/docs/en/sub-agents)
- [Claude Code subagents 2026 guide](https://www.tembo.io/blog/claude-code-subagents)
- [Cursor 3.0 changelog](https://cursor.com/changelog/3-0)
- [Cursor product page](https://cursor.com/product)
- [Cursor 2026 guide (DeployHQ)](https://www.deployhq.com/guides/cursor)
- [Cursor 3 deep dive (digitalapplied)](https://www.digitalapplied.com/blog/cursor-3-deep-dive-agents-composer-review-2026)
- [Warp terminal](https://www.warp.dev/terminal)
- [Warp docs](https://docs.warp.dev/)
- [Warp 2026 guide (DeployHQ)](https://www.deployhq.com/guides/warp)
- [OpenAI Codex CLI features](https://developers.openai.com/codex/cli/features)
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference)
- [Codex subagents](https://developers.openai.com/codex/subagents)
- [Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md)
- [Codex with Agents SDK](https://developers.openai.com/codex/guides/agents-sdk)
- [Symphony — Codex orchestration spec](https://openai.com/index/open-source-codex-orchestration-symphony/)
- [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)
- [Herdr — terminal-native agent multiplexer](https://herdr.dev/)
- [Herdr compare](https://herdr.dev/compare/)
- [OpenClaw orchestrator (zeynepyorulmaz)](https://github.com/zeynepyorulmaz/openclaw-orchestrator)
- [OpenClaw managed agents](https://github.com/stainlu/openclaw-managed-agents)
- [OpenClaw mission control](https://github.com/abhi1693/openclaw-mission-control)
- [OpenClaw architecture explained](https://ppaolo.substack.com/p/openclaw-system-architecture-overview)
- [Command palette UX patterns](https://uxpatterns.dev/patterns/advanced/command-palette)
- [Claude Skills vs Slash Commands](https://www.mindstudio.ai/blog/claude-skills-vs-slash-commands)
- [Conductor review (The New Stack)](https://thenewstack.io/a-hands-on-review-of-conductor-an-ai-parallel-runner-app/)
- [Scaling the Loop — Conductor write-up](https://georgetaskos.medium.com/scaling-the-loop-run-5-claude-code-sessions-in-parallel-with-conductor-build-539b52888a81)
- [Inside Warp Ai Agentic Terminal (Medium)](https://medium.com/@XPII/inside-warp-ai-agentic-terminal-7ac9861dbfbe)
- [cmux: Three Layers of Multi-Agent UX (Codex blog)](https://codex.danielvaughan.com/2026/04/09/cmux-acpx-omx-three-layers-multi-agent-ux/)
- [cmux × pi: orchestration rig (joelhooks gist)](https://gist.github.com/joelhooks/11aea283acfd5a7f50e596bc63bbdd28)
- [cmux vs tmux (soloterm)](https://soloterm.com/cmux-vs-tmux)
