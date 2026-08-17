// A holder that CRASHED — the second way a pane dies, and the one the chat
// surface was blind to.
//
// `chat-ws-stopped-handover.spec.ts` covers the DELIBERATE stop, and that path
// always worked: `POST /stop` flips the row to `stopped`, the flip is
// broadcast, and the seam's `status === 'stopped'` clause takes the chat
// surface away.
//
// `kill -9` on the pty holder is not that path. The row's status flip is left
// to the pty reader, which writes `stopped` straight to the DB — after which
// `force_stopped_on_death` short-circuits on `persisted == Stopped` and its
// `status`/`sessions` broadcasts never run. So the browser is never told the
// status changed. Its other route to the same fact, the terminal socket's
// 4404, does not exist under the chat renderer: there is no terminal socket.
// The measured result was a chat surface sitting on `live` over a dead pane
// for as long as the tab stayed open, with an enabled composer that answered a
// send with "The session has it — waiting for the transcript to catch up." —
// a positive delivery claim about a pane with no process.
//
// What the server DOES broadcast is the `holder_died` badge, and that is what
// the seam now reads (`chat/seam.ts`'s `paneIsDead`).
//
// Needs server/target/debug/supermux-server — `cd server && cargo build`
// first (debug; never --release).

import { readdirSync, readFileSync, realpathSync } from "node:fs";

import { expect, test } from "@playwright/test";

import {
  chatSession,
  connectionState,
  expectTokenOnce,
  primePage,
} from "./chat-fixture";
import { startBackend, type Backend } from "./harness";

/**
 * SIGKILL the pty holder behind `session` — a crash, not a stop.
 *
 * PROVENANCE IS CHECKED BEFORE ANYTHING IS SIGNALLED. The matcher requires all
 * three of `pty-holder`, this session's name and this backend's throwaway
 * `SUPERMUX_DATA_DIR` in the process's own `/proc/<pid>/cmdline`, so a
 * developer's real supermux — or another spec's backend running in parallel —
 * can never be the thing that dies. Returns how many holders were killed, so
 * the caller can fail loudly rather than silently assert on a session that was
 * never actually killed.
 */
function killHolder(session: string, dataDir: string): number {
  const dirs = [dataDir, realpathSync(dataDir)];
  let killed = 0;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let cmd = "";
    try {
      cmd = readFileSync(`/proc/${entry}/cmdline`, "utf8")
        .split("\0")
        .join(" ");
    } catch {
      continue; // the process exited between readdir and read
    }
    if (!cmd.includes("pty-holder")) continue;
    if (!cmd.includes(`--session ${session} `)) continue;
    if (!dirs.some((d) => cmd.includes(d))) continue;
    try {
      process.kill(Number(entry), "SIGKILL");
      killed++;
    } catch {
      // already gone
    }
  }
  return killed;
}

test.describe("chat WS — a crashed holder hands the surface over", () => {
  let backend: Backend;
  test.beforeEach(async () => {
    backend = await startBackend();
  });
  test.afterEach(async () => {
    await backend?.dispose();
  });

  test("a CRASHED holder hands over too — the composer never outlives its pane", async ({
    page,
  }) => {
    test.setTimeout(240_000);

    // Auto-heal off: a restart seconds later would hide the very window under
    // test. This is the operator's documented off-switch, not a test hook.
    const pref = await fetch(
      `${backend.backendUrl}/api/prefs/recovery.auto_heal`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${backend.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: "off" }),
      },
    );
    expect(pref.ok, "recovery.auto_heal must be settable").toBeTruthy();

    const fx = await chatSession(backend, "a6t3-crash");
    fx.write("a6t3-crash-a", ["A6T3CRASH-0001"]);
    await fx.hook("a6t3-crash-a");

    await primePage(page, backend);
    await page.goto(`${backend.baseUrl}/focus/${fx.name}`);

    await expect(page.getByTestId("chat-panel")).toBeVisible();
    await expectTokenOnce(page, "A6T3CRASH-0001");
    await expect(page.getByTestId("chat-composer-field")).toBeVisible();
    expect(await connectionState(page)).toBe("live");

    // ── kill the holder ─────────────────────────────────────────────────────
    expect(
      killHolder(fx.name, backend.dataDir),
      "the spec must actually kill a holder, or it asserts on nothing",
    ).toBeGreaterThan(0);

    // The same handover the deliberate stop produces, from the same copy
    // (`brand/copy.ts`). Before the fix this never arrived: the surface stayed
    // on `live`, indefinitely.
    await expect(page.getByText("This session is stopped")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId("chat-panel")).toHaveCount(0);
    await expect(
      page.getByTestId("chat-composer-field"),
      "a composer over a pane with no process is a delivery promise nobody can keep",
    ).toHaveCount(0);
  });
});
