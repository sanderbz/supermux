# Companies (Bot Mode) — Design

**Status:** design spec (drives the implementation plan)
**Branch:** `feat/companies` (worktree off `origin/main`)
**Date:** 2026-08-22
**Anchors:** every `file:line` below was verified against the repo at the head of `feat/companies`. The prior codebase analysis lives at `~/companies-analysis/*.md`; where its inferences conflict with the owner-locked decisions (notably: it proposed a `TEXT company_id NOT NULL DEFAULT 'default'` with a seeded default tenant and per-company slugs), **this spec overrides it** — `company_id` is a plain nullable `INTEGER`, slugs stay globally unique, and `NULL` means the main bots.

---

## 1. Summary & goals

supermux today is a single-tenant operator dashboard: one shared bearer token, one flat global namespace of sessions keyed by slug, a files browser that can reach the whole disk, and any-to-any delegation. **Companies (Bot Mode)** turns that flat dashboard into a small *operational OS*:

- A **Company** is a first-class named workspace that owns a folder on disk and a set of agents. Most day-to-day work happens *inside* a company: its agents see only its files, delegate only to each other, and (in P2) share a set of connectors configured with that company's own credentials.
- A tier of **main bots** — the personal assistant (PA) and tech-admin agents — sit *above* all companies. They are omniscient (see every file, every session), they can route work *into* any company, and they are the only agents that can cross company boundaries. A main bot is defined by exactly one fact: **`company_id IS NULL`**. The company-less bots that exist today already *are* these main bots, so no data migration is needed and no separate role system is introduced for them in v1.
- The owner drives all of this from one dashboard through a **company switcher** that narrows the whole app to a company, plus a **cross-company routing UI** for the PA and a **company-grouped Files view** that makes the PA's omniscience usable rather than merely permitted.
- P3 opens each company to **external human colleagues** over a per-company reverse tunnel with Google login, so a client's own staff can chat with that company's agents — and only that company's agents — with every message attributed to the human who typed it.

**Goals, in priority order.** (1) A real isolation boundary — filesystem, agent-to-agent, and connector credentials — enforced server-side, not merely in the UI. (2) KISS: no docker, no namespaces, no per-process users, no per-company server instance, no re-keying of the ~20 slug-keyed in-memory maps. (3) Incremental delivery: four phases, each independently shippable and visually verifiable by the owner. (4) Zero regression for the existing fleet: today's company-less bots keep behaving exactly as they do now.

**Non-goals (v1).** Moving an agent between companies; per-company server processes; multi-tenant slug namespaces; RLS. See §12.

---

## 2. Terminology & the core model

