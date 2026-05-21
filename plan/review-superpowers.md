# Superpowers Review — Plan + Skill Alignment with Max-Parallel Intent

## Methodology used

**superpowers `brainstorming` skill** (`~/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/brainstorming/SKILL.md`), supplemented by the superpowers `dispatching-parallel-agents` skill for the parallelism analysis. Applied its core moves to a *review* context:

- **Explore context first** — read all three targets in full (TECH_PLAN.md 2640 lines, SKILL.md 1131 lines, user-vision.md) plus §0/§1.3/§3.4 for the concurrency + shared-file facts.
- **Design for isolation and clarity** — the brainstorming skill's central test ("can a unit be understood and changed without breaking consumers?") maps directly onto "can a worker subagent execute its milestone without colliding with the 7 others running concurrently?" That test exposed the biggest finding (no repo isolation).
- **YAGNI / scope-decomposition** — used to triage which time-cruft is functional vs. decorative, and to judge whether MAX_PARALLEL=8 is the real constraint or theatre.
- **The dispatching-parallel-agents constraint** — "Don't use when agents would interfere (editing same files, using same resources)" is the lens for the shared-file and git-contention findings.

The plan's "Anti-vision" and "Cross-cutting principles" in user-vision.md were treated as the fixed alignment frame the way brainstorming treats user intent as the gate.

---

## Alignment verdict

**MISALIGNED — FIXABLE (but with one P0 that currently makes `/amux-build start` unsafe to run).**

The plan and the user's intent (unlimited tokens, max parallel Opus subagents, 1-min tick, loop-til-perfect) are well matched in *spirit*. The orchestrator skill correctly implements: all-Opus everywhere, a 3-critic gate, 1-min self-tick, background dispatch, and a loop that re-derives state each tick. But two structural defects break the alignment:

1. **The skill is wired to a stale milestone graph.** The plan is now 30 milestones (M0–M29) with M23a/M23b and M24a/M24b splits and three new milestones (M27 Time-to-Wow, M28 Brand, M29 Perf). The skill still hardcodes the v1 27-milestone set (M0–M26, no splits, no M27–M29) with a different dependency table. If you run it as-is it will dispatch milestone IDs that don't exist in §10 and silently never build M27/M28/M29. This is a correctness blocker, independent of parallelism.

2. **All workers share one git working tree with no isolation and no merge protocol.** At MAX_PARALLEL=8+ this is the dominant risk, and it's the exact "agents interfere by editing same files / using same resources" anti-pattern the dispatching-parallel-agents skill warns against. The plan's own §3.4 admits the conflict-prone surfaces (`http.rs` registry line, `api.ts` stubs) and "mitigates" them by making every milestone *still edit the same shared file* — which is fine sequentially and a race at 8-wide.

The human-dev-time cruft the user flagged is real and pervasive (30 "Time budget: Xh" lines, "140-165h serial / 70-90h wall", "workers take 30 min to 8 hours", "4 days of building", a wall-hours kill-switch) but it is the *least* dangerous of the three issues — mostly cosmetic, with one functional exception (the kill-switch). Fix the graph and the isolation first.

---

## P0 findings (must fix before /amux-build start)

### P0-1 — Skill milestone graph is stale (27 vs 30); will dispatch nonexistent IDs and skip 3 milestones

