# Headless secrets & SSH keys for agents via 1Password

How to give a supermux deployment's agents access to **secrets and a Git SSH key
stored in 1Password**, on a **headless server**, without a desktop app and without
an interactive personal sign-in.

The same recipe works for any unprivileged service account on a Linux box that
needs unattended 1Password access (CI runners, cron jobs, edge devices).

## TL;DR

- The **1Password SSH agent and app-integration require the desktop GUI app** — not
  available on a headless server. The headless-correct mechanism is a **1Password
  Service Account**: a scoped, non-interactive token (`OP_SERVICE_ACCOUNT_TOKEN`)
  used by the `op` CLI.
- supermux runs **autonomous coding agents** as the service user. **Anything the
  service user can read, the agents can read.** So the token *must* be reachable by
  the agents — which means **all** the security comes from **scoping the service
  account**, not from hiding the token:
  - one **dedicated vault** holding only what agents may ever touch;
  - service account is **read-only** to **that one vault**;
  - a **dedicated, independently-revocable** Git key (compromise never touches your
    laptop key);
  - rely on 1Password's **audit log** + easy **rotation**.
- The Git private key is loaded into an **in-memory `ssh-agent`** and **never written
  to disk**.
- Injection point is the service user's **`~/.bash_profile`** — supermux's session
  launcher sources it (`source ~/.bash_profile` in
  `server/src/sessions/lifecycle.rs`), so every agent session inherits the token and
  the agent socket. **No supermux code or config change is required.**

Throughout, set these to your values:

```bash
SERVICE_USER=supermux                 # the supermux service user (deploy.sh default)
VAULT="My Server Secrets"             # the dedicated 1Password vault
SSH_ITEM="Git SSH key"                # the SSH-key item inside that vault
```

---

## Part A — In 1Password (web UI; cannot be scripted on the box)

1. **Create a dedicated vault** (e.g. `My Server Secrets`). Keep it minimal — its
   entire contents become reachable by the agents.
2. **Create an SSH-key item** in that vault. Let 1Password **generate** the key
   (Ed25519 is a good default). This stores the private key in 1Password; you never
   handle a key file.
3. **Register the public key with your Git host.** Copy the item's *public key*.
   - GitHub: *Settings → SSH and GPG keys → New SSH key*, type **Authentication
     Key** (an account key reaching all your repos), **or** a per-repo
     *Settings → Deploy keys* entry (tightest scope; tick *Allow write access* only
     if agents must push).
   - **Gotcha:** a GitHub *Signing* key is **not** an *Authentication* key — a
     signing-only key will fail SSH auth.
4. **Add the secrets** the agents need (test credentials, API tokens, …) as items in
   the *same* vault.
5. **Create a Service Account**: *Developer → Service Accounts → New*. Grant it
   **read-only** access to **only** this vault. Copy the
   `OP_SERVICE_ACCOUNT_TOKEN` — it's shown **once**.

---

## Part B — On the server

### 1. Install the `op` CLI (Debian/Ubuntu shown; see 1Password docs for dnf/apk)

```bash
ARCH=$(dpkg --print-architecture)
curl -sS https://downloads.1password.com/linux/keys/1password.asc \
  | sudo gpg --dearmor --output /usr/share/keyrings/1password-archive-keyring.gpg
echo "deb [arch=$ARCH signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/$ARCH stable main" \
  | sudo tee /etc/apt/sources.list.d/1password.list >/dev/null
sudo mkdir -p /etc/debsig/policies/AC2D62742012EA22/
curl -sS https://downloads.1password.com/linux/debian/debsig/1password.pol \
  | sudo tee /etc/debsig/policies/AC2D62742012EA22/1password.pol >/dev/null
sudo mkdir -p /usr/share/debsig/keyrings/AC2D62742012EA22
curl -sS https://downloads.1password.com/linux/keys/1password.asc \
  | sudo gpg --dearmor --output /usr/share/debsig/keyrings/AC2D62742012EA22/debsig.gpg
sudo apt-get update && sudo apt-get install -y 1password-cli
op --version
```

### 2. Install the service-account token (no echo, no shell history)

The value is a secret, so **type it interactively** — don't pass it as an argument.
Run from your workstation (the `-t` allocates a TTY for the hidden prompt):

```bash
ssh -t <deploy-host> \
  "sudo -u $SERVICE_USER -H bash -c 'umask 077; install -d -m700 ~/.config/op; \
   read -rsp \"Paste OP_SERVICE_ACCOUNT_TOKEN: \" T; printf %s \"\$T\" > ~/.config/op/token; \
   chmod 600 ~/.config/op/token; echo; echo stored.'"
```

