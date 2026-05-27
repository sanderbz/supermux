# Testing supermux — local + remote

Two ways to run + test the same build. Pick whichever is closer to where
you're working.

---

## 1. Local — your machine

The default loopback build. Fastest iteration, no network needed.

```bash
cd path/to/supermux
bash scripts/build.sh
./server/target/debug/supermux-server     # or `release` if you built that way
```

The server prints `supermux listening on http://127.0.0.1:8823` and writes
an auth token to `~/.supermux/auth_token`. The web UI injects that token
automatically when you open the URL on the same machine.

Open in your browser: **http://127.0.0.1:8823**

Stop with `Ctrl-C`. Data lives at `~/.supermux/` (sqlite at `data.db`, logs
at `logs/`).

> Building from source on a low-memory VPS? Read the warning in
> [`CLAUDE.md`](../CLAUDE.md) — `cargo build --release` can OOM-thrash
> small hosts. Use debug builds, or build on a beefier machine and copy
> the binary over.

---

## 2. Remote — over Tailscale

The Rust binary deployed on a Linux server, exposed inside your tailnet
(HTTPS, certificate signed by Tailscale).

`scripts/deploy.sh` auto-detects Tailscale and runs `tailscale serve` for
you — see the **Deploy guide** section of the [README](../README.md) for
the full reference. Once it's up, open
`https://<your-host>.<your-tailnet>.ts.net` from any device on the tailnet
(laptop, phone, tablet).

The auth token is fetched server-side; you don't type anything.

---

## 3. Mobile — your phone via Tailscale

The full PWA on your phone, served from your deploy host through the
tailnet.

**One-time setup:**
1. Install the [Tailscale app](https://tailscale.com/download) (iOS or
   Android).
2. Sign in with the account that owns the deploy host.
3. Flip the VPN switch on. The phone now sees the tailnet.

**Use it:**
- Open `https://<your-host>.<your-tailnet>.ts.net` in mobile Safari (or
  Chrome).
- Add to home screen for an app-like launch (it's a PWA — full-screen, no
  browser chrome).

**Mobile-specific features to try:**
- **Bottom drag-detent sheet** — tap a session and it slides up from the
  bottom. Drag the handle to expand → fullscreen → collapse → dismiss.
- **Keyboard accessory bar** — when the on-screen keyboard appears in
  focus mode, an icon bar above it has Esc / Tab / Ctrl-C / Ctrl-U /
  arrows. One tap, no chording.
- **Joystick on touch** — long-press inside the focus terminal to bring up
  a virtual joystick for arrow / hjkl navigation without the keyboard
  popping up.
- **Tap to act** — type-on-hover is desktop-only by design. On touch, the
  action is "tap → sheet". The stopped-session card shows Start / Archive
  directly in its row.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Connection refused" on `127.0.0.1:8823` locally | Server isn't running. `ps aux \| grep supermux-server`. |
| Tailnet URL hangs from phone/laptop | Tailscale VPN switch is off. Toggle it on. |
| Session shows "missing" after a redeploy | tmux server was restarted; click the session → Reattach. |
| Stopped session won't restart | Check `journalctl -u supermux.service -n 50` on the deploy host. |
| Empty overview after deploy | The data dir was wiped. Sessions live in `~/.supermux/data.db` (or `/root/.supermux/data.db` for a root-deployed service). |
