# Execution Playbook & Agent Structure — Grok-class UI (Tracks A+B)

Companion to `2026-08-13-claude-chat-renderer.md` (the master plan, v3). That document says **what** to build; this one says **who builds it and how**: the orchestration architecture, agent roles, model/effort policy, workflow topologies, review rotation, and gates. The orchestrator (the main session) owns process and content end-to-end and involves the owner only at the gates in §7.

## 1. Model & effort policy (hard rules)

- **Models: Fable 5 and Opus 5 only — for everything. Never sonnet/haiku, never a silent fallback.** Division of labour (owner decision 2026-08-13 — token economy):
  - **Opus 5 = the workhorse**: all implementers (actual code writing), routine spec/code reviewers, probes, fixture/corpus work, visual-bench capture, audit fan-outs. Effort dial does the quality lifting (`high` for core code, `medium` for mechanical tasks).
  - **Fable = the judgment layer, spent where one pass must be right**: the orchestrator itself, fase-plan writers, gate-verdict syntheses, design one-shots (mark system B0, chat-WS protocol A2, motion spec A3), plan reviews of those designs, and the final adversarial verify on confirmed blockers before a PR.
  - Mechanically: every `agent()`/Agent call passes `model` **explicitly** (`'opus'` or `'fable'` per the table below); custom agentTypes (e.g. `claude-code-guide`) get the explicit override too, so an agent definition's own model can never leak in.
- **Effort is the orchestrator's dial** (Fable's primary intelligence/cost trade-off):

| model · effort | used for |
|---|---|
| fable · `xhigh` | one-shot syntheses: gate verdicts, mark-system design (B0), chat-WS protocol design (A2), motion-spec addendum (A3) |
| fable · `high` | fase-plan writers, plan reviews of the xhigh designs, final adversarial verify on confirmed blockers pre-PR |
| opus · `high` | core implementers (renderer primitives, data plane, watchdog), all routine reviewers (spec/code/finders/refuters), probes with judgment (dialog fingerprinting, latency analysis) |
| opus · `medium` | routine implementers (mechanical tasks from a TDD plan), fixture anonymization, screenshot capture, doc updates |
| opus · `low` | never for judgment; only truly mechanical batch chores — and even then prefer doing it inline in the orchestrator (memory: mechanical git work inline, not chained subagents) |

- **Fable-style prompting for every subagent** (per the prompting guide, applied):
  1. **Reason before request**: every prompt opens with *why* — what the larger task is, who it's for, what the output enables (the CTX blocks used in prior workflows are the template).
  2. **Goal, not steps**: state the outcome and constraints; let the agent choose its route. No over-prescriptive checklists — Fable degrades under them.
  3. **Evidence discipline**: "Before reporting, audit each claim against a tool result from this session. Only report work you can point to evidence for; if unverified, say so." (This clause goes in every builder/verifier prompt — it's what killed the fabricated-status problem in testing, and this repo's history demands it: `reverify-subagent-live-claims`.)
  4. **Boundaries**: what the agent must NOT touch (no commits on main, no release builds, no editing migrations, never restart :8824, scratchpad for temp files).
  5. **Return contract**: final text is consumed by the orchestrator — raw data/report, ranked findings, no pleasantries; write big artifacts to files and return paths + the content.
  6. **Autonomy clause** for long runs: act when you have enough information; end only when done or blocked on the orchestrator.

## 2. The agent structure (org chart)