- **Finding.** SKILL.md hardcodes `MILESTONES = [M0..M26]` (line 55), a 27-row dep table (lines 67–95), a `VISUAL_REQUIRED_MILESTONES = [M10..M23]` set, and a 27-entry state-init template (lines 462–489). The plan §10 ships **30** milestones: M0–M22, **M23a + M23b**, **M24a + M24b**, M25, M26, **M27, M28, M29**. The dep table also disagrees with the plan's v2 corrections (see §14 row 30): plan says M9 deps = {M3, M5}, skill says M9 deps = {M5}; plan M5 = {M3, M4} matches; plan M12 = {M11, M2, M5}, skill M12 = {M11}. The skill's `M24` "depends on M11..M23" and final-celebration critical path (`...M23 → M24...`) reference IDs that no longer exist as written.
- **Why it blocks max-parallel intent.** The orchestrator is "stateless, re-derive from the table" — so the table *is* the build. A wrong table doesn't just mis-order; it (a) dispatches `M23` and `M24` workers that find no `### M23 —` / `### M24 —` heading in §10 (the headings are `M23a`, `M24a`, etc.), causing every such worker to fail acceptance or hallucinate scope, and (b) **never dispatches M27/M28/M29 at all** — Time-to-Wow, brand/icon/sound, and the perf budget silently never get built. "Loop til everything PERFECT" cannot converge on milestones the orchestrator doesn't know exist.
- **Concrete fix.** Regenerate the skill's three milestone artifacts (Constants line 55, dep table, state-init template, VISUAL set, final-celebration critical path) directly from §10 + the §10 "Milestone dependency graph (visual — v2)" + §14 row 30. New set: M0,M1,M2,M3,M4,M5,M6,M7,M8,M9,M10,M11,M12,M13,M14,M15,M16,M17,M18,M19,M20,M21,M22,M23a,M23b,M24a,M24b,M25,M26,M27,M28,M29 (31 IDs — note M27/28/29 exist so it's 31 not 30; the plan's "30" count predates one of them, see P1-5). VISUAL set becomes M10–M23b + M27 + M28 (M28 ships icon/splash/toast UI; M29 is perf-measurement, no new surface). **Better still: make the skill read the dep table from §10 at runtime instead of hardcoding it**, so the plan stays the single source of truth (the skill already claims "if this table conflicts with the plan, the plan wins — re-read §10" at line 65, but then never actually re-reads it).

### P0-2 — All 8+ workers commit into one shared working tree with no isolation and no rebase protocol

- **Finding.** Every worker prompt sets `REPO ROOT: /Users/sandervm/amux-v3` (line 502) and STEP 4 is bare `git add + git commit ... If git push is configured, push` (line 520). There is **no `git worktree`, no per-milestone branch, no `git pull --rebase` before commit, and no working-tree lock**. Eight concurrent Opus agents will be editing files, running `cargo build`/`bun run build` (which write to shared `target/` and `node_modules/.vite`), and committing to the same `HEAD` and index simultaneously.
- **Why it blocks max-parallel intent.** This is the canonical "agents interfere — shared state" case from dispatching-parallel-agents. Concrete failure modes at 8-wide on one tree:
  - **Index/commit races:** two workers staging at once → one's `git add` captures the other's half-written files; commits interleave; a worker's "commit SHA" in done.json may not contain only its own changes (poisons the Acceptance + Principle critics, which `git diff <sha>^..<sha>`).
  - **Build-artifact thrash:** parallel `cargo build` on one `target/` and parallel `vite` dev-servers/builds on one `web/` cause lock contention and spurious build failures the critics will read as real failures → infinite retry → kill-switch trip. (Note: the Visual critic *also* boots `bun run dev` on a fixed port 5173 — see P0-3.)
  - **Genuine merge conflicts on the admitted shared files:** §3.4 says M6/M7/M8/M9 each "add ONE line in `http.rs::router()`" and M0's `api.ts` is filled by M12/M14/M19/M20/M21/M22. "One line each" is conflict-free *serially*; concurrently it's 4 simultaneous edits to the same `http.rs` line-region and 6 to `api.ts`. The plan's mitigation reduces blast radius but does not make it safe at 8-wide.