Result: `~$SERVICE_USER/.config/op/token`, mode `600`, owned by the service user.
(Yes, the agents can read it — that's why the vault is scoped read-only.)

### 3. Wire the service user's `~/.bash_profile`

Run as the service user (`sudo -u $SERVICE_USER -H bash`). The marker block keeps it
**idempotent** — safe to re-run and survives redeploys (`deploy.sh` doesn't manage
dotfiles). Set `SUPERMUX_OP_SSH_REF` to your item's private-key reference;
`?ssh-format=openssh` guarantees an `ssh-add`-compatible key.

```bash
PROF=~/.bash_profile; touch "$PROF"
grep -q 'op-secrets BEGIN' "$PROF" || cat >> "$PROF" <<'EOF'

# op-secrets BEGIN (1Password service-account secret access)
# Edit this reference to point at YOUR vault/item:
SUPERMUX_OP_SSH_REF="op://My Server Secrets/Git SSH key/private key?ssh-format=openssh"

# 1) Service-account token -> op CLI auth for this shell and any agent it spawns.
[ -r ~/.config/op/token ] && export OP_SERVICE_ACCOUNT_TOKEN="$(cat ~/.config/op/token)"

# 2) Persistent ssh-agent at a fixed socket under the supermux data dir
#    (writable + stable across sessions; reused by every session).
export SSH_AUTH_SOCK="$HOME/.supermux/ssh-agent.sock"
if ! ssh-add -l >/dev/null 2>&1; then
    rm -f "$SSH_AUTH_SOCK"
    ssh-agent -a "$SSH_AUTH_SOCK" >/dev/null 2>&1 || true
fi

# 3) Load the Git key from 1Password into agent MEMORY only (never touches disk),
#    only if the agent currently holds no key. 8h TTL -> re-fetched later.
if [ -n "$OP_SERVICE_ACCOUNT_TOKEN" ] && ! ssh-add -l >/dev/null 2>&1; then
    op read "$SUPERMUX_OP_SSH_REF" 2>/dev/null | ssh-add -t 8h - >/dev/null 2>&1 || true
fi
# op-secrets END
EOF
chmod 600 "$PROF"
```

### 4. Configure SSH for your Git host

The key lives only in the agent, so SSH must be told to **offer the agent key**.

> **Critical gotcha:** `IdentitiesOnly yes` with **no** `IdentityFile` makes SSH
> refuse to offer agent keys — you get a silent `Permission denied (publickey)`
> even though the right key is loaded. The fix is to drop the **public** key on disk
> (public keys aren't secret) and point `IdentityFile` at it, so SSH selects exactly
> that one agent key.

Run as the service user (needs the token in env, e.g. inside `bash -lc` or after
exporting it):

```bash
umask 077; mkdir -p ~/.ssh; chmod 700 ~/.ssh
op read "op://$VAULT/$SSH_ITEM/public key" > ~/.ssh/git-host.pub
chmod 600 ~/.ssh/git-host.pub

grep -q 'op-secrets BEGIN' ~/.ssh/config 2>/dev/null || cat >> ~/.ssh/config <<'EOF'
# op-secrets BEGIN (1Password headless ssh-agent)
Host github.com
    IdentityAgent ~/.supermux/ssh-agent.sock
    IdentityFile  ~/.ssh/git-host.pub
    IdentitiesOnly yes
# op-secrets END
EOF
chmod 600 ~/.ssh/config
```

(Use the appropriate `Host` for GitLab/Bitbucket/etc.)

---

## Using it from an agent session

Once a session starts (which sources `~/.bash_profile`), agents can:

```bash
# Git over SSH — just works, key served from the in-memory agent:
git clone git@github.com:<owner>/<repo>.git

# Read a single secret:
op read "op://$VAULT/<item>/<field>"

# Inject secrets into a child process WITHOUT writing them to disk:
op run -- some-tool --flag           # exposes vault refs as env to the child
op inject -i config.tmpl -o config   # fills op:// refs in a template
```

---

## Verify (end to end)

```bash
# Run each as the service user via a login shell, e.g.:
#   sudo -u <service-user> -i bash -lc '<cmd>'

op whoami                 # User Type: SERVICE_ACCOUNT
op vault ls               # shows ONLY your dedicated vault
op read "op://NotInScope/x/y"   # MUST fail -> proves the scope can't be escaped
ssh -T git@github.com     # "Hi <you>!" (account key) — deploy keys stay "Permission denied"; test with a real clone instead
ssh-add -l                # the key is present in the agent...
ls -la ~/.ssh             # ...but there is NO private key file on disk (only *.pub, config, known_hosts)
```

---

## Operate: rotation, revocation, hygiene

- **Rotate the token:** regenerate it in the 1Password web UI, then rewrite
  `~/.config/op/token` (Part B step 2). No other change needed.
- **Revoke Git access:** remove the public key from the Git host, or disable the
  service account in 1Password. Because the key is **dedicated**, this never affects
  your laptop or other machines.
- **Keep the vault tight:** only ever put in it what the agents should have. Never
  grant the service account a second (broader) vault.
- **Audit:** review the service account's activity in the 1Password admin console
  periodically.
- **TTL:** the 8h `ssh-add -t` means a compromised agent loses the key within hours
  unless a new session reloads it; shorten it if you prefer.

---

## Why this fits supermux specifically

- supermux builds a **curated** per-session environment (it does *not* inherit the
  server process's env) but its launch command **sources the service user's
  `~/.zprofile`/`~/.bash_profile`/`~/.profile`** before exec'ing the agent
  (`build_launch_command` in `server/src/sessions/lifecycle.rs`). That dotfile is the
  supported, code-free injection point used above.
- The systemd sandbox permits all of this: the data dir and the user's home are in
  `ReadWritePaths` (token file + agent socket are fine), `AF_UNIX` (agent socket) and
  `AF_INET`/`AF_INET6` (`op` → 1Password cloud over HTTPS) are allowed, and `op` execs
  from read-only `/usr/local` paths without issue.
- It survives redeploys: `deploy.sh` writes `config.toml` only if absent and never
  touches `~/.bash_profile` or `~/.ssh`. The marker-guarded blocks make re-runs a
  no-op; re-verify after a deploy regardless.