```
OWNER (reviews every PR merge; decides §7 gates)
  │
ORCHESTRATOR — main session, Fable
  │  sequencing, gates, prompt authoring, reviewer rotation, memory,
  │  mechanical git/PR work INLINE (worktrees, rebases, gh pr create)
  │
  ├─ per fase ──────────────────────────────────────────────┐
  │                                                          │
  │  PLANNER (fable, high) ──► TDD fase-plan                 │
  │       ▲ revision loop                                    │
  │  PLAN-REVIEWERS ×2 (opus high; fable for the xhigh       │
  │    design docs; rotated lenses)                          │
  │                                                          │
  │  IMPLEMENTERS ×N (opus, medium/high) — ALL code writing  │
  │    fresh agent per plan-task, shared fase-worktree,      │
  │    sequential per file-cluster, parallel across clusters │
  │       │ each task gated by                               │
  │  SPEC-REVIEWER (did it build what the task says?)        │
  │  CODE-REVIEWER (is it good? matches repo idiom?)         │
  │    (opus, high; persona pool §5, rotated)                │
  │                                                          │
  │  VERIFIER (opus, high) — runs cargo check/test, vitest,  │
  │    Playwright VR, size-budget; evidence-only reports     │
  │  VISUAL BENCH (opus, medium) — drives the offline        │
  │    mobile rig + dev routes, captures PNGs at DPR=1,      │
  │    READS the images, diffs against the design spec       │
  │                                                          │
  │  ADVERSARIAL WAVE (pre-PR): FINDERS ×3 (opus high,       │
  │    rotated lenses) → REFUTERS ×2/finding (opus high;     │
  │    fable on confirmed blockers) — majority kills;        │
  │    loop-until-dry (2 clean rounds) on risky fases        │
  └──────────────────────────────────────────────────────────┘
```

Standing roles outside the fase loop:
- **claude-code-guide** agent (explicit `model:'opus'`) — consulted whenever Claude Code behavior is in question (hook payloads, flag semantics) instead of guessing.
- **corpus-keeper** (opus, medium) — re-captures the fixture corpus + dialog fingerprints on every Claude Code version bump; diffs against the checked-in set; raises a blocking finding when the registry version-lock must engage.
- **plan-consistency verifier** (fable, high) — re-run after any master-plan edit wave.

## 3. Canonical workflow topologies

Three reusable shapes; every fase instantiates one (agent counts tuned per fase, guideline ≤15 per workflow — chain workflows across turns for larger fases, orchestrator in the loop between them).

### W-SPIKE (fases A0; B0 mockups)
```
parallel probes (3-5, fable high, independent evidence targets)
  → synthesis (1, fable xhigh) → gate verdict vs pre-agreed numbers
```
A0 concrete: probe-1 transcript granularity+latency (instrumented live turn, text-heavy + tool-heavy); probe-2 dialog capture + key mapping (sandbox session on a side port, every act-on dialog variant, real captures); probe-3 hooks/statusline verification (PermissionRequest payload, statusLine chaining, `-o /dev/null` fix + its mini-PR); probe-4 corpus anonymization + fixture check-in. Synthesis writes the A0 findings doc + gate verdict. ~5-6 agents.

### W-BUILD (fases A1-A5, B0-B4)
```
planner (1) → plan-reviewers (2, parallel) → planner revision
  → pipeline(tasks): implementer → spec-review → code-review   [pipeline, no barrier:
       task N+1's implementer starts while task N is in review; file-cluster locks
       prevent same-file races]
  → verifier (tests+budget) + visual bench (screenshots)  [parallel]
  → adversarial wave: finders(3) → refuters(2/finding)    [barrier: dedup before refute]
  → orchestrator: fix-tasks for confirmed findings (implementer+review loop)
  → orchestrator inline: rebase, CI, PR → OWNER
```
Typical: 12-20 agents per fase depending on task count. Implementers get *only* their task + interfaces (per subagent-driven development); reviewers get task + diff + plan.

### W-POLISH (fases A6, B5)
```
parallel audit fan-out (motion / a11y / reconnect / perf / real-device checklist, 4-5 fable high)
  → dedup + fix pipeline (implementer→review per confirmed item)
  → full visual regression sweep + budget gate
```

## 4. Parallelism & sequencing across fases

- **Two lanes, one merge queue.** Track A and Track B run as parallel lanes where the master plan's gates allow: `A0 → A1 → A2 → A3 → A4 → A5 → A6 → A7` and `B0 → B1 → B2 → B3/B4 → B5`, with B0 startable immediately after A0 (no dependency), B1 parallel to A3/A4, B2 gated on A5's rollup+reply loop, B4 on A2. Each fase = own worktree off `origin/main` (concurrent-agents rule: never work in the main checkout).
- **The owner's review bandwidth is the real bottleneck** — PRs are sized for reviewability (one fase = one PR; A0's hook fix and B1's scheduler fold are deliberately small standalone PRs) and queued so at most ~2 are open at once. The orchestrator keeps building the next fase in its worktree while a PR waits, rebasing after each merge (fetch first — local main goes stale).
- **Within a fase**: research/probes always parallel; implementation pipelined per file-cluster; reviews pipelined behind implementers; only dedup/synthesis points use barriers.
- **Long-running background work** (VR suites, corpus captures) runs as background tasks; the orchestrator schedules around them instead of blocking.

