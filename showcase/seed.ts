/**
 * Seed script: prepare 8 sessions with realistic streaming content so the
 * recording shows the WOW that the README promises (live tiles, motion,
 * waiting state). Idempotent — delete-then-create each session.
 *
 * Run BEFORE record.ts. Reads HOST + TOKEN from env, defaults match the
 * orchestrator's instructions (8833, /tmp/sm-showcase-data/auth_token).
 */

import { readFileSync } from 'node:fs'

const HOST = process.env.SUPERMUX_HOST ?? 'http://127.0.0.1:8833'
const TOKEN =
  process.env.SUPERMUX_TOKEN ??
  readFileSync('/tmp/sm-showcase-data/auth_token', 'utf8').trim()

const auth = { Authorization: `Bearer ${TOKEN}` }

async function api(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${HOST}${path}`, {
    ...init,
    headers: {
      ...auth,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text}`)
  return text ? JSON.parse(text) : {}
}

async function reset(name: string): Promise<void> {
  try {
    await api(`/api/sessions/${name}`, { method: 'DELETE' })
  } catch {
    // ignored — didn't exist
  }
}

async function create(name: string, dir: string): Promise<void> {
  await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ name, provider: 'shell', dir }),
  })
}

async function start(name: string): Promise<void> {
  await api(`/api/sessions/${name}/start`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

async function send(name: string, text: string): Promise<void> {
  await api(`/api/sessions/${name}/send`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const WORKTREE = '/Users/sandervm/supermux-worktrees/feat-showcase-video'

// Sessions in the order they should appear AT REST (visual top → bottom row).
// Names are short so they fit in the tile title; descriptions are realistic.
const SESSIONS = [
  {
    name: 'auth-rewrite',
    desc: 'refactor: replace session middleware with bearer + cookie',
    setup: async () => {
      // ACTIVE-bank trigger ("Reading N file"). A simulated agent reading files.
      // Loops forever (light cadence) so the tile stays Active throughout the recording.
      await send(
        'auth-rewrite',
        "clear; while true; do for f in server/src/auth.rs server/src/http.rs server/src/sessions/mod.rs server/src/sessions/lifecycle.rs server/src/db/sessions.rs; do echo \"  Reading 1 file: $f\"; sleep 0.6; done; done\n",
      )
    },
  },
  {
    name: 'tile-polish',
    desc: 'feat: live hover-peek with sticky type-on-hover',
    setup: async () => {
      // ACTIVE-bank trigger ("esc to interrupt"). A simulated Claude turn — spinner-like
      // glyph cycling next to "esc to interrupt" so the detector classifies Active and
      // the dot pulses yellow. Loops indefinitely.
      await send(
        'tile-polish',
        "clear; while true; do for g in '✻' '✺' '✹' '✸' '✷' '✶'; do printf '\\r  %s Beaming… (esc to interrupt)         ' \"$g\"; sleep 0.3; done; done\n",
      )
    },
  },
  {
    name: 'sse-stream',
    desc: 'btop-ish live system stats — pure motion',
    setup: async () => {
      // Real motion — small repeating loop that prints rate-limited rows so the tile is
      // always alive without flooding the WS.
      await send(
        'sse-stream',
        "clear; while true; do printf '\\033[Hcpu  %3d%%   mem %3d%%   net %4dKB/s  ts=%s\\n' $((RANDOM%30+10)) $((RANDOM%40+30)) $((RANDOM%900+100)) \"$(date +%H:%M:%S)\"; for i in 1 2 3 4 5 6 7 8; do bar=$(printf '%.0s█' $(seq 1 $((RANDOM%24+4)))); printf 'core%d %-28s %3d%%\\n' $i \"$bar\" $((RANDOM%80+5)); done; sleep 0.6; done\n",
      )
    },
  },
  {
    name: 'docs-pass',
    desc: 'docs: regenerate README hero asset',
    setup: async () => {
      // Quiet idle session — prints once then stops at a prompt.
      await send(
        'docs-pass',
        "clear; echo 'docs build complete:'; echo '  README.md       (177 lines)'; echo '  ARCHITECTURE.md (612 lines)'; echo '  CHANGELOG.md    ( 42 lines)'; echo; echo 'no further work queued.'\n",
      )
    },
  },
  {
    name: 'fix-flake',
    desc: 'fix: flaky test in sessions::status_loop',
    setup: async () => {
      // WAITING-bank trigger ("Do you want to proceed" + "❯ 1." selector). Renders as a
      // Claude approval prompt — the dot pulses blue, the "Needs input" pill shows.
      await send(
        'fix-flake',
        "clear; echo '  test sessions::status::detects_waiting ... ok'; echo '  test sessions::status::detects_idle    ... ok'; echo '  test sessions::status::detects_active  ... FAILED'; echo; echo '  failure: capture-pane returned empty after 2s'; echo; echo '  Do you want to proceed with the proposed fix?'; echo; echo '    ❯ 1. Yes, extend the grace window to 5s'; echo '      2. No, poll capture-pane on a 250ms backoff'; echo '      3. Show me the diff first'; echo\n",
      )
    },
  },
  {
    name: 'codex-board',
    desc: 'feat: codex provider in board view',
    setup: async () => {
      // ACTIVE-bank trigger ("Running..."). A simulated Codex worker with steady cadence —
      // the dot keeps pulsing yellow throughout the recording.
      await send(
        'codex-board',
        "clear; while true; do for line in 'tool: edit web/src/lib/api/board.ts' '  + provider: codex | claude | shell' 'Running...' '  ✓ typecheck' '  ✓ format' 'tool: edit web/src/routes/board.tsx' 'Running...' '  ✓ compile' '  ✓ test'; do echo \"$line\"; sleep 0.7; done; done\n",
      )
    },
  },
  {
    name: 'merge-conflict',
    desc: 'chore: resolve merge conflict in overview',
    setup: async () => {
      // A diff that scrolls; visually different from the others.
      await send(
        'merge-conflict',
        "clear; cat <<'EOF'\ndiff --git a/web/src/routes/overview.tsx b/web/src/routes/overview.tsx\nindex aab12c..ffe55a 100644\n--- a/web/src/routes/overview.tsx\n+++ b/web/src/routes/overview.tsx\n@@ -42,7 +42,7 @@\n-  const [sort, setSort] = useState<SortMode>('smart')\n+  const [sort, setSort] = useOverviewSort()\n@@ -118,9 +118,11 @@\n   return (\n-    <Grid items={sessions} />\n+    <DndContext sensors={sensors} onDragEnd={onDragEnd}>\n+      <Grid items={sessions} />\n+    </DndContext>\n   )\nEOF\necho; for i in 1 2 3 4 5; do printf '  • inspecting hunk %d/5…\\n' $i; sleep 0.5; done; echo 'conflict resolved cleanly.'\n",
      )
    },
  },
  {
    name: 'old-experiment',
    desc: 'exp: old wasm renderer (stopped)',
    setup: async () => {
      // This one we stop so it shows the stopped tile state. We'll start, send a goodbye
      // line so the tail has something, then stop it.
      await send(
        'old-experiment',
        "clear; echo 'wasm renderer experiment — last run summary'; echo; echo '  fps     : 58'; echo '  frames  : 14400'; echo '  status  : converged'; echo; echo 'parked until renderer/v3 lands.'\n",
      )
    },
  },
]

async function main() {
  console.log(`seeding against ${HOST} with ${SESSIONS.length} sessions`)

  // 1. Reset existing sessions of these names (idempotent).
  for (const s of SESSIONS) await reset(s.name)
  // 2. Kill any leftover tmux sessions with these names.
  for (const s of SESSIONS) {
    try {
      await Bun.$`tmux kill-session -t supermux-${s.name}`.quiet()
    } catch {}
  }
  // 3. Create + start each session, then send the setup script.
  for (const s of SESSIONS) {
    console.log(`  • ${s.name}`)
    await create(s.name, WORKTREE)
    await start(s.name)
    await sleep(300)
    await s.setup()
    await sleep(150)
  }

  // 4. Special-case: "old-experiment" should be stopped — let its output settle
  //    and then stop it. The tile then renders the dimmed stopped state.
  await sleep(2000)
  await api('/api/sessions/old-experiment/stop', {
    method: 'POST',
    body: JSON.stringify({}),
  })

  console.log('seed complete.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