- **Company** — a row in the new `companies` table. Owns a stable `slug`, a mutable `display_name`, a `root_dir` folder on disk under which all its agents live, an `archived` flag, and timestamps. Companies are a *filter attribute* on sessions, never part of any key.
- **Main bot / PA / tech-admin** — a session with `company_id IS NULL`. Omniscient (jail off), may route into any company, is never hidden by the switcher's company filter. There is exactly one privileged tier in v1; "PA" vs "tech-admin" is a naming/`display_name` distinction, not a schema distinction.
- **Agent** — a session (`sessions.name` slug). A *company agent* is a session with a non-null `company_id`. Its `dir` is forced under its company's `root_dir/<agent>/`; its Files view and delegation are confined to its company.
- **Membership** — the `sessions.company_id` value. **Fixed at create for v1** (decision #11). Reassignment (folder move + connector re-materialization + delegation-graph relabel) is explicitly deferred.
- **Human user** — a row in `human_users` (P0 schema, P3 behavior): an email + display_name + `company_id` (NULL = owner/admin-all) + role (`owner|admin|member`). Seeded with one owner row; essentially unused until P3.
- **Team** — a Claude agent-team (`sessions.team_name`, migration 0017). Orthogonal to companies (decision #12): a team card on the overview scopes by its *lead* session's company.

**The central KISS lever (decision #3):** session slugs stay **globally unique**. `sessions.name` is the PK, the tmux/native session name, `$SUPERMUX_SESSION`, the route path segment, the per-pane hook-token key, and the `data_dir/native/<name>` spool path (`server/src/sessions/native/spool.rs:107-116`). It also keys the ~20 `DashMap<String,…>` maps in `AppState` (`server/src/state.rs`). Keeping the slug global — company is only an attribute hanging off the row — means **none of that touches company at all**. Per-company *display names* may repeat freely; the slug never does.

---

## 3. Data model — migration 0030 + the type thread

### 3.1 Migration numbering & rules

The migrations directory holds `0001-0005, 0007-0024, 0026-0029` (verified: `0006` and `0025` are permanent gaps; `0021_schedule_bypass_permissions.sql` … `0029_session_seen.sql` are the tail). **Next free number is `0030`.** Migrations are checksummed and immutable once shipped — a new file only, never an edit to any `server/migrations/*` (MEMORY: sqlx-migrations-are-checksummed). The applied-migration-count assertion at `server/src/db/mod.rs:116` currently asserts **27** (`0001-0005, 0007-0024, 0026-0029`) and **must be bumped to 28** in the same PR that lands 0030 — the test message string at `db/mod.rs:117-118` must be updated to match.

**FK-on constraint (hard rule).** Under `PRAGMA foreign_keys=ON`, SQLite refuses `ALTER TABLE … ADD COLUMN … REFERENCES … DEFAULT '<non-null>'`. This is exactly how `host_id` was added in 0018: a plain nullable `INTEGER` with **no** inline `REFERENCES`. `sessions.company_id` follows that precedent verbatim — a plain nullable `INTEGER`, integrity enforced in the app layer (and a delete-time trigger, §9), never an inline FK.

### 3.2 The 0030 SQL

```sql
-- 0030_companies.sql
-- Companies (Bot Mode): a first-class company registry, a nullable company_id
-- filter attribute on sessions (NULL = the main/PA/tech-admin bots), a seeded
-- human_users owner row (dormant until P3), and the P2 company_connectors store.
--
-- IMMUTABLE ONCE SHIPPED. sessions.company_id is a PLAIN NULLABLE INTEGER with
-- NO inline REFERENCES: SQLite under foreign_keys=ON refuses ADD COLUMN ...
-- REFERENCES ... with a default, exactly as host_id was added in 0018. Integrity
-- is enforced in the application layer and by trg_company_delete_* triggers.

CREATE TABLE companies (
    id           INTEGER PRIMARY KEY,               -- rowid; mirrors hosts(id)
    slug         TEXT    NOT NULL UNIQUE,            -- stable, [A-Za-z0-9_.-]+
    display_name TEXT    NOT NULL,                   -- mutable, may repeat
    root_dir     TEXT    NOT NULL,                   -- absolute folder root
    archived     INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

-- Plain nullable INTEGER, NO REFERENCES (FK-on + default rule). NULL = main bot.
ALTER TABLE sessions ADD COLUMN company_id INTEGER;
CREATE INDEX idx_sessions_company ON sessions(company_id);

CREATE TABLE human_users (
    id           INTEGER PRIMARY KEY,
    email        TEXT    NOT NULL UNIQUE,
    display_name TEXT    NOT NULL,
    company_id   INTEGER,                            -- NULL = owner / admin-all
    role         TEXT    NOT NULL DEFAULT 'member'
                   CHECK (role IN ('owner','admin','member')),
    created_at   INTEGER NOT NULL
);

-- Seed exactly one owner row. Email is a runtime-resolved sentinel, NOT the
-- owner's real address hardcoded into a checksummed, world-readable migration
-- (keeps PII out of git; the real email is bound from config at startup — §7).
INSERT INTO human_users (email, display_name, company_id, role, created_at)
VALUES ('owner@localhost', 'Owner', NULL, 'owner',
        CAST(strftime('%s','now') AS INTEGER));

-- P2 store. config_json holds encrypt-at-rest secrets (§6). target_session NULL
-- => shared to the whole company; else a single bot slug (name-matched wholesale
-- replace). Cascade on company delete via trigger (FK-on forbids the inline FK
-- with the pattern above, and we keep the table consistent with sessions).
CREATE TABLE company_connectors (
    id             INTEGER PRIMARY KEY,
    company_id     INTEGER NOT NULL,
    name           TEXT    NOT NULL,                 -- mcpServers key
    config_json    TEXT    NOT NULL,                 -- vault-sealed blob (§6)
    target_session TEXT,                             -- NULL = whole company
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_company_connectors_company ON company_connectors(company_id);

-- Cascade: when a company row is deleted, drop its connectors and NULL its
-- sessions' company_id (turning them into main bots is safer than orphaning —
-- but hard-delete is admin-only and archival is the default; see §9).
CREATE TRIGGER trg_company_delete_connectors
AFTER DELETE ON companies BEGIN
    DELETE FROM company_connectors WHERE company_id = OLD.id;
END;
CREATE TRIGGER trg_company_delete_sessions
AFTER DELETE ON companies BEGIN
    UPDATE sessions SET company_id = NULL WHERE company_id = OLD.id;
END;
```

No child table gets `company_id`: scope is owned at the `sessions` root and inherited by every FK child (`session_runtime`, `tracked_files`, `steering_queue`, `share_tokens`, `session_status`, `delegations` on both endpoints). `boards`/`schedules`/`hosts`/`audit_log` stay global in P0–P2 and are addressed where they matter (audit attribution in P3, §7; board/team scoping via the lead session, §5).

### 3.3 Rust types the `company_id` must thread through

`host_id` is a *partial* template — it reaches the create path but is **not** re-emitted on the read path (verified: `SessionView` at `server/src/sessions/mod.rs:194` carries no `host_id`; it appears only in `CreateInput` at `:943` and `NewSession` at `:1063`). `company_id` must be threaded through **both** paths explicitly, or the switcher has nothing to read (decision #5):

1. **`Session`** (`server/src/db/sessions.rs:15`) — add `pub company_id: Option<i64>` next to `host_id` (`:56`). `FromRow` picks up the new column.
2. **`NewSession`** (`server/src/db/sessions.rs:363`) — add the field; extend the INSERT column list + binds in `create` (`db/sessions.rs:391-416`) — currently a 15-column INSERT ending `host_id, runtime, created_at`; add `company_id` and its `.bind(s.company_id)`.
3. **`duplicate`** (`db/sessions.rs:458` INSERT) — a duplicate **inherits** the source's `company_id` (a clone stays in the same company; the folder is re-derived under the same root).
4. **`CreateInput`** (`server/src/sessions/mod.rs`, near `host_id` at `:943`) — add `#[serde(default)] pub company_id: Option<i64>`; carry it into `NewSession` in `create` (near `:1063`), **after** the dir-forcing logic of §4 validates/derives the company folder.
5. **`SessionView`** (`server/src/sessions/mod.rs:194`) — add `pub company_id: Option<i64>`; set it in `view()` (`:431`) from the `Session` row. This is the read-path addition `host_id` never got.
6. **`ConfigInput`** — do **not** add `company_id` here in v1: membership is fixed at create (decision #11), so `PATCH …/config` must not reassign it. (A future move-agent feature adds it plus a `db::sessions::set_company` setter modeled on `set_team_name` at `db/sessions.rs:542+`.)
7. **Web types** — add `company_id?: number | null` to `SessionSummary` (`web/src/lib/api/sessions.ts:36`), `ApiSession` (`:126`, beside `host_id?` at `:299`), and `NewSession` (`:500`, beside `host_id?` at `:511`).

A new `companies` DB module (`server/src/db/companies.rs`) provides `list`, `get`, `create`, `rename`, `archive`, `delete`, mirroring the shape of `db/hosts.rs`. A new `server/src/companies/mod.rs` HTTP router (`GET/POST /api/companies`, `PATCH/DELETE /api/companies/{id}`) is merged into `protected_router` beside `agents::router_for` at `server/src/http.rs:155`.

---

## 4. Isolation model

Three independent mechanisms, each cheap because the seam already exists.

### 4.1 Filesystem jail (decisions #4a, #8)

The jail is *already built and tested* but never switched on: `resolve_safe(input, jail)` at `server/src/files/path_safe.rs:103` confines the result to `jail` when `Some` (`:134-137` — canonicalize the jail, require `abs.starts_with(jail_canon)`), and applies only a home-anchored blocklist when `None`. Every Files handler currently passes `None` — verified at `server/src/files/mod.rs:240, 278, 356, 405, 522, 562` (the six `safe_path(&transport, …, None)` calls).

**The flip.** Resolve the caller's *active company* to its `root_dir` and pass `Some(root_dir)` as the jail for company-scoped Files requests; pass `None` for main-bot / owner-omniscient requests. Concretely: the Files handlers gain a resolved `jail: Option<PathBuf>` derived from the request's company scope (the switcher's active company for the owner UI; the session's own company for a company-scoped human in P3), replacing the six literal `None`s. Main/PA bots and the unscoped owner keep `jail = None` ⇒ they see all files — the requested omniscience, for free.

**Create-time dir forcing (decision #8).** Today `dir` is taken verbatim, defaulting to `$HOME` with no validation (`server/src/sessions/mod.rs:1020-1027`). For a session created **with** a `company_id`, the create path must instead derive `dir = <company.root_dir>/<name>/` and **reject** any caller-supplied `dir` that does not canonicalize under `company.root_dir` (a 400). Company sessions therefore cannot be pointed outside their root even by a raw curl. Main-bot sessions (`company_id` NULL) keep today's free-form `dir` behavior unchanged. The company folder is `mkdir -p`'d at create.

Jail caveats carried into the plan: `resolve_safe` rejects `..` escapes but a symlink *inside* the company dir pointing out is not chased, and the remote-transport path treats jail as a local-FS concept (`files/mod.rs:206`). For v1, company sessions are local-only for the jail guarantee; a symlink-hardening note is filed as a risk (§12).

### 4.2 The delegation gate (decision #7)

The authoritative seam is inside `delegate()` (`server/src/agents/delegate.rs:164`), **between the existence checks and delivery** — after `to` is confirmed at `:201-203` and before the delivery branch at `:214`. At `:210-213` the handler already loads the `to` row via `db::sessions::get`; add a parallel `get` for `from`, so both `company_id`s are in hand with no new query shape.

The rule (asymmetric, decision #7):

```
allow if   caller.company_id IS NULL              // main/PA may route into ANY company
        OR to.company_id == from.company_id       // same-company delegation
deny otherwise                                     // a company bot -> another company
```

A denied cross-company attempt returns a **silent 404** (`AppError::NotFound(format!("session '{to}'"))`) — identical to a non-existent target, so a company bot cannot probe for the existence of another company's agents (decision #7). The gate fires *before* any keystroke, edge, or audit row is written, matching the existing "refuse before delivery" discipline. It is enforced on the server, so it holds against a raw curl regardless of the UI.

**Graph read path.** `GET /api/agents/delegations` (`delegate.rs:261`, via `delegations_out`/`delegations_in` at `server/src/db/audit.rs:189-211`) is filtered the same way: a company-scoped caller sees only edges whose endpoints are in its company; a main-bot/owner caller sees all.

**@-picker (defense in depth, not the boundary).** The composer's mention list comes from the full unscoped roster (`mentionIndex(sessions)` / `displayNames(sessions)`, `web/src/components/chat/grouping.ts:552-586`; `chat-panel.tsx:161-165`). Scope it to the active company so cross-company slugs never appear as chips — but this is cosmetic; the real gate is server-side because the endpoint is curl-reachable.

### 4.3 Query-layer scoping

There is no single query gateway (each `db/*.rs` fn emits raw SQL; runtime `query_as`, not macros — `db/sessions.rs` header). Scoping is therefore threaded per query, exactly as `board_id` already is in `db/board.rs:190` (`WHERE board_id = ? AND …`). For companies:

- Add `db::sessions::list_for_scope(company: Option<i64>)`: `None` ⇒ today's unfiltered `SELECT * FROM sessions WHERE archived = 0 ORDER BY …` (`db/sessions.rs:114`); `Some(id)` ⇒ the same with `AND company_id = ?`. `sessions::list` (`mod.rs:795`) and the archived variant read the active-company scope.
- The owner dashboard (main-bot, unscoped) keeps calling the `None` path — it sees everything and filters *client-side* by the switcher (§5). A P3 restricted human is server-scoped to `Some(their company)` and can never receive out-of-company rows even by tampering with the client.
- SSE `sessions` deltas (`mod.rs:1099`, one global `state.sse_tx`) stay global for the single-owner dashboard in P0–P2; they become **per-company channels** in P3 (§7), which is the first moment >1 human connects and a global broadcast would leak.

**Why slugs stay global (restated, load-bearing).** Because company is only a `WHERE` predicate and a client-side filter, the in-memory `AppState` maps, the native spool path, the hook-token store, and the tmux session names never need a company dimension. Making slugs per-company would force a `(company_id, name)` composite key through every child FK and every `DashMap<String,…>` — the single largest source of isolation bugs. We do not do that.

---

## 5. Overview & switcher UX (decision #6)

**Whole-app scope.** The active company is a shell-level, **server-persisted** preference (mirroring the layout blob fanned through `/api/prefs`, `use-sessions.ts:302-329`, and the `hideStopped` precedent in `ui-store.ts:131`), so it follows the owner across Overview, Focus, Files, the palette, and the New-session sheet, and survives reload and cross-device. State: `activeCompany: number | null` (+ setter) in the UI store, with `null` = "All companies" (the owner's default first-run state).

**The switcher component.** A `<CompanySwitcher>` in the overview header row (`overview.tsx:641`, leftmost — a scope reads as "above" the filters), plus a compact echo in the shell chrome (`layout.tsx`) so the scope is always visible. Its options are the `companies` list (`GET /api/companies`) plus an "All companies" entry.

**What switching narrows** (client-side for the owner, who holds the full roster):

- **Overview list** — extend the single `filtered` choke-point at `overview.tsx:235-244` with `activeCompany === null || s.company_id === activeCompany`. Every render mode (custom/smart/alpha/preset) flows through `filtered`, so this one predicate scopes them all. Renderer-pin pruning (`overview.tsx:133-137`) must keep reading the *full* `allSessions`, never the scoped view, or it would drop out-of-scope pins.
- **Team cards** — extend `filteredTeams` (`overview.tsx:457-466`) by the *lead* session's `company_id` (decision #12); a switcher that scoped sessions but not teams would leak team cards across companies.
- **New-agent default** — the New-session sheet defaults `company_id` to `activeCompany` (a company chosen ⇒ new agents land in it and get their forced `root_dir/<name>` folder; "All companies" ⇒ a main bot, `company_id` NULL).
- **Files** — the Files browser roots at the active company's `root_dir` (jail on, §4.1); "All companies" ⇒ the omniscient all-files view (§8).
- **Palette** — detail/scoped palette views may narrow to the active company; global actions stay global.

**The global-search exception (decision #6).** Search stays global even with a company active — but results **rank the active company first**. `matches()` (`overview.tsx:98-107`) is unchanged; the ordering applied on top of a non-empty query places in-company hits ahead of out-of-company hits, with a subtle out-of-company affordance. This is the owner's escape hatch to find anything without leaving the company lens. **A P3 restricted human is the exception to the exception:** their search is hard-limited server-side to their company (§7) — nothing out-of-company is ever returned to them.

Scoped-empty state: the `noMatch` branch (`overview.tsx:513-521`) gains a "this company has no agents yet — create one / show all companies" message paralleling the hide-stopped CTA.

---

## 6. Connector store (P2) (decision #9)

**Model.** The `company_connectors` table (§3.2): `(company_id, name, config_json, target_session)`. A row with `target_session = NULL` is shared to **every** bot in the company; a row with `target_session = '<slug>'` is a per-bot override. The override is a **name-matched wholesale replace** (decision #9): for a given `name`, a bot with a matching `target_session` row uses *that* config in full, ignoring the company-wide row of the same name — not a field-level merge. This makes "Company X's Slack" and "Company Y's Slack" two independent rows with independent credentials, and lets one bot in a company run a differently-configured Slack than its siblings.

**Materialization at session start.** Company connectors are not a Claude scope, so they are *projected* into one when a bot starts. The target is the `local` scope: `~/.claude.json → projects[<resolved cwd>].mcpServers`. The projection reuses the existing atomic subtree writer `write_json_atomic` (`server/src/claude_tools/atomic.rs:81`), which reads → merges only the `mcpServers` subtree → temp file → fsync → rename(2), so a crash never truncates the config. A new lifecycle hook in `start_locked` (`server/src/sessions/lifecycle.rs:960+`, near the hook-install block at `:1075`) resolves the session's `company_id`, gathers the effective connector set (company-wide rows overlaid by any `target_session = this-slug` rows, name-matched replace), decrypts each `config_json` through the vault, and materializes them into the session's cwd `local` scope before the agent launches. Because materialization is at start, a connector edit takes effect on the next start of each affected bot (documented; a "restart to apply" affordance in the UI).

**The encrypt-at-rest vault (P2, new).** No vault exists today — secrets are plaintext in `~/.claude.json` (`claude_tools/atomic.rs`), masked only on read (`mask_mcp_secrets`, `atomic.rs:127-142`). `company_connectors.config_json` must not be plaintext, because P3 tunneled humans of Company B must never read Company A's secrets from the DB. Model the key handling on the existing `auth_token`-file flow (`server/src/config.rs:309-367`): a `<data_dir>/companies_vault_key` file, mode `0600`, generated on first use (32 random bytes), overridable by `SUPERMUX_COMPANIES_VAULT_KEY` env. `config_json` is sealed with an AEAD (XChaCha20-Poly1305 / libsodium-style secretbox) under that key, stored as `{nonce, ciphertext}` base64. Decryption happens only server-side at materialization; the connector-manager sheet keeps the existing masking (`"••• set"`) so values never round-trip to any client. Key rotation re-seals every row under a new key in one pass.

**UI.** The Agent Tools sheet (`web/src/components/claude-tools/claude-tools-sheet.tsx`) gains a company provenance/scope alongside Claude's `user|local|project|cloud`, an "inherited from company" vs "overridden for this bot" indicator, and a company-connectors editor reachable when a company is active. Adding/editing a company connector writes the sealed row and (optionally) offers "restart affected bots to apply."

---

## 7. External humans (P3) (decision #13)

This is the largest slice and the only one that opens the instance beyond the owner. It is strictly additive to the bearer world — the bearer stays for pane/hook/internal auth; a new human-auth class sits beside it.

- **Reverse tunnel (per company).** A per-company Cloudflare tunnel terminates at a company hostname and forwards to the loopback service (architecturally the shape of today's `tailscale serve`). The company hostname is added to the WS Origin allowlist via the existing `config.extra_origins` hook (`config.rs:72-79`, consumed at `ws/mod.rs:1414`); the CSP `connect-src 'self' ws: wss:` (`http.rs:104-113`) already permits same-origin WS through the tunnel. Companies gain a `tunnel_hostname` column (a follow-on migration, not 0030) that maps an inbound Host → company.
- **Google login → human identity.** A new OIDC handler (Google-only is acceptable; betterauth optional) mints a **session cookie** representing an authenticated human resolved against `human_users` (email UNIQUE). A human-auth middleware runs **beside** the bearer layer at `http.rs:176`: bearer-or-cookie, whichever authenticates. Cookies are `Secure; HttpOnly; SameSite=Lax` with CSRF tokens on state-changing routes (the header-only bearer sidesteps CSRF today; cookies reintroduce it). The Google client secret follows the env-not-disk pattern of `github_token` (`config.rs:255-279`). The seeded owner row's real email is bound at startup from config (never hardcoded in the migration, §3.2).
- **Company scoping for a human.** An authenticated human's `human_users.company_id` hard-limits every request server-side: session list, Files (jail = their company root, always on), delegation, palette, **and search** (the P3 exception to the global-search rule, §5). A `company_id = NULL` human (owner/admin) is unscoped, like the bearer today.
- **Per-company SSE channels.** The single global `state.sse_tx` (`sessions/mod.rs:1099`) becomes per-company at the moment >1 human connects — otherwise Company B's browser receives Company A's create/status deltas in real time. Deltas are published to the subscriber's company channel; the owner/main channel receives all.
- **Per-message human author provenance.** A human composer send must show *which colleague* typed it. It is threaded through the existing forgery-safe seam: `send_harness_text` (`lifecycle.rs:1541+`, the privileged writer that `send_text` is barred from) wraps the text with an identity-bearing tag mirroring `<supermux-delegation from="…">` (`delegate.rs:110-119`), where the author is the **server-established** authenticated human (never trusted from the request body — the forgery guard at `lifecycle.rs:1507-1535` insists identity be server-side). The reader (`recall::classify_prompt_body`, `recall.rs:1275-1296`) and the web renderer (`transcript-item.tsx:459-501`; `wire-entries.ts:268`) learn to render "●alice@acme" as an arrival divider, exactly as delegation senders render today.
- **Audit attribution.** `audit_log.actor` is a single anonymous `"user"` today (`db/audit.rs`). Add `author_user_id` and `company_id` columns (a follow-on migration) so each destructive action is attributable to a named human and a company.
- **iCal gating.** `/api/calendar.ics` is unauthenticated by design (`SECURITY.md:23-27`) and behind a public tunnel would leak board titles across companies. It is gated in P3: either moved behind the human-auth layer or issued as a per-company signed feed token, so it cannot cross companies on a public hostname.
- **Permission model (owner/admin/member).** `owner` = the bearer-holder, unscoped, all powers. `admin` (company-scoped) = create/archive agents in their company, edit that company's connectors, chat. `member` (company-scoped) = chat with their company's agents and read files under the company root; **cannot** create agents or edit connectors. The role gates the human-auth middleware's route authorization; agent-create and connector-edit routes require `admin`+.

**Connector credential isolation across humans (gap answered).** The connector-manager sheet must resolve rows through the human's company scope: a Company-B human's sheet queries only `company_connectors WHERE company_id = B`, values masked, so Company-A secrets are never even fetched for that session. The vault (§6) guarantees the at-rest half; the scoped query guarantees the in-transit half.

---

## 8. Cross-company routing UX for the PA & the usable all-files view

**PA routing picker (gap answered).** Today the @-picker is one unscoped list (`grouping.ts:552-586`). For the main/PA bot the routing affordance becomes a two-step **target picker**: pick a **company** → pick an **agent within it** → forward. It is backed by the existing `POST /api/agents/delegate` (the gate at §4.2 *allows* a NULL-company caller into any company), so no new endpoint is needed — only a scoped picker UI that lists companies then their agents. The forward writes a normal delegation edge; the recipient sees "Message from ●pa" as usual.

**Usable all-files view (gap answered).** Omniscience is only useful if it is navigable. The main-bot/owner Files view (jail `None`) is presented **company-grouped**: a top-level list of companies (each rooted at its `root_dir`), plus a "main / everything" root for the unjailed remainder. Selecting a company roots the browser at that company's folder (a per-company root picker); the owner is not forced to hand-type absolute paths. This is the readable surface over the "sees all files" permission — the permission is granted by `jail = None`, the *usability* is this grouped picker.

---

## 9. Deletion, archival & lifecycle semantics (gap answered)

**Membership is fixed at create (decision #11).** A session's `company_id` is set once and not editable via `PATCH …/config` in v1. Moving an agent (folder move + connector re-materialization + delegation-graph relabel) is deferred (§12).

**Company archival (default, soft).** `PATCH /api/companies/{id}` sets `companies.archived = 1`. An archived company disappears from the switcher and from new-agent targeting, its agents stop being creatable, and its `root_dir` is left untouched on disk. Its existing sessions keep running (archival is a management state, not a kill switch); the owner can unarchive. This mirrors session archive (`archived=1`, row kept, `db/sessions.rs:122-127`).

**Company hard-delete (admin, explicit).** `DELETE /api/companies/{id}` is owner-only and guarded (only permitted when the company has no *active* sessions, paralleling the archived-only `purge` guard at `db/sessions.rs:238-262`). On delete: `trg_company_delete_connectors` drops its `company_connectors` rows (their sealed secrets go with them), and `trg_company_delete_sessions` sets `company_id = NULL` on any lingering sessions — turning them into main bots rather than orphaning FK-less rows. **The `root_dir` folder on disk is NOT removed by the delete** (data safety: deleting a DB row must never `rm -rf` a client's working files); the response returns the retained path so the owner can remove it deliberately. This is documented as intentional.

**Slug/name collision & backfill honesty (gap answered).** Company `slug` is UNIQUE within `companies` and lives in its **own namespace** — it is never a session key, so it cannot collide with `sessions.name` at the PK level. For human legibility (folder paths, URLs), the company-create handler additionally soft-rejects a company slug equal to an existing session slug. Backfill honesty: every pre-existing session has `company_id = NULL` and therefore *is* a main bot — the correct, no-migration outcome. Pre-existing agents **cannot** be retroactively separated into companies (their `dir` was chosen freely and is not under any `root_dir`); the only honest mapping is NULL/main. Retroactive per-company separation of legacy data is explicitly out of scope, and the owner is told so.

---

## 10. Phasing P0 → P3

Each phase is a **shippable, independently verifiable slice**, deployed alone and owner-verified before the next begins (deploy-a-branch-from-a-worktree: write the deploy request with `source_dir=` this worktree; MEMORY: deploy-branch-from-worktree). No P3 descope (decision #1).

**P0 — invisible data-model foundation.** Migration 0030 (companies, `sessions.company_id`, seeded `human_users` owner, `company_connectors` table + triggers). Thread `company_id` through the five Rust types + web types (§3.3). Bump the `db/mod.rs:116` assertion to 28. Companies CRUD endpoints + `db/companies.rs`. **Done when:** `cargo check` (debug) + `bun run build:perf` + `tsc -b` are green, the new migration count test passes, and a curl round-trip creates a company and a company-scoped session whose `dir` is forced under `root_dir`. **Owner sees:** nothing visually changes in the dashboard (that is the point); the owner verifies via a create/list curl that a company exists and a session carries its `company_id`.

**P1 — isolation + switcher (the first visible slice).** Flip the Files jail (`None → company root`, §4.1); enforce create-time dir forcing; add the delegation gate + silent-404 + graph filtering (§4.2); ship the `<CompanySwitcher>`, `activeCompany` persisted state, whole-app scoping, new-agent default, team-card scoping, and global-search-company-first (§5). **Done when:** the switcher narrows the overview + teams; a company bot's Files view cannot escape its root; a cross-company delegate curl returns 404; a same-company and a main-bot delegate succeed; gates green. **Owner sees:** picks a company in the switcher → the roster, team cards, and Files all narrow; a new agent lands in that company's folder; the PA still reaches everyone.

**P2 — connector store + vault.** `company_connectors` behavior: shared vs per-bot (name-matched wholesale replace), session-start materialization via `write_json_atomic`, the encrypt-at-rest vault, and the manager-sheet company scope + inherited/overridden UI (§6). **Done when:** two companies each hold a differently-credentialed Slack; a bot starts and its `local` scope shows exactly its company's (and any per-bot-override) connectors; secrets are sealed at rest and masked on read; gates green. **Owner sees:** configures Slack for Company X and Company Y with different tokens; each company's bot picks up its own on start; the sheet shows "inherited from company."

**P3 — external humans.** Per-company Cloudflare tunnel + Origin allowlist; Google login + human-auth middleware beside the bearer; per-company SSE channels; per-message human author provenance through `send_harness_text`; `author_user_id`/`company_id` on `audit_log`; iCal gating; owner/admin/member permissions; the connector-manager per-human isolation (§7). **Done when:** a Google-authenticated Company-B colleague reaches only Company-B agents (list, files, search, delegate all hard-scoped), each of their messages renders "●name" in the transcript, the audit ledger attributes actions to them, and no Company-A SSE/secret/iCal data reaches them; gates green. **Owner sees:** invites a colleague to one company; that colleague logs in via Google, chats with only that company's agents, and the owner sees the colleague's name on each message and in the audit log.

---

## 11. Testing & rollout

**Gates (every slice).** `cargo check` DEBUG (never `--release` — OOM), `bun run build:perf` in `web/`, and `tsc -b`. Never bounded `{m,n}` ripgrep `-o` on long-line files.

**Assertion & regression updates.**
- Bump `db/mod.rs:116` from 27 → 28 and update the message string at `:117-118` (P0). Each further migration (P3 tunnel/audit columns) bumps it again.
- Mirror the board_id backfill/cascade regression pattern (`db/mod.rs:124-218`) for companies: a test that `sessions.company_id` backfills NULL for the existing fleet, that `trg_company_delete_sessions` NULLs sessions on company delete, and that `trg_company_delete_connectors` cascades `company_connectors`.

**New delegation-gate tests** (beside the existing `delegate.rs:277-391` unit block):
- `same_company_delegate_allowed` — `from` and `to` share a `company_id` ⇒ delivered.
- `cross_company_delegate_refused_as_404` — different non-null companies ⇒ `NotFound`, no edge/audit written.
- `main_bot_bypass_into_any_company` — `from.company_id IS NULL` ⇒ delivered into a company target.
- `company_bot_cannot_reach_main_or_other` — a company bot to a NULL/main target and to another company both 404.
- `delegations_graph_filtered_by_company` — the read endpoint hides out-of-company edges from a scoped caller.

**Files-jail tests:** a company-scoped Files request cannot resolve a path outside `root_dir` (`..` and absolute-escape both 400); a main-bot request (jail None) still reaches an out-of-root path.

**Rollout.** Deploy each slice alone from this worktree (manual deploy-request, `source_dir=` the worktree) and let the owner verify visually before the next slice. Never restart the hosting instance unasked (MEMORY: never-restart-this-instance-unasked); test side-by-side on another port where a live check is needed.

---

## 12. Risks & explicitly deferred non-goals

**Risks.**
- **Symlink escape from a jailed company dir.** `resolve_safe` blocks `..` but does not chase a symlink inside `root_dir` pointing out (`path_safe.rs:134-137`). v1 company sessions are local-only for the jail guarantee; symlink-hardening (canonicalize-and-re-check, or refuse symlinks under company roots) is a follow-on. Remote-host company sessions do not get the local jail (`files/mod.rs:206`) and are out of scope for the isolation guarantee in v1.
- **`actor: 'human'` is unauthenticated until P3.** The composer's `actor:'human'` (`agents.ts:98`) is a label, not proof, today. The delegation gate deliberately keys the bypass on **`from.company_id IS NULL`** (a server-side row fact), never on `actor`, so the boundary never rests on a caller-declared field. Human *provenance* only becomes trustworthy in P3 when identity is server-established.
- **Materialization staleness.** Connectors are copied into `local` scope at start, so an edit lands on next start, not live. Documented; a "restart to apply" affordance mitigates it.
- **SSE leak if per-company channels slip.** Any P3 code path that publishes to the global `sse_tx` instead of a company channel re-opens the cross-company real-time leak. The per-company-channel change is a hard P3 gate, tested with two simultaneous human connections.
- **Vault key handling.** A lost `companies_vault_key` file makes every sealed `config_json` unreadable (connectors must be re-entered). Keyed exactly like `auth_token` so the operator's existing backup discipline covers it.

**Explicitly deferred non-goals.**
- **Moving an agent between companies** (folder move + connector re-materialization + delegation-graph relabel). Membership is fixed at create (decision #11).
- **Per-company server instances / true multi-tenant DB partitioning.** One instance, one DB, company as a filter attribute — by design.
- **Per-company slug namespaces.** Slugs stay globally unique (decision #3) — the central KISS lever.
- **Retroactive separation of legacy sessions into companies.** Pre-existing agents map to NULL/main only (§9).
- **Scoping boards/schedules/hosts to companies** beyond the lead-session/team rule (§5). Those tables stay global in v1; board/team scoping rides the lead session's company.
- **Attributing raw WS-pty keystrokes to a human.** Only composer sends carry provenance in P3; intercepting the pty write path is invasive and out of scope.

---

## Open decisions for the owner to confirm

1. **Seeded owner email.** The 0030 migration seeds `human_users` with a sentinel `owner@localhost` and binds the real email at runtime from config (keeps PII out of the checksummed, world-readable migration). Confirm this over hardcoding the real address.
2. **Company hard-delete never `rm`s `root_dir`.** Delete removes DB rows + seals, but leaves the folder on disk and returns its path. Confirm this data-safety default (vs an opt-in purge that also removes the folder).
3. **Company slug vs session slug.** Company slugs are unique within `companies` and additionally soft-rejected if equal to an existing session slug, for folder/URL legibility. Confirm the soft-reject (vs allowing identical names in the two separate namespaces).
4. **Per-bot connector override = wholesale name-matched replace** (not field-level merge), per decision #9. Confirmed here; flagging because it is the one connector-semantics fork.
5. **Duplicate inherits `company_id`.** A duplicated session stays in the source's company with a re-derived folder. Confirm (vs duplicating as a main bot).
