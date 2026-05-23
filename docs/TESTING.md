# Testing supermux — local, clawd-02, mobile

Three places to run + test the same build. All three serve the same web UI; pick the one closest to where you are.

---

## 1. Local — your Mac

The default loopback build. Fastest iteration, no network needed.

```bash
cd ~/supermux
bash scripts/build.sh
./server/target/release/supermux-server
```

The server prints `supermux listening on http://127.0.0.1:8823` and writes an auth token to `~/.supermux/auth_token`. The web UI injects that token automatically when you open the URL on the same machine.

Open in your browser: **http://127.0.0.1:8823**

Stop with `Ctrl-C`. Data lives at `~/.supermux/` (sqlite at `data.db`, logs at `logs/`).

---

## 2. Remote — clawd-02 over Tailscale

The Rust binary deployed on the Linux server, exposed inside your tailnet (HTTPS, certificate signed by Tailscale).

Open in your browser: **https://supermux.taild681cb.ts.net**

- Same UI as local. Auth token is injected from the server's `/root/.supermux/auth_token`; you don't type anything.
- Clean URL — port `443` via `tailscale serve`, hostname `supermux` after `sudo tailscale set --hostname=supermux`. Standard Tailscale pattern, no DNS to manage.
- Server runs under `systemctl status supermux.service` on the box. Restart: `ssh supermux systemctl restart supermux`.
- Redeploy when main moves: `cd ~/supermux && bash scripts/deploy.sh` (sources `.env` for host + ports).
- The legacy `amux v2` python service still runs on `http://100.95.73.18:8823` (direct tailnet IP, plain HTTP — no Tailscale TLS proxy anymore). Anything on `https://supermux.*` is supermux.

---

## 3. Mobile — your phone via Tailscale

The full PWA on your phone, served from clawd-02 through the tailnet.

**One-time setup:**
1. Install the [Tailscale app](https://tailscale.com/download) on your phone (iOS or Android).
2. Sign in with the same account that owns the `clawd-02` machine.
3. Flip the VPN switch on. The phone now sees the tailnet.

**Use it:**
- Open **https://supermux.taild681cb.ts.net** in mobile Safari (or Chrome).
- Add to home screen for an app-like launch (it's a PWA — full-screen, no browser chrome).

**Mobile-specific features to try:**
- **Bottom drag-detent sheet** — tap a session and it slides up from the bottom. Drag the handle to expand → fullscreen → collapse → dismiss. Native iOS-feel via Vaul.
- **Keyboard accessory bar** — when the on-screen keyboard appears in focus mode, an icon bar above it has Esc / Tab / Ctrl-C / Ctrl-U / arrows. One tap, no chording.
- **Joystick on touch** — long-press inside the focus terminal to bring up a virtual joystick for arrow / hjkl navigation without the keyboard popping up.
- **No hover, no problem** — type-on-hover is desktop-only by design. On touch, the action is "tap → sheet". The stopped-session card shows Start / Archive directly in its row, no peek needed.

---

## What's new since last test (today's drops)

Nine UI/UX wins to look for on any of the three surfaces:

- **Booting status** — new sessions show a "Booting" pill until the first byte streams in. No more silent black tile.
- **Real shell colors** — the tile terminal renders the actual ANSI palette (not the previous muted-white).
- **Status dot motion** — yellow **spinner** when the agent is thinking; blue **pulse** when it's waiting on you; calm dot otherwise.
- **Card sizes** — `+` / `−` in the overview header switches density tiers. T1 baseline + 20px, T2 +50% height, T3+ drop a column for wider cards.
- **Peek navigation** — arrow keys + Tab pass through to the peeked terminal (was previously stolen by overview focus).
- **Stopped-card peek actions** — hovering a stopped tile reveals Start + Archive directly, same component as the focus pane.
- **Stopped peek no longer shrinks** — the peeked stopped tile now matches the live-peek's height. Buttons centred in the same surface as a live preview.
- **Sort modes + custom groups** — sort menu at top-right: Smart, A-Z, Custom. Custom mode + drag-to-group (no more `window.prompt` for group naming — it's an inline styled input).
- **Friendly setup wizard** — `bash scripts/setup.sh` walks a new user from clone to deploy with smart defaults, advanced opt-in, and an SSH preflight that creates the service user, offers to install bun/cargo, and detects Tailscale.

---

## What to ignore for now

- The old `data.db-wal` size on clawd-02 (1.2 MB) — normal SQLite WAL, checkpoints itself.
- Backup tarball `/tmp/sm-datadir-pollution-*.tgz` on clawd-02 — old dotfile pollution from before today's HOME=/root systemd fix. Deletable any time.
- Showcase video in the README: best viewed on a wide screen. The GIF fallback is intentionally muted so GitHub renders it inline.
- Any "v2" / `amux.service` references — that's the legacy python build, untouched.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Connection refused" on `127.0.0.1:8823` locally | Server isn't running. `ps aux \| grep supermux-server`. |
| Tailnet URL hangs from phone | Tailscale VPN switch is off. Toggle it on. |
| Tailnet URL hangs from laptop on a hotel wifi | Same — Tailscale needs to be up. |
| Session shows "missing" on a re-deployed clawd-02 | tmux server was restarted; click the session → Reattach. |
| Stopped session won't restart | Check `journalctl -u supermux.service -n 50` on clawd-02. |
| Empty overview after deploy | The data dir got nuked. Sessions live in `~/.supermux/data.db` (Mac) or `/root/.supermux/data.db` (clawd-02). |