- **Concrete fix (pick one, in order of preference):**
  1. **Per-milestone git worktrees.** Worker prompt gets `git worktree add ../amux-v3-wt/<M_ID> -b m/<M_ID>` then works/commits there; orchestrator merges `m/<M_ID>` to main *serially* during the harvest step (orchestrator is single-threaded, so merges are naturally sequential — the right place to absorb conflicts). This is the superpowers `using-git-worktrees` pattern and the cleanest fit for "max parallel + unlimited resources." Each worker gets its own `target/` and `node_modules` via the worktree (or a shared sccache/`CARGO_TARGET_DIR` per worktree).
  2. **Per-milestone branches on the shared tree + serialized integration**, with a working-tree mutex so only one worker touches the index at a time (defeats most of the parallelism — not recommended given the intent).
  3. **At minimum** (if worktrees are too heavy for v3.0): add to STEP 4 a `git pull --rebase` retry loop mirroring the existing MAX_PUSH_RETRIES logic, set `CARGO_TARGET_DIR=/tmp/amux-target-<M_ID>` and a per-worker Vite cache dir in the worker env, and have the orchestrator only ever dispatch *one* worker per shared-file family per wave (e.g., never two of {M6,M7,M8,M9} concurrently). This last clause caps real concurrency well below 8 — which is the honest answer to "is 8 the right cap" (see Parallelism analysis).

### P0-3 — Visual critics collide on fixed dev-server port 5173

- **Finding.** Every Visual critic boots `bun run dev` expecting `http://localhost:5173` (UI_DEV_SERVER_URL, line 59; critic STEP 2 polls 5173). Critics run in parallel across milestones (Step 6 dispatches "all applicable critics in parallel"), and the orchestrator can have multiple UI milestones in `awaiting_critic` at once. Two Visual critics booting Vite on 5173 → second fails to bind (or attaches to the first's server and screenshots the wrong milestone's UI).
- **Why it blocks max-parallel intent.** The whole point of the 3-critic-per-milestone design is to not bottleneck on review. But a hard-coded shared port serializes (or corrupts) Visual review exactly when parallelism is highest. With unlimited resources the user expects N Visual critics to run truly concurrently.
- **Concrete fix.** Allocate a unique port per Visual critic invocation: `PORT=$((5173 + <slot>))` (or a random free port), pass `--port` to `bun run dev`, and template the URL from it. Same for the optional backend boot (`18823` is referenced in the visual prompt — also fixed). Each Visual critic should boot in an isolated worktree/checkout of the milestone's commit (`git worktree add` at `<sha>`), not the live shared tree (otherwise it screenshots whatever HEAD happens to be mid-wave).

---

## P1 findings (should fix)

### P1-1 — Kill-switch is wall-clock-hours based, which is meaningless under "unlimited parallel"

- **Finding.** `MAX_WALL_HOURS = 100` ("≈ 4 days of continuous building", line 1005) auto-pauses on elapsed real time. Under the user's model (unlimited tokens, 8–20 parallel Opus, loop-til-perfect) wall-clock is not a resource being conserved — it's irrelevant. Worse, `hours_elapsed` is measured from `started_at` and keeps ticking through rate-limit cooldowns and overnight idle, so a build that's progressing fine but spread over 5 calendar days trips the switch for no real reason.
- **Impact.** Spurious pauses that require `override-killswitch`, fighting the user's explicit "blijven loopen tot alles PERFECT."
- **Fix.** Drop wall-hours as a kill condition. Keep a **runaway-detector** that actually signals "structurally wrong": (a) `MAX_TOTAL_COMMITS` (keep — commits are the real proxy for churn), and (b) a **per-milestone failure ceiling already exists** (MAX_RETRIES=3 → `blocked`). Add a global "**no-progress**" guard: if a full tick cycle produces zero new `completed` milestones AND zero milestones changed status across, say, 30 consecutive ticks while agents are active, pause and surface — that catches genuine livelock without penalizing slow-but-progressing builds. Reframe the kill-switch section around commits + no-progress, delete the "4 days" prose.

### P1-2 — MAX_PARALLEL=8 is justified by a constraint that doesn't survive scrutiny; the real cap is lower until P0-2 is fixed and higher after

- **Finding.** Line 48 justifies 8 as "the practical cap for terminal session limits + file-conflict risk." But (a) workers are `claude -p` *headless* processes, not tmux/terminal sessions — there is no terminal-session limit; the comment is incorrect. (b) "file-conflict risk" is real but is being used to cap throughput instead of being *fixed at the source* (P0-2). See Parallelism analysis for the number.
- **Impact.** The cap is set on a wrong rationale, and the dep-graph means 8 is rarely even reached (see below) — so it's simultaneously mis-justified and mostly inert.
- **Fix.** After P0-2 (worktree isolation), the only real constraints are: Anthropic API rate limits (already handled by the rate-limit gate), local CPU/RAM for parallel `cargo`/`vite` builds, and disk for N worktrees + N `target/` dirs. On a dev box those allow ~12–16 comfortably. Recommend MAX_PARALLEL=12 with a note that the effective ceiling is the dep-graph width (≤7), so 12 only matters during the two wide phases.