## 5. Reviewer rotation & anti-overfitting

- **Persona pool** (lenses, not people): design-fidelity vs evidence · repo-feasibility · product-coherence/anti-lookalike · correctness/failure-scenario · security/permissions · a11y/mobile · performance/budget · "fresh eyes" (no prior context, reads only the diff + task).
- **Rotation rules**: (1) no lens reviews the same author-agent's output twice in a row; (2) every fase's adversarial wave uses ≥1 lens that hasn't run in the previous two fases; (3) plan reviews always pair one evidence lens with one feasibility lens.
- **Overfitting detection** (orchestrator checks after each wave): a reviewer whose findings become style-nits, repeat earlier rounds verbatim, or rubber-stamp ("sound after scrutiny" on >80% of sections two waves running) is rotated out for a fresh persona; a finder whose findings get majority-refuted twice is replaced. Findings are deduped against the *seen* set (not the confirmed set) so refuted findings can't resurface as "new".
- **Two-sided verification**: refuters are prompted to *refute* ("default to refuted if uncertain"); blockers get perspective-diverse refuters (correctness + does-it-reproduce) rather than identical ones.

## 6. Verification infrastructure (visual checks are first-class)

- **Static + interactive visual bench**: worktree Vite + Playwright chromium via the proven offline-mobile-rig recipe (LD_LIBRARY_PATH + --no-zygote), against `/dev/chat` + `/?mock` fixtures; **DPR=1 mandatory** (render-harness lesson: DPR=2 headless produces false garble); mobile + desktop viewports; light + dark; captures read *as images* by reviewer agents and diffed against the design spec values (spacing, radii, type sizes measured, not eyeballed).
- **Live bench**: `~/render_harness.mjs` pattern against a side-by-side server on another port with a real Claude session — used for A1's "does it feel alive" check, toggle-thrash, and the A0 latency probe. Never against :8824.
- **Numeric gates in CI**: cargo test (fixtures, firehose attach, wheel disjointness, vocabulary table), vitest, Playwright VR suites (`data-vr-*`), `size-budget.mjs` + the new hero-path vendor gate.
- **Evidence rule everywhere**: no agent may claim "verified" without the tool output in its transcript; the orchestrator spot-checks by re-running one claimed verification per fase.
- **Real-device pass** (A6): owner-assisted checklist (iOS PWA, Android IME) — the two classes headless cannot reproduce; scheduled once, late, with a prepared 10-minute script.

## 7. Gates — the only points the owner is asked

1. **A0 gate verdict** (latency numbers + fail-branch choice if the gate fails).
2. **B0 mark mockups** (monochrome-detail-only vs eye-states v1 — visual taste call; presented as rendered options).
3. **Every PR merge** (standing repo rule — the natural checkpoint; PR bodies carry the fase's evidence: test output, screenshots, findings ledger).
4. **Anything destructive or instance-affecting** (deploys, restarting :8824, board API deprecation later).
Everything else — reviewer verdicts, fix priorities, sequencing, agent counts — is the orchestrator's call, reported after the fact in PR bodies and status updates.

## 8. Standing constraints (inherited, enforced in every prompt)

Worktrees for all work; no commits/branches/stashes in the main checkout; debug cargo only (`OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu` in-sandbox); never edit `server/migrations/*` (mark columns = new `0025`); sqlx offline data regenerated when queries change; screenshots only from mock/dev data; scratchpad for temp files; memory updated at every fase boundary (lessons, decisions, corpus locations).

## 9. Kickoff order

1. Fold in the pending v3-verifier verdict (running) → master plan final.
2. **Fase A0** (W-SPIKE, ~6 agents) + the `-o /dev/null` mini-PR.
3. **Fase B0** (W-SPIKE for mockups → W-BUILD, starts as soon as A0's probes free the bench) — produces the mark mockups for gate 2 alongside the A0 gate verdict, so the owner gets both decisions in one sitting.
4. From there: the two lanes per §4, autonomously, PR by PR.
