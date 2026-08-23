---
description: Author a connector into supermux's store — MCP server + manifest, then get the owner to register it live.
argument-hint: <service or API>   (e.g. "Linear" — usually you're invoked by a Create-your-own-connector handoff)
supermux-managed: true
---

# /supermux-connector — build a connector into the store

The store's "Create your own connector" flow hands you a `<supermux-connector-task>`
message: a service to connect, optional notes, a compact catalog digest, and this
guide. Your job is to author the connector THE PROPER WAY so it lands in supermux's
store live and is grantable to this company's bots. Follow this exactly.

`$SUPERMUX_URL`, `$SUPERMUX_SESSION`, `$SUPERMUX_HOOK_TOKEN` are already set in your
shell — you set nothing up.

## 1. First — don't reinvent it

Check the catalog BEFORE you build anything:

- The handoff message already carries a digest of the nearest existing connectors
  and the list of what's installed. Read it.
- Also list what's really there — you have a `list_connectors` MCP tool, and the
  store reads the same rows from `GET $SUPERMUX_URL/api/connectors` (secret-free).

If one already fits the request, **STOP** — don't build a duplicate. Tell the human
it already exists and use the ordinary connect flow (`connect(<id>)`).

## 2. The MCP server

A connector wraps an MCP server. Two honest options:

- **A hosted remote or an npx package** — if the service already ships a real
  remote MCP endpoint or a maintained `npx` server, use it. No code to write.
- **A small stdio server you author** — for a plain REST API, write a tiny stdio
  MCP server (stdlib only, secrets read from ENV, never hard-coded). Follow the
  in-repo references:
  - `server/src/connectors/imap_mail_server.py` (a self-contained stdio server)
  - `server/src/connectors/icloud.rs`, `server/src/connectors/imap_connector.rs`
    (how a connector's server + credential schema fit together)

Self-test it locally before you register anything.

## 3. The manifest

Write a `manifest.json` — the supermux manifest shape (`Manifest`):

```json
{
  "id": "linear",
  "kind": "agent_authored",
  "display_name": "Linear",
  "icon": "",
  "description": "Create and list Linear issues from your bots.",
  "tools": [
    { "name": "create_issue", "description": "Create an issue" },
    { "name": "list_issues",  "description": "List issues" }
  ],
  "credentials": [
    { "key": "LINEAR_API_KEY", "title": "API key", "type": "string",
      "sensitive": true, "required": true }
  ],
  "auth": { "kind": "api_key", "help_url": "https://linear.app/settings/api",
            "help_text": "Create a personal API key in Linear settings." },
  "emit": {
    "command": "node",
    "args": ["/path/to/linear-mcp/server.js"],
    "env": { "LINEAR_API_KEY": "${LINEAR_API_KEY}" }
  }
}
```

Rules that the server enforces (get them right or you get a 400):

- **`id`** — a slug: letters, digits, `_ . -` only, ≤ 100 chars. This is also the
  env-var/`${VAR}` namespace and the `mcp__<id>__*` tool prefix.
- **`kind`** — use `agent_authored` for one you built.
- **`credentials[]`** — each `key` is the ENV VAR NAME your `emit` block references
  as `${key}`. `sensitive: true` → the value is sealed write-only in the vault.
  Mark the non-secret account identity (e.g. an email/username) with
  `identity: true` — it becomes the "Connected as …" label. Use `file_env` for a
  credential that must be a FILE path at launch (e.g. a service-account JSON).
- **`auth.kind`** — the lane the Connect card renders: `none`, `api_key`, `form`
  (identity + secret + fields), `oauth_device` / `oauth_redirect`, or `mcp_oauth`
  (a hosted remote that runs its OWN OAuth in the bot's terminal — supermux holds
  no token). Pick the truthful one.
- **`emit`** — the `mcpServers` entry template: `{ command, args?, env? }` for a
  stdio server, or `{ url, headers? }` for a hosted one. Reference every secret as
  `${VAR}` — **NEVER inline a real key.** The manifest carries the credential
  SCHEMA and `${VAR}` placeholders only; values live in the vault and are resolved
  ONLY at launch.

## 4. Register it live (the honest path)

A connector DEFINITION is GLOBAL, so registering one is **owner/admin-only** —
`POST /api/connectors` and `POST /api/connectors/import` are `require_admin`. You
hold a hook token, not the dashboard bearer, so you **cannot** register it yourself,
and you shouldn't be able to (otherwise any bot could mint a global connector).

So: prepare the manifest, then hand it to the owner for a one-tap approval.

1. Print the finished `manifest.json` in the chat (a fenced ```json block) so the
   owner can copy it.
2. Ping the owner that it's ready to register:

   ```bash
   /supermux-notify "Connector ready" "The <service> connector manifest is ready — open the store's 'Create your own connector' sheet → 'A bot already built one? Register it' and paste the manifest to install it."
   ```

3. The owner opens **Store → Create your own connector → "A bot already built one?
   Register it"**, reviews the parsed card, and taps **Register**. The dashboard
   (which holds the bearer) makes the admin install. It appears in the store on the
   next `GET /api/connectors` — no restart.

## 5. Credentials, company access, verify

- **Secrets → vault, write-only.** After the card exists, the account's key is
  collected through the connector's Connect card, sealed via
  `POST /api/connectors/{id}/credential`, and decrypted ONLY at launch. Never put a
  value in the manifest or the chat.
- **Make it company-accessible.** The owner grants it to
  `@company:<id>` (`POST /api/connectors/{id}/grant`) — the same Register sheet
  offers a "Grant to <company>" tap. That reaches every bot in the company; the
  tools materialize on a granted bot's next launch/restart (`restartHint`).
- **Verify.** Once granted + connected, confirm the `mcp__<id>__*` tools appear on
  the next turn and do a real call.

---

This command is managed by supermux and auto-installed — don't edit it by hand;
your changes will be overwritten on the next boot.