### P1-3 — 1-minute tick can under-dispatch on a near-simultaneous wave finish, and the critic step blocks the tick

- **Finding.** The auto-tick re-invokes every 60s. Workers take "30 min to 8 hours," so 60s is plenty to *detect* completion. But Step 6 runs critics **inline/foreground** with up to 15-min timeouts, and the orchestrator does Step 5 (harvest) → Step 6 (critics, blocking) → Step 8/9 (dispatch) **sequentially within one invocation**. If a wave of 8 UI milestones finishes near-simultaneously, one tick harvests all 8, then sits in Step 6 running 8×(up to 15-min Visual critics) before it reaches Step 9 to refill the freed worker slots. During those up-to-15 minutes, **all 8 worker slots sit idle** because dispatch hasn't run yet.
- **Why it matters for the intent.** "MAX subagents, zoveel mogelijk parallel" wants slots saturated. A harvest→critic→dispatch chain that blocks dispatch behind critics leaves the machine idle exactly after a big completion.
- **Fix.** Decouple critics from the dispatch path. Two options: (1) **Dispatch first, critique after** — within a tick, do Step 5 (harvest → `awaiting_critic`), then **immediately** Step 8/9 (compute ready set treating `awaiting_critic`-but-not-yet-passed deps appropriately and dispatch ready workers to refill slots), and only *then* fire critics in the background (as `run_in_background` `claude -p` like workers, writing verdict JSON the *next* tick harvests). This makes critics behave exactly like workers (async artifact-on-disk) and removes the only blocking step. (2) If you keep critics inline, raise tick frequency isn't the fix — making critics async is. Note this also requires the dep-graph to treat a milestone as "done for dependents" only after critics PASS, which it already does (deps need `completed`, not `awaiting_critic`), so async critics are safe.

### P1-4 — `total_commits = sum(critic_attempts)` is a wrong proxy and interacts badly with the commits kill-switch

- **Finding.** Line 957/964 computes total commits as `sum(critic_attempts)` — but a worker is told (worker prompt line 549) it may legitimately produce **up to 50 commits** for one milestone ("COMMIT SMALLER and use multiple commits"). So one milestone can be 50 real commits but contributes `critic_attempts = 1` to the counter. The kill-switch's own "1000 commits" reasoning ("≈37 commits per milestone") is computed against attempts, not commits. The proxy under-counts real commits by up to 50× and the limit's stated rationale is internally inconsistent.
- **Impact.** Either the runaway guard never fires when it should (50-commit-per-milestone storm shows as 30 "commits"), or the prose misleads. Low severity because the real backstop is MAX_RETRIES, but it's a correctness wart in a safety mechanism.
- **Fix.** If you keep a commit ceiling, count actual commits: `git rev-list --count <started_sha>..HEAD`. Or drop it in favor of the no-progress guard from P1-1.

### P1-5 — Plan's own milestone count is inconsistent (says "30", actually 31 after splits/additions)

- **Finding.** §0 and §14 say "30 milestones (M0–M29)." But the a/b splits add net IDs: M0–M22 (23) + M23a,M23b (2) + M24a,M24b (2) + M25,M26,M27,M28,M29 (5) = **32 discrete buildable units**, or 30 if you still count M23/M24 as one each. The §10 "Final numbers" line says 30; the §10 dependency graph lists M27/M28/M29 plus the splits. The skill must pick the discrete-unit count (32) since it dispatches one worker per heading.
- **Impact.** Compounds P0-1 — whoever regenerates the skill graph must use the discrete heading list from §10, not the prose "30."
- **Fix.** Reconcile the count in §0/§14 to the discrete heading list, and have the skill enumerate headings from §10 (`grep '^### M' TECH_PLAN.md`) rather than trust any prose number.

### P1-6 — Anti-vision "no UPPERCASE labels" check will false-positive on the Principle critic's own grep

- **Finding.** Principle critic STEP 3b greps diffs for `"[A-Z]{4,}"` to catch UPPERCASE labels. Many legitimate strings match (e.g., `"AMUX"` fallback prefix mandated by M6's `board/prefix.rs` "no session → 'AMUX'", env var names, `"NetworkFirst"`/`"CacheFirst"` Workbox strategies in M23b, HTTP header names). The critic is told to FAIL on UPPERCASE — risking spurious FAILs → retries → churn against the kill-switch.
- **Impact.** False FAILs burn the loop. Minor but real friction against "loop til perfect."
- **Fix.** Scope the UPPERCASE check to JSX text nodes / button/label children, not all string literals; or give the critic an explicit allowlist (env vars, known constants, the AMUX prefix). The skill already gestures at this (`grep -vE '(const|type|enum|import...)'`) but it's not enough.

---

## Human-dev-time cruft inventory (user wants removed)

| File | Line/Section | Text | Verdict |
|---|---|---|---|
| TECH_PLAN.md | §0 line 22 | "Total estimated time: **140-165 engineering-hours serial; 70-90 wall-clock hours realistic with 4-way parallelism**" | **REMOVE** — pure human-dev cruft; meaningless with unlimited AI subagents |
| TECH_PLAN.md | §0 line 22, §10 line 2435 | "(14 milestones, ~85h serial)" critical-path hours | **REFRAME** — keep the critical-path *milestone chain* (load-bearing for the orchestrator), drop the "~85h" |
| TECH_PLAN.md | §10 — all 30 milestones | "**Time budget**: 2h / 5h / 6h / 8h / 14h / 10h / 11h / 9h / ..." (lines 2035, 2048, 2058, 2072, 2091, 2108, 2118, 2128, 2138, 2148, 2158, 2174, 2184, 2194, 2207, 2221, 2231, 2241, 2251, 2261, 2271, 2284, 2294, 2304, 2314, 2324, 2334, 2344, 2354, 2364, 2377, 2392) | **REMOVE** — 32 lines of human-hour estimates; the orchestrator ignores them and they directly violate the user's "geen tijdsindicatie bs" instruction |
| TECH_PLAN.md | §10 milestone notes | "(was 6h — CEO amplification)", "(was 10h in v1 — bumped per Codex #10 LOC honesty)", "(was 8h — CEO + Codex LOC honesty for Vaul iOS debugging)" etc. | **REMOVE** the hour deltas; **KEEP** the scope-rationale ("CEO amplification", "+skeleton/error/quick-peek") which is real scope info |
| TECH_PLAN.md | §14 line 2619 | Row 28 "Time estimates dishonest ('50 wall-clock hours')" → "restated as 140-165 engineering-hours serial; 70-90 wall-clock" | **REFRAME** — this is review *history*; rewrite to "time estimates removed — build is AI-subagent driven, not human-hour budgeted" or strike the row |
| TECH_PLAN.md | §14 line 2634 | "**Total estimated time**: 140-165h engineering-hours serial...; 70-90h wall-clock" | **REMOVE** |
| TECH_PLAN.md | §10 lines 2030–2393 | "**Scope** (~250 LOC)", "(~500 LOC)", "(~700 LOC)" etc. | **KEEP** — LOC is a scope-size signal for the worker (rough budget for "is this milestone the right size / am I over-building"), not a human-time estimate. Borderline but functional. |
| SKILL.md | line 422 | "Workers take 30 min to 8 hours. You cannot block on them." | **REFRAME** — the *fact* (workers are long-running, don't block) is functional; the "30 min to 8 hours" number is invented human-equivalent cruft. Rewrite: "Workers run to completion in the background; never block on them." |
| SKILL.md | line 1104 | "they take 30 min to 8h" | **REFRAME** — same as above |
| SKILL.md | line 53, 956, 967, 985, 1018, 1005 | `MAX_WALL_HOURS = 100`, "Wall hours elapsed: <N> / 100", "100 hours ≈ 4 days of continuous building" | **REMOVE/REPLACE** — see P1-1. This is a *functional* safety cap, but wall-clock is the wrong metric under unlimited-parallel. Replace with commits + no-progress guard. The "4 days" prose is pure cruft. |
| SKILL.md | line 1069 | Gantt "Each `─` = ~2 min of wall time" | **KEEP-or-trivial** — it's a display nicety for the status Gantt, not a budget. Harmless; can stay or be simplified to "proportional to wall time." |
| SKILL.md | line 1114 | "False rate-limit stamps cost 30 min of progress." | **KEEP** — this 30 min refers to `RATE_LIMIT_BACKOFF_MIN=30`, a real configured value, not a human-dev estimate. |
| SKILL.md | line 5–8 (frontmatter desc), line 1005, 1084, 1088 | "loops until M0..M26 are done", "27 milestones", "review the 27 commits", critical path "...M23 → M24..." | **FIX (P0-1)** — not time-cruft but stale-count cruft; must be regenerated to the 31/32-milestone reality |

Net: ~36 lines of pure human-time estimate to remove (32 "Time budget" lines + the §0/§14 totals + the worker "30 min to 8h" phrasings), the wall-hours kill-switch to re-engineer, and the LOC/scope notes to keep.

---

## Parallelism analysis

- **Effective max concurrency given the dep-graph: ~7** (not 8, and rarely sustained). Computed from the plan's v2 dep graph:
  - **Phase 1 (start):** only M0 is ready → **width 1**. Hard serial.
  - **Phase 2 (after M0):** M1 and M10 ready → **width 2**.
  - **Phase 3 (after M1):** backend fan-out M2, M6, M7 ready (M8 needs M3) plus M10's children once M10 lands. Realistic **width 3–5**.
  - **Phase 4 (widest):** once M10 + the backend deps land, the independent route milestones open: **M19, M20, M21, M22** (4-way) + **M16, M17, M18** (3-way, after M15) + M28 (anytime) + M29 (after M13) can overlap. This is the only place the graph approaches/exceeds 8 — briefly **width 7–9** if M16/17/18 and M19/20/21/22 phases overlap.
  - **Phase 5 (tail):** M23a→M23b→M24a→M24b→M25→M26→M27 is a near-linear chain → **width 1–2**. Hard serial again.
- **So the dep-graph, not MAX_PARALLEL, is the binding constraint** for most of the build. Raising the cap from 8 to 16 changes nothing except during the one mid-build wide phase. The user's "MAX parallel" intent is satisfied *if and only if* the graph is flattened (below) AND repo-isolation (P0-2) lets the wide phase actually run concurrently.
- **Recommended MAX_PARALLEL: 12.** Rationale: after P0-2's worktree isolation removes file-conflict as a throttle, the real limits are API rate (gated already) and local CPU/disk for parallel cargo/vite builds. 12 covers the widest realistic phase (≈9) with headroom for critic subagents, without thrashing a dev box. 16–20 buys nothing given the graph width and risks build-tool RAM pressure.
- **Critical-path serialization that is unavoidable:** `M0 → M1 → M3 → M4 → M5` (the first five run essentially 1-at-a-time; M2/M6/M7 can sidecar after M1 but the M3→M4→M5 backbone is a hard chain), and the entire tail `M23a → M23b → M24a → M24b → M25 → M26 → M27`. These two chains dominate end-to-end latency regardless of cap.
- **Restructuring opportunities to flatten the critical path:**
  1. **Split M5 (status detector, the 14h/largest backend milestone)** into M5a (regex bank + detector core + golden fixtures) and M5b (hook endpoint + SSE writeback + wait-channel). M5a needs only M3; M5b needs M4. This lets M5a start the moment M3 lands, parallel with M4, instead of waiting for both. Shortens the M3→M4→M5 backbone.
  2. **Decouple M4 (WS pty) from the M3 chain where possible.** M4 needs M3 for tmux/capture, but the pty FIFO plumbing (§3.2.7) is largely independent of lifecycle. A thin "M3-lite" (tmux spawn + capture-pane only) could unblock both M4 and M5a earlier, deferring clone/archive/wake to an M3b.
  3. **The tail is the worst offender.** M23a→M23b→M24a→M24b→M25→M26→M27 is 7 serial milestones at width ≤2. M28 (brand) and M29 (perf) are already parallel-anywhere — good. Consider: M23b (PWA) only soft-needs M23a (it needs `useConnection` store, but PWA scaffolding is independent) — splitting the store into M23a and PWA into a parallel M23b-indep would let them co-run. M27 (Time-to-Wow) depends on M11–M15 + M23a/b + M26 — it genuinely must be late, accept it.
  4. **M24a (smoke) is already correctly pulled early (after M14)** — good flattening move, keep it.
- **Net:** with the two splits above, the mid-build wide phase widens and the backend backbone shortens by ~1 milestone of latency. The tail stays serial by nature (integration → deploy → migrate → onboarding is inherently ordered).

---

## Kill-switch recommendation

**Move from wall-hours to commits + no-progress, and lean on the per-milestone failure ceiling that already exists.** Under "unlimited tokens, loop til perfect," the only thing worth auto-halting for is *structural breakage* (a milestone that can't converge, or a churn storm), never elapsed time.

Recommended kill conditions:
1. **Per-milestone:** keep `MAX_RETRIES = 3` → `blocked` (already present, correct). This is the real safety net.
2. **Global churn:** keep a commit ceiling but **count real commits** (`git rev-list --count <start>..HEAD`), not `sum(critic_attempts)` (P1-4). Set generous (e.g., 2000) since unlimited resources + smaller-commits guidance means more commits are expected/healthy.
3. **Global livelock (new):** if N consecutive ticks (e.g., 30 ≈ 30 min) pass with at least one active agent but zero milestones transitioning to `completed` and zero status changes, pause and surface "no forward progress." This catches the genuine "stuck in a loop" the user fears, by measuring *progress*, not *time*.
4. **Delete `MAX_WALL_HOURS` entirely** and strike the "4 days of continuous building" rationale.

This aligns the safety story with the philosophy: stop when the build is *stuck*, not when the *clock* runs out.

---

## Bottleneck analysis

Where the orchestrator under-saturates or serializes, in priority order:

1. **Harvest → (blocking critics) → dispatch within one tick (P1-3).** The single biggest saturation killer. After a big wave finishes, all freed slots sit idle for up to 15 min while inline Visual critics run before dispatch executes. Fix by making critics async background artifacts like workers, and dispatching *before* critiquing.
2. **Shared dev-server port 5173 across Visual critics (P0-3).** Serializes Visual review and corrupts screenshots under concurrency — exactly when many UI milestones land together.
3. **Single shared git tree (P0-2).** Forces *de facto* serialization the moment you try to run the wide phase honestly — either via the recommended "one worker per shared-file family per wave" clamp (caps real width well below 8) or via build-artifact contention. Worktrees remove this entirely.
4. **Dep-graph width (structural, not a bug).** Most of the build is width ≤5; only one phase approaches 8. No amount of orchestrator tuning changes this — only the plan restructuring in the Parallelism section does. This is the honest ceiling on "MAX parallel."
5. **state.json write contention (minor).** The orchestrator is single-threaded per invocation and stateless between, so there's no concurrent-writer lock problem *within* the design. The only risk is two overlapping invocations (manual `resume` + auto-tick firing ~simultaneously) both writing state.json — the skill's "Idempotency" section (line 936) argues this is safe (worst case one redundant tick), and that reasoning holds because every action re-derives from disk. Not a real bottleneck; flagged only for completeness.

---

## Summary table for the user (P0/P1 + advice)

| Priority | Finding | My advice |
|---|---|---|
| P0-1 | Skill hardcodes 27 milestones; plan has 30/31 with M23a/b, M24a/b, M27/28/29 splits + corrected deps | Regenerate the skill's milestone table + state-init + VISUAL set from §10, or make the skill read §10 headings at runtime. Blocks any correct run. |
| P0-2 | All 8+ workers share one git tree, no worktree/branch/rebase | Give each worker a `git worktree` + branch + own `CARGO_TARGET_DIR`; orchestrator merges serially on harvest. Without this, 8-wide corrupts commits/critics. |
| P0-3 | Visual critics all bind dev port 5173 | Per-critic unique port + isolated checkout of the milestone's commit. |
| P1-1 | Wall-hours kill-switch meaningless under unlimited-parallel; trips on calendar time | Delete MAX_WALL_HOURS; replace with commits + a no-progress (livelock) guard. |
| P1-2 | MAX_PARALLEL=8 justified by a wrong reason ("terminal sessions"); graph rarely reaches 8 anyway | Set 12 after P0-2; document that dep-graph width (≤~9) is the true ceiling. |
| P1-3 | Inline critics block dispatch → idle slots after a wave finishes | Make critics async background artifacts (like workers); dispatch before critiquing. |
| P1-4 | Commit kill-switch counts `sum(critic_attempts)`, not real commits (off by up to 50×) | Count `git rev-list` commits, or drop in favor of no-progress guard. |
| P1-5 | Plan's own "30 milestones" count is inconsistent with its discrete heading list (32) | Reconcile §0/§14 count; skill should enumerate §10 headings, not trust prose. |
| P1-6 | Principle critic UPPERCASE grep false-positives on AMUX, env vars, Workbox strings | Scope the check to JSX text/labels + an allowlist; prevents spurious FAIL→retry churn. |
| Cruft | ~36 lines of human-dev-hour estimates (32 "Time budget" + §0/§14 totals + "30 min to 8h") | Remove all per-milestone hour budgets and the serial/wall-clock totals; keep LOC scope notes and the critical-path *milestone chain*. |

---

## P0/P1 summary for user decision

- **Do NOT run `/amux-build start` until P0-1 is fixed.** The skill is wired to the old 27-milestone graph; as-is it will dispatch nonexistent IDs (M23, M24) and never build M27/M28/M29. Quickest durable fix: have the skill read the milestone list and deps from §10 at runtime instead of hardcoding them. **Recommend: fix.**
- **Add git-worktree isolation per worker (P0-2)** before going wide. One shared working tree + 8 concurrent committers will corrupt commit SHAs (which poisons your critics) and thrash the build cache. This is the single change that makes "MAX parallel" actually safe. **Recommend: worktree-per-milestone, serial merge on harvest.**
- **Give each Visual critic its own port + an isolated checkout (P0-3).** Otherwise concurrent UI reviews collide on 5173 and screenshot the wrong UI. **Recommend: fix.**
- **Replace the wall-hours kill-switch with a no-progress (livelock) guard + real-commit ceiling (P1-1/P1-4).** Wall-clock is the wrong metric for an unlimited-token, loop-til-perfect build; stop when *stuck*, not when the *clock* runs out. **Recommend: re-engineer.**
- **Make critics async like workers and dispatch-before-critique (P1-3).** Today a wave finishing leaves all slots idle for up to 15 min while inline Visual critics run. This is the biggest saturation leak. **Recommend: fix for true saturation.**
- **Set MAX_PARALLEL=12, but know the dep-graph caps real width at ~7–9 (P1-2).** The honest answer to "could it be 16/20": yes safely after P0-2, but it buys almost nothing because the milestone graph is mostly narrow. **Recommend: 12 + accept the graph is the real limit.**
- **Flatten the critical path by splitting M5 (and optionally M3/M4)** if you want the wide phase wider and the backend backbone shorter. The tail (M23a→…→M27) is inherently serial — accept it. **Recommend: optional, do M5 split if maximizing parallelism matters.**
- **Strip the ~36 lines of human-dev-hour estimates** (32 "Time budget: Xh" + the §0/§14 "140-165h / 70-90h" totals + the skill's "30 min to 8h"); keep the LOC scope hints and the critical-path milestone *chain* (those are functional). This is the user's explicit "geen tijdsindicatie bs" ask — cosmetic, do it last, but do it. **Recommend: remove.**
