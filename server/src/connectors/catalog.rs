//! Server-side mirror of the public **PulseMCP** catalog
//! (`https://api.pulsemcp.com/v0beta/servers`) → supermux connector *cards*.
//!
//! The connector store shows a grid of real, installable MCP servers. Rather
//! than hotlink a third-party API from the browser (rate-limits, CORS, leaking
//! the viewer's IP, no offline story), the SERVER mirrors the catalog:
//!
//!   * [`CatalogMirror`] fetches one page of PulseMCP servers, maps each to a
//!     secret-free [card](map_server), and caches the result in memory with a
//!     6-hour TTL (same trade-off as [`crate::updates::release`]). A transient
//!     upstream outage never blanks the grid — the last good page is kept and,
//!     failing that, the always-present [`featured_cards`] curated set is shown.
//!   * Icons are **cached locally** (never hotlinked): when an upstream server
//!     advertises a standardized icon URL we mirror the bytes to
//!     `<data_dir>/catalog/icons/<id>` on refresh and rewrite the card's `icon`
//!     to our own `/api/connectors/catalog/icon/{id}` route.
//!
//! A catalog card is a *preview*: it carries no credential values and its
//! `emit` is a best-effort `mcpServers` launch template (a hosted `url`, or an
//! `npx`/`uvx` command derived from the package registry). Installing one —
//! turning it into a real `connectors` row with a credential schema — is the
//! ordinary manifest/import path; the mirror only powers discovery.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::RwLock;

/// Upstream catalog endpoint (public, unauthenticated JSON).
const PULSEMCP_URL: &str = "https://api.pulsemcp.com/v0beta/servers";

/// How many servers to mirror per refresh. PulseMCP indexes tens of thousands;
/// the store grid shows a curated, browsable slice, not the whole index. One
/// page keeps the payload small and the icon-mirror bounded.
const COUNT_PER_PAGE: u32 = 60;

/// Cache TTL. A catalog changes slowly; 6 hours is plenty fresh for a discovery
/// grid and keeps us far under any polite request budget even across a fleet of
/// dashboards sharing an outbound IP.
const TTL: Duration = Duration::from_secs(6 * 60 * 60);

/// Outbound request timeout — a slow upstream must never hang the store.
const FETCH_TIMEOUT: Duration = Duration::from_secs(8);

/// Per-icon mirror timeout (kept short; a missing icon is cosmetic).
const ICON_TIMEOUT: Duration = Duration::from_secs(6);

/// `User-Agent` we present to PulseMCP (a "where did this come from" pointer).
const USER_AGENT: &str = concat!(
    "supermux-server/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/sanderbz/supermux)"
);

/// The `source` tag every catalog card carries (vs. `"local"` rows from the DB).
pub const SOURCE_CATALOG: &str = "catalog";

// ── PulseMCP wire shapes ──────────────────────────────────────────────────────

/// One page of the `v0beta/servers` response. Tolerant by design: every field
/// is optional/defaulted so an upstream schema addition never breaks parsing.
#[derive(Debug, Clone, Deserialize)]
pub struct ServersPage {
    #[serde(default)]
    pub servers: Vec<PulseServer>,
    #[serde(default)]
    pub total_count: Option<u64>,
    #[serde(default)]
    pub next: Option<String>,
}

/// One PulseMCP server row.
#[derive(Debug, Clone, Deserialize)]
pub struct PulseServer {
    #[serde(default)]
    pub name: String,
    /// The canonical PulseMCP page (`.../servers/<slug>`); we derive the card id
    /// from its last path segment.
    #[serde(default)]
    pub url: Option<String>,
    /// The project's own homepage.
    #[serde(default)]
    pub external_url: Option<String>,
    #[serde(default)]
    pub short_description: Option<String>,
    #[serde(default)]
    pub source_code_url: Option<String>,
    #[serde(default)]
    pub github_stars: Option<i64>,
    #[serde(default)]
    pub package_registry: Option<String>,
    #[serde(default)]
    pub package_name: Option<String>,
    #[serde(default)]
    pub package_download_count: Option<i64>,
    /// A longer, model-written blurb PulseMCP sometimes carries; used as a
    /// description fallback.
    #[serde(default, rename = "EXPERIMENTAL_ai_generated_description")]
    pub ai_description: Option<String>,
    #[serde(default)]
    pub remotes: Vec<PulseRemote>,
    /// Standardized icons `[{src,sizes}]`. Absent on the current endpoint; kept
    /// so the mirror lights up automatically if/when PulseMCP adds it.
    #[serde(default)]
    pub icons: Vec<PulseIcon>,
}

/// A hosted (remote) transport for a server.
#[derive(Debug, Clone, Deserialize)]
pub struct PulseRemote {
    #[serde(default)]
    pub url_direct: Option<String>,
    #[serde(default)]
    pub url_setup: Option<String>,
    #[serde(default)]
    pub transport: Option<String>,
    #[serde(default)]
    pub authentication_method: Option<String>,
    #[serde(default)]
    pub cost: Option<String>,
}

/// A standardized icon reference.
#[derive(Debug, Clone, Deserialize)]
pub struct PulseIcon {
    #[serde(default)]
    pub src: String,
    #[serde(default)]
    pub sizes: Option<String>,
}

// ── mapping: PulseMCP server → supermux card ──────────────────────────────────

/// Derive a stable, valid connector id for a mirrored server. Prefers the
/// PulseMCP page slug (already a clean slug, globally unique in the index),
/// prefixed `pmcp-` to namespace it away from locally-created connectors; falls
/// back to slugifying the display name. Returns `None` if nothing usable.
pub fn catalog_id(s: &PulseServer) -> Option<String> {
    let slug = s
        .url
        .as_deref()
        .and_then(|u| u.trim_end_matches('/').rsplit('/').next())
        .map(str::trim)
        .filter(|seg| !seg.is_empty())
        .map(slugify)
        .filter(|seg| !seg.is_empty())
        .unwrap_or_else(|| slugify(&s.name));
    if slug.is_empty() {
        return None;
    }
    let id = format!("pmcp-{slug}");
    let id: String = id.chars().take(100).collect();
    super::manifest::valid_connector_id(&id).then_some(id)
}

/// Best-effort `mcpServers` launch template for a mirrored server. A hosted
/// remote becomes a `{ "url": … }` entry; an npm/pypi package becomes an
/// `npx`/`uvx` command; otherwise an empty object (the installer supplies it).
fn emit_template(s: &PulseServer) -> Value {
    if let Some(r) = s.remotes.iter().find(|r| r.url_direct.is_some()) {
        let url = r.url_direct.clone().unwrap_or_default();
        return json!({ "url": url });
    }
    match (s.package_registry.as_deref(), s.package_name.as_deref()) {
        (Some("npm"), Some(pkg)) => json!({ "command": "npx", "args": ["-y", pkg] }),
        (Some("pypi"), Some(pkg)) => json!({ "command": "uvx", "args": [pkg] }),
        _ => json!({}),
    }
}

/// Coarse category tags for the store's category filter. Derived from what the
/// upstream actually tells us (hosted vs. packaged, the registry) plus the
/// `featured` flag — PulseMCP exposes no first-class taxonomy on this endpoint.
fn categories(s: &PulseServer, featured: bool) -> Vec<String> {
    let mut cats = Vec::new();
    if featured {
        cats.push("featured".to_string());
    }
    if s.remotes.iter().any(|r| r.url_direct.is_some()) {
        cats.push("hosted".to_string());
    }
    if let Some(reg) = s.package_registry.as_deref() {
        if !reg.is_empty() {
            cats.push(reg.to_ascii_lowercase());
        }
    }
    if cats.iter().all(|c| c == "featured") {
        cats.push("mcp".to_string());
    }
    cats
}

/// Pull a leading `"<N> tools"` count out of a description when present
/// (PulseMCP blurbs frequently say e.g. "…with 22 tools for…"). Returns `None`
/// when there's no such phrase — we never fabricate a count.
fn tool_count_from(desc: &str) -> Option<u32> {
    let lower = desc.to_ascii_lowercase();
    let idx = lower.find(" tools")?;
    let head = &lower[..idx];
    let digits: String = head
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit() || *c == ' ')
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>()
        .trim()
        .to_string();
    digits.parse().ok()
}

/// Map one PulseMCP server to a secret-free supermux store card. `featured`
/// pins it in the curated set. `icon` is whatever the caller resolved (a local
/// mirrored route path, or empty) — mapping never hotlinks.
pub fn map_server(s: &PulseServer, featured: bool, icon: String) -> Option<Value> {
    let id = catalog_id(s)?;
    let display_name = if s.name.trim().is_empty() {
        id.clone()
    } else {
        s.name.trim().to_string()
    };
    let description = s
        .short_description
        .as_deref()
        .filter(|d| !d.trim().is_empty())
        .or(s.ai_description.as_deref())
        .unwrap_or("")
        .trim()
        .to_string();
    let tool_count = tool_count_from(&description);
    let transport = s
        .remotes
        .iter()
        .find_map(|r| r.transport.clone())
        .unwrap_or_else(|| "stdio".to_string());

    Some(json!({
        "id": id,
        "kind": super::manifest::KIND_MCP_CATALOG,
        "display_name": display_name,
        "icon": icon,
        // A mirrored row carries no curated lucide glyph / install line; those
        // are properties of the curated catalog card it enriches (client-side the
        // fields are optional). Kept here so every card shares one shape.
        "lucide": Value::Null,
        "install": Value::Null,
        "official": false,
        "description": description,
        // Preview cards declare no tools (the list endpoint carries none); the
        // count, when the blurb states one, powers the "N tools" chip.
        "tools": [],
        "tool_count": tool_count,
        "credentials": [],
        "emit": emit_template(s),
        "source": SOURCE_CATALOG,
        "featured": featured,
        "stars": s.github_stars,
        "downloads": s.package_download_count,
        "homepage_url": s.external_url,
        "source_url": s.source_code_url,
        "pulsemcp_url": s.url,
        "registry": s.package_registry,
        "package_name": s.package_name,
        "transport": transport,
        // The per-connector auth DESCRIPTOR (`{ kind, … }`), mapped from the coarse
        // PulseMCP `authentication_method` hint. A curated id's real descriptor
        // still wins in `merge_featured`; a mirrored non-curated row is retired.
        "auth": pulse_auth_descriptor(s.remotes.iter().find_map(|r| r.authentication_method.as_deref())),
        "categories": categories(s, featured),
        "created_at": 0,
    }))
}

/// Map a whole page to cards, resolving the featured flag by id and using
/// whatever icon each card already advertises inline (mirroring to disk is done
/// separately by [`CatalogMirror::refresh`] which has the `data_dir`).
pub fn map_page(page: &ServersPage) -> Vec<Value> {
    page.servers
        .iter()
        .filter_map(|s| {
            let id = catalog_id(s);
            let featured = id.as_deref().map(is_featured).unwrap_or(false);
            let icon = s.icons.first().map(|i| i.src.clone()).unwrap_or_default();
            map_server(s, featured, icon)
        })
        .collect()
}

// ── curated catalog ───────────────────────────────────────────────────────────

/// The featured (marquee) ids — the small hero pin-list, surfaced first. A subset
/// of the full curated set below; every other curated card is a browse-tier card.
const FEATURED_IDS: &[&str] = &[
    "pmcp-filesystem",
    "pmcp-github",
    "pmcp-notion",
    "pmcp-slack",
    "pmcp-linear",
    "pmcp-sentry",
    "pmcp-postgres",
    "pmcp-playwright",
    "pmcp-google-drive",
    "pmcp-stripe",
    "pmcp-zapier",
    "pmcp-figma",
    // The owner's own GSC-analytics product, pinned as a showcase remote.
    "pmcp-inhouseseo",
];

/// Every id in the curated catalog (`featured_cards`). The live PulseMCP mirror
/// is treated as ENRICHMENT ONLY: [`CatalogMirror::refresh`] keeps a fetched row
/// only when its id is one of these, so the store is the curated catalog (never
/// the unranked page-0 dump that produced the "nonsense descriptions"), while a
/// live row for a curated id can still win in [`merge_featured`] (richer stars).
const CURATED_IDS: &[&str] = &[
    "pmcp-filesystem",
    "pmcp-fetch",
    "pmcp-git",
    "pmcp-memory",
    "pmcp-sequential-thinking",
    "pmcp-time",
    "pmcp-everything",
    "pmcp-github",
    "pmcp-sentry",
    "pmcp-linear",
    "pmcp-notion",
    "pmcp-slack",
    "pmcp-asana",
    "pmcp-atlassian",
    "pmcp-stripe",
    "pmcp-paypal",
    "pmcp-plaid",
    "pmcp-square",
    "pmcp-intercom",
    "pmcp-cloudflare",
    "pmcp-hubspot",
    "pmcp-zapier",
    "pmcp-webflow",
    "pmcp-canva",
    "pmcp-figma",
    "pmcp-google-drive",
    "pmcp-google-maps",
    "pmcp-postgres",
    "pmcp-airtable",
    "pmcp-playwright",
    "pmcp-puppeteer",
    // ── expansion: hosted-remote (mcp_oauth) + key-based (api_key) vendor cards ──
    "pmcp-discord",
    "pmcp-vercel",
    "pmcp-box",
    "pmcp-monday",
    "pmcp-clickup",
    "pmcp-brave-search",
    // ── expansion: marketing / SEO / AI-image cards ──
    "pmcp-ahrefs",
    "pmcp-dataforseo",
    "pmcp-openai-image",
    "pmcp-cloudflare-builds",
    "pmcp-inhouseseo",
    // Google Analytics (GA4) — official `analytics-mcp`, service-account JSON
    // materialized to a 0600 FILE at launch (Lane C form; file credential).
    "pmcp-google-analytics",
];

/// Is a mirrored card part of the curated featured (marquee) set?
pub fn is_featured(id: &str) -> bool {
    FEATURED_IDS.contains(&id)
}

/// Is this id part of the curated catalog? (The mirror keeps only these.)
pub fn is_curated(id: &str) -> bool {
    CURATED_IDS.contains(&id)
}

// ── per-connector AUTH descriptor (the Lane taxonomy) ─────────────────────────

/// Build a card-shaped auth descriptor (`{ kind, help_url?, help_text?,
/// token_field? }`). Mirrors [`super::manifest::AuthDescriptor`]'s serialized
/// shape — the OAuth-URL fields stay absent (reserved for P2). Null keys are
/// omitted so the web reads a stable `{ kind, … }`.
fn auth_descriptor(
    kind: &str,
    help_url: Option<&str>,
    help_text: Option<&str>,
    token_field: Option<&str>,
) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("kind".into(), json!(kind));
    if let Some(u) = help_url {
        m.insert("help_url".into(), json!(u));
    }
    if let Some(t) = help_text {
        m.insert("help_text".into(), json!(t));
    }
    if let Some(f) = token_field {
        m.insert("token_field".into(), json!(f));
    }
    Value::Object(m)
}

/// A single sensitive-field credential schema (Lane B/C paste input).
fn one_secret(key: &str, title: &str) -> Value {
    json!([{ "key": key, "title": title, "type": "string", "sensitive": true, "required": true }])
}

/// The steer copy for a hosted remote MCP that runs its OWN OAuth in the bot's
/// terminal (Lane D) — the honest "no key here" note.
const MCP_OAUTH_HELP: &str = "Signs in the first time your bot uses it — approve the sign-in in the bot's own terminal. There's no key to paste here.";

/// The **per-connector auth descriptor + credential schema** for a curated card,
/// keyed by id. This is the single source of the Lane taxonomy (§0 of the design):
///
///   * **Lane E `none`** — local reference servers + local dev tooling that need no
///     sign-in (Filesystem/Fetch/Git/Memory/Sequential-Thinking/Time/Everything,
///     Figma Dev-Mode on `127.0.0.1`, Playwright, Puppeteer).
///   * **Lane B `api_key`** — a genuine token/secret to paste: GitHub PAT, Stripe
///     secret key, the Zapier personal-MCP URL (carries its key), Google-Maps API
///     key, Airtable PAT. Each gets a "Get your key →" deep link + a steer.
///   * **Lane C `form`** — Postgres: a read-only connection string (DSN).
///   * **Lane D `mcp_oauth`** — a hosted remote MCP whose endpoint runs its OWN
///     OAuth in the client (Slack/Notion/Linear/Sentry/Asana/Atlassian/PayPal/
///     Plaid/Square/Intercom/Cloudflare/HubSpot/Webflow/Canva/Google-Drive). NO
///     key field — the honest "signs in in the terminal" note instead.
///
/// Returns `(auth, credentials)`; `credentials` is `[]` for `none`/`mcp_oauth`.
fn auth_and_creds_for(id: &str) -> (Value, Value) {
    let none = || (auth_descriptor("none", None, None, None), json!([]));
    let mcp_oauth = || (auth_descriptor("mcp_oauth", None, Some(MCP_OAUTH_HELP), None), json!([]));
    match id {
        // Lane E — no sign-in.
        "pmcp-filesystem" | "pmcp-fetch" | "pmcp-git" | "pmcp-memory"
        | "pmcp-sequential-thinking" | "pmcp-time" | "pmcp-everything" | "pmcp-figma"
        | "pmcp-playwright" | "pmcp-puppeteer" => none(),

        // Lane B — a real key/token to paste.
        "pmcp-github" => (
            auth_descriptor(
                "api_key",
                Some("https://github.com/settings/personal-access-tokens"),
                Some("Create a fine-grained personal access token with only the repo scopes this bot needs."),
                Some("GITHUB_TOKEN"),
            ),
            one_secret("GITHUB_TOKEN", "Personal access token"),
        ),
        "pmcp-stripe" => (
            auth_descriptor(
                "api_key",
                Some("https://dashboard.stripe.com/apikeys"),
                Some("Use a restricted secret key scoped to what this bot needs."),
                Some("STRIPE_SECRET_KEY"),
            ),
            one_secret("STRIPE_SECRET_KEY", "Secret key"),
        ),
        "pmcp-zapier" => (
            auth_descriptor(
                "api_key",
                Some("https://mcp.zapier.com/"),
                Some("Paste your personal Zapier MCP URL — it carries your key, so treat it like one."),
                Some("ZAPIER_MCP_URL"),
            ),
            one_secret("ZAPIER_MCP_URL", "Your Zapier MCP URL"),
        ),
        "pmcp-google-maps" => (
            auth_descriptor(
                "api_key",
                Some("https://console.cloud.google.com/google/maps-apis/credentials"),
                Some("Create a Maps Platform API key restricted to the APIs this bot uses."),
                Some("GOOGLE_MAPS_API_KEY"),
            ),
            one_secret("GOOGLE_MAPS_API_KEY", "API key"),
        ),
        "pmcp-airtable" => (
            auth_descriptor(
                "api_key",
                Some("https://airtable.com/create/tokens"),
                Some("Create a personal access token scoped to the base this bot needs."),
                Some("AIRTABLE_API_KEY"),
            ),
            one_secret("AIRTABLE_API_KEY", "Personal access token"),
        ),

        // Lane C — a structured connection string.
        "pmcp-postgres" => (
            auth_descriptor(
                "form",
                None,
                Some("Paste a read-only Postgres connection string (DSN) — the bot queries through it."),
                Some("POSTGRES_DSN"),
            ),
            one_secret("POSTGRES_DSN", "Connection string (DSN)"),
        ),

        // Discord has no official hosted remote MCP; the honest lane is a pasted
        // bot token that a community npx server (env DISCORD_TOKEN) reads.
        "pmcp-discord" => (
            auth_descriptor(
                "api_key",
                Some("https://discord.com/developers/applications"),
                Some("Create a bot in the Discord Developer Portal, invite it to your server, and paste its bot token."),
                Some("DISCORD_TOKEN"),
            ),
            one_secret("DISCORD_TOKEN", "Bot token"),
        ),
        // Brave Search — a pasted API key the npx server reads (free tier available).
        "pmcp-brave-search" => (
            auth_descriptor(
                "api_key",
                Some("https://api-dashboard.search.brave.com/app/keys"),
                Some("Create a Brave Search API key (a free tier is available) and paste it here."),
                Some("BRAVE_API_KEY"),
            ),
            one_secret("BRAVE_API_KEY", "API key"),
        ),
        // Ahrefs ships an OFFICIAL npx server (`@ahrefs/mcp`) that reads an
        // Ahrefs API v3 key from env `API_KEY` (needs a paid API subscription).
        "pmcp-ahrefs" => (
            auth_descriptor(
                "api_key",
                Some("https://app.ahrefs.com/api/keys"),
                Some("Paste your Ahrefs API v3 key — needs a paid Ahrefs API subscription (it consumes API units)."),
                Some("API_KEY"),
            ),
            one_secret("API_KEY", "Ahrefs API key"),
        ),
        // OpenAI GPT Image — a community npx server that generates/edits images
        // with gpt-image-1, reading an OpenAI key from env `OPENAI_API_KEY`.
        "pmcp-openai-image" => (
            auth_descriptor(
                "api_key",
                Some("https://platform.openai.com/api-keys"),
                Some("Paste an OpenAI API key — generates/edits images with gpt-image-1 (community server)."),
                Some("OPENAI_API_KEY"),
            ),
            one_secret("OPENAI_API_KEY", "OpenAI API key"),
        ),
        // DataForSEO uses HTTP basic auth via TWO env vars → a 2-field form: a
        // NON-secret API login + a SENSITIVE API password (no single token field).
        "pmcp-dataforseo" => (
            auth_descriptor(
                "form",
                Some("https://app.dataforseo.com/api-access"),
                Some("SERP/SEO data; your DataForSEO login + API password from the API access page."),
                None,
            ),
            json!([
                { "key": "DATAFORSEO_USERNAME", "title": "API login", "type": "string", "sensitive": false, "required": true },
                { "key": "DATAFORSEO_PASSWORD", "title": "API password", "type": "string", "sensitive": true, "required": true }
            ]),
        ),

        // Google Analytics (GA4) — the OFFICIAL `analytics-mcp` server authenticates
        // with a Google service-account JSON FILE (env GOOGLE_APPLICATION_CREDENTIALS
        // = a file path), NOT a pasted key value. Lane C form: one SENSITIVE JSON
        // field flagged `file_env`, so at launch the vaulted blob is materialized to
        // a 0600 file in the session's own dir and the env var points at that path.
        "pmcp-google-analytics" => (
            auth_descriptor(
                "form",
                Some("https://console.cloud.google.com/iam-admin/serviceaccounts"),
                Some("Paste your GA4 service-account JSON key. Create one in Google Cloud with the Analytics Data API enabled and read access to your GA4 property."),
                None,
            ),
            json!([{
                "key": "GA_SERVICE_ACCOUNT_JSON",
                "title": "Service-account JSON key",
                "type": "string",
                "sensitive": true,
                "required": true,
                "file_env": "GOOGLE_APPLICATION_CREDENTIALS"
            }]),
        ),

        // Lane D — hosted remote MCP, client-driven OAuth (no key here).
        "pmcp-sentry" | "pmcp-linear" | "pmcp-notion" | "pmcp-slack" | "pmcp-asana"
        | "pmcp-atlassian" | "pmcp-paypal" | "pmcp-plaid" | "pmcp-square" | "pmcp-intercom"
        | "pmcp-cloudflare" | "pmcp-hubspot" | "pmcp-webflow" | "pmcp-canva"
        | "pmcp-google-drive"
        // Vercel/Box/monday.com/ClickUp all ship an OFFICIAL hosted remote MCP with
        // OAuth (mcp.vercel.com, mcp.box.com, mcp.monday.com/mcp, mcp.clickup.com/mcp).
        | "pmcp-vercel" | "pmcp-box" | "pmcp-monday" | "pmcp-clickup"
        // Cloudflare Workers Builds (the deploy-inspect successor to Pages) and
        // InhouseSEO (a hosted GSC-analytics remote) both run their OWN OAuth —
        // verified 401 + `WWW-Authenticate: Bearer resource_metadata=…` challenge.
        | "pmcp-cloudflare-builds" | "pmcp-inhouseseo" => mcp_oauth(),

        // Any other curated id defaults to no-auth rather than a fake key field.
        _ => none(),
    }
}

/// The auth descriptor for a curated catalog id, or `None` when the id is not part
/// of the curated set (a local connector then derives its lane from its schema).
/// Used by [`super::api::card`] so an installed catalog card keeps its real lane.
pub fn curated_auth(id: &str) -> Option<Value> {
    if !is_curated(id) {
        return None;
    }
    Some(auth_and_creds_for(id).0)
}

/// The store-taxonomy tags for a curated catalog id, or `None` when the id is not
/// curated. Used by [`super::api::card`] so an INSTALLED catalog card keeps the
/// same category chip as its store card (the installed local row itself carries no
/// tags). Reads the curated card's own `categories` — single source of truth.
pub fn curated_categories(id: &str) -> Option<Vec<String>> {
    if !is_curated(id) {
        return None;
    }
    featured_cards()
        .into_iter()
        .find(|c| c.get("id").and_then(Value::as_str) == Some(id))
        .and_then(|c| c.get("categories").cloned())
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
}

/// Map a PulseMCP `authentication_method` string onto a card auth descriptor. A
/// mirrored row's method is a coarse hint; a curated id's descriptor still wins in
/// [`merge_featured`]. Unknown/absent → `none` rather than a fake key field.
fn pulse_auth_descriptor(method: Option<&str>) -> Value {
    let kind = match method.map(|m| m.trim().to_ascii_lowercase()).as_deref() {
        Some("oauth") | Some("oauth2") => "mcp_oauth",
        Some("api_key") | Some("apikey") | Some("token") | Some("bearer") => "api_key",
        _ => "none",
    };
    auth_descriptor(kind, None, None, None)
}

/// The always-present curated catalog — the full store. These render instantly
/// with zero network (the store is never empty) and are merged/deduped with the
/// live mirror when it warms — a live PulseMCP row for the same id wins (richer
/// metadata). 43 cards: the 7 first-party Anthropic/MCP reference servers
/// (`official: true`) plus 36 widely-used official-directory vendor connectors.
pub fn featured_cards() -> Vec<Value> {
    #[allow(clippy::too_many_arguments)]
    fn card(
        id: &str,
        name: &str,
        category: &str,
        lucide: &str,
        official: bool,
        featured: bool,
        desc: &str,
        install: &str,
        emit: Value,
        transport: &str,
    ) -> Value {
        let mut categories: Vec<String> = Vec::new();
        if featured {
            categories.push("featured".into());
        }
        categories.push(category.into());
        json!({
            "id": id,
            "kind": super::manifest::KIND_MCP_CATALOG,
            "display_name": name,
            // No bundled icon bytes; the client draws the named lucide glyph (or
            // a recognised brand mark) — never an empty monogram for a curated card.
            "icon": "",
            "lucide": lucide,
            "description": desc,
            "tools": [],
            "tool_count": Value::Null,
            "credentials": [],
            "emit": emit,
            // The exact one-line install/connect command shown on the detail sheet.
            "install": install,
            "source": SOURCE_CATALOG,
            "featured": featured,
            // The 7 first-party Anthropic/MCP reference servers wear an "Official" badge.
            "official": official,
            "stars": Value::Null,
            "downloads": Value::Null,
            "homepage_url": Value::Null,
            "source_url": Value::Null,
            "pulsemcp_url": Value::Null,
            "registry": Value::Null,
            "package_name": Value::Null,
            "transport": transport,
            "auth": Value::Null,
            "categories": categories,
            "created_at": 0,
        })
    }
    // emit helpers: a stdio launch (npx/uvx) or a hosted-remote `{ url }`.
    fn npx(args: &[&str]) -> Value {
        json!({ "command": "npx", "args": args })
    }
    fn uvx(args: &[&str]) -> Value {
        json!({ "command": "uvx", "args": args })
    }
    fn remote(url: &str) -> Value {
        json!({ "url": url })
    }
    let mut cards = vec![
        // ── Tier 1 — first-party Anthropic / MCP reference servers (official) ──
        card(
            "pmcp-filesystem", "Filesystem", "developer", "folder", true, true,
            "Secure local file read/write with configurable allowed-path access controls.",
            "npx -y @modelcontextprotocol/server-filesystem /path/to/allowed",
            npx(&["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed"]), "stdio",
        ),
        card(
            "pmcp-fetch", "Fetch", "developer", "globe", true, false,
            "Fetches any URL and converts the page to clean markdown for the model to read.",
            "uvx mcp-server-fetch",
            uvx(&["mcp-server-fetch"]), "stdio",
        ),
        card(
            "pmcp-git", "Git", "developer", "git-branch", true, false,
            "Read, search, stage, and commit in local Git repositories.",
            "uvx mcp-server-git",
            uvx(&["mcp-server-git"]), "stdio",
        ),
        card(
            "pmcp-memory", "Memory", "data", "brain", true, false,
            "Knowledge-graph persistent memory that carries facts across sessions.",
            "npx -y @modelcontextprotocol/server-memory",
            npx(&["-y", "@modelcontextprotocol/server-memory"]), "stdio",
        ),
        card(
            "pmcp-sequential-thinking", "Sequential Thinking", "ai", "list-ordered", true, false,
            "Structured multi-step reasoning through revisable thought sequences.",
            "npx -y @modelcontextprotocol/server-sequentialthinking",
            npx(&["-y", "@modelcontextprotocol/server-sequentialthinking"]), "stdio",
        ),
        card(
            "pmcp-time", "Time", "developer", "clock", true, false,
            "Current time and timezone conversion utilities.",
            "uvx mcp-server-time",
            uvx(&["mcp-server-time"]), "stdio",
        ),
        card(
            "pmcp-everything", "Everything", "developer", "box", true, false,
            "Reference test server exercising every MCP feature — tools, prompts, resources.",
            "npx -y @modelcontextprotocol/server-everything",
            npx(&["-y", "@modelcontextprotocol/server-everything"]), "stdio",
        ),
        // ── Tier 2 — official-directory vendor connectors ─────────────────────
        card(
            "pmcp-github", "GitHub", "developer", "github", false, true,
            "Manage repositories, issues, pull requests, and code via GitHub's hosted server.",
            "claude mcp add --transport http github https://api.githubcopilot.com/mcp/ --header \"Authorization: Bearer <PAT>\"",
            remote("https://api.githubcopilot.com/mcp/"), "streamable_http",
        ),
        card(
            "pmcp-sentry", "Sentry", "developer", "sentry", false, true,
            "Query errors, issues, and performance data from your Sentry projects.",
            "claude mcp add --transport http sentry https://mcp.sentry.dev/mcp",
            remote("https://mcp.sentry.dev/mcp"), "streamable_http",
        ),
        card(
            "pmcp-linear", "Linear", "productivity", "linear", false, true,
            "Create and manage Linear issues, projects, and cycles.",
            "claude mcp add --transport http linear https://mcp.linear.app/mcp",
            remote("https://mcp.linear.app/mcp"), "streamable_http",
        ),
        card(
            "pmcp-notion", "Notion", "productivity", "notion", false, true,
            "Read and write Notion pages, databases, and comments.",
            "claude mcp add --transport http notion https://mcp.notion.com/mcp",
            remote("https://mcp.notion.com/mcp"), "streamable_http",
        ),
        card(
            "pmcp-slack", "Slack", "communication", "slack", false, true,
            "Read channels and post messages in your Slack workspace.",
            "claude mcp add --transport http slack https://mcp.slack.com/mcp",
            remote("https://mcp.slack.com/mcp"), "streamable_http",
        ),
        card(
            "pmcp-asana", "Asana", "productivity", "list-todo", false, false,
            "Manage Asana tasks, projects, and workspaces.",
            "claude mcp add --transport sse asana https://mcp.asana.com/sse",
            remote("https://mcp.asana.com/sse"), "sse",
        ),
        card(
            "pmcp-atlassian", "Jira & Confluence", "developer", "square-kanban", false, false,
            "Work with Atlassian Jira issues and Confluence pages.",
            "claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp",
            remote("https://mcp.atlassian.com/v1/mcp"), "streamable_http",
        ),
        card(
            "pmcp-stripe", "Stripe", "finance", "credit-card", false, true,
            "Query payments and customers and manage billing across your Stripe account.",
            "claude mcp add --transport http stripe https://mcp.stripe.com",
            remote("https://mcp.stripe.com"), "streamable_http",
        ),
        card(
            "pmcp-paypal", "PayPal", "finance", "wallet", false, false,
            "Create invoices and manage orders and payments in PayPal.",
            "claude mcp add --transport http paypal https://mcp.paypal.com/mcp",
            remote("https://mcp.paypal.com/mcp"), "streamable_http",
        ),
        card(
            "pmcp-plaid", "Plaid", "finance", "landmark", false, false,
            "Access financial account and transaction data through Plaid.",
            "claude mcp add --transport sse plaid https://api.dashboard.plaid.com/mcp/sse",
            remote("https://api.dashboard.plaid.com/mcp/sse"), "sse",
        ),
        card(
            "pmcp-square", "Square", "finance", "square", false, false,
            "Manage Square payments, catalog, orders, and customers.",
            "claude mcp add --transport sse square https://mcp.squareup.com/sse",
            remote("https://mcp.squareup.com/sse"), "sse",
        ),
        card(
            "pmcp-intercom", "Intercom", "communication", "message-circle", false, false,
            "Search conversations and customer-support data in Intercom.",
            "claude mcp add --transport http intercom https://mcp.intercom.com/mcp",
            remote("https://mcp.intercom.com/mcp"), "streamable_http",
        ),
        card(
            "pmcp-cloudflare", "Cloudflare", "developer", "cloud", false, false,
            "Manage Cloudflare Workers, bindings, DNS, and read the docs.",
            "claude mcp add --transport http cloudflare https://bindings.mcp.cloudflare.com/mcp",
            remote("https://bindings.mcp.cloudflare.com/mcp"), "streamable_http",
        ),
        card(
            "pmcp-hubspot", "HubSpot", "data", "users", false, false,
            "Read and update HubSpot CRM contacts, companies, and deals.",
            "claude mcp add --transport http hubspot https://mcp.hubspot.com/anthropic",
            remote("https://mcp.hubspot.com/anthropic"), "streamable_http",
        ),
        card(
            "pmcp-zapier", "Zapier", "productivity", "zap", false, true,
            "Trigger actions across 8,000+ apps through your personal Zapier MCP URL.",
            "claude mcp add --transport http zapier <your-mcp.zapier.com-url>",
            json!({}), "streamable_http",
        ),
        card(
            "pmcp-webflow", "Webflow", "productivity", "layout-template", false, false,
            "Manage Webflow CMS collections and site content.",
            "Remote MCP via the Anthropic Directory (claude.ai/directory)",
            json!({}), "streamable_http",
        ),
        card(
            "pmcp-canva", "Canva", "ai", "palette", false, false,
            "Create and manage Canva designs.",
            "Remote MCP via the Anthropic Directory (claude.ai/directory)",
            json!({}), "streamable_http",
        ),
        card(
            "pmcp-figma", "Figma", "developer", "figma", false, true,
            "Pull Figma design context into code with the Dev Mode MCP server.",
            "claude mcp add --transport http figma http://127.0.0.1:3845/mcp",
            remote("http://127.0.0.1:3845/mcp"), "streamable_http",
        ),
        card(
            "pmcp-google-drive", "Google Drive", "data", "hard-drive", false, true,
            "Search, read, and manage files in Google Drive.",
            "Remote connector via claude.ai (endpoint https://drivemcp.googleapis.com/mcp/v1, OAuth)",
            remote("https://drivemcp.googleapis.com/mcp/v1"), "streamable_http",
        ),
        card(
            "pmcp-google-maps", "Google Maps", "data", "map-pin", false, false,
            "Geocoding, place search, and directions.",
            "npx -y @modelcontextprotocol/server-google-maps",
            npx(&["-y", "@modelcontextprotocol/server-google-maps"]), "stdio",
        ),
        card(
            "pmcp-postgres", "PostgreSQL", "data", "database", false, true,
            "Query a Postgres (or other SQL) database over a DSN via DBHub — use a read-only user.",
            "npx -y @bytebase/dbhub --dsn \"postgresql://readonly:pass@host:5432/db\"",
            npx(&["-y", "@bytebase/dbhub", "--dsn", "postgresql://readonly:pass@host:5432/db"]), "stdio",
        ),
        card(
            "pmcp-airtable", "Airtable", "data", "table", false, false,
            "Read and write Airtable bases and records.",
            "npx -y airtable-mcp-server  (env AIRTABLE_API_KEY)",
            npx(&["-y", "airtable-mcp-server"]), "stdio",
        ),
        card(
            "pmcp-playwright", "Playwright", "browser", "playwright", false, true,
            "Drive a real browser — navigate, click, and snapshot — for web automation and testing.",
            "npx -y @playwright/mcp@latest",
            npx(&["-y", "@playwright/mcp@latest"]), "stdio",
        ),
        card(
            "pmcp-puppeteer", "Puppeteer", "browser", "mouse-pointer-click", false, false,
            "Headless-Chrome browser automation and screenshots.",
            "npx -y @modelcontextprotocol/server-puppeteer",
            npx(&["-y", "@modelcontextprotocol/server-puppeteer"]), "stdio",
        ),
        // ── Tier 2 (cont.) — expansion vendor connectors ──────────────────────
        card(
            "pmcp-discord", "Discord", "communication", "message-circle", false, false,
            "Read channels and post messages in a Discord server via a bot token.",
            "npx -y discord-mcp   (env DISCORD_TOKEN — create a bot at discord.com/developers)",
            npx(&["-y", "discord-mcp"]), "stdio",
        ),
        card(
            "pmcp-vercel", "Vercel", "developer", "triangle", false, false,
            "Manage Vercel projects, deployments, and logs, and search the docs.",
            "claude mcp add --transport http vercel https://mcp.vercel.com",
            remote("https://mcp.vercel.com"), "streamable_http",
        ),
        card(
            "pmcp-box", "Box", "data", "box", false, false,
            "Search, read, and manage files in Box with your existing permissions.",
            "claude mcp add --transport http box https://mcp.box.com",
            remote("https://mcp.box.com"), "streamable_http",
        ),
        card(
            "pmcp-monday", "monday.com", "productivity", "layout-grid", false, false,
            "Manage monday.com boards, items, and updates.",
            "claude mcp add --transport http monday https://mcp.monday.com/mcp",
            remote("https://mcp.monday.com/mcp"), "streamable_http",
        ),
        card(
            "pmcp-clickup", "ClickUp", "productivity", "list-checks", false, false,
            "Manage ClickUp tasks, lists, and docs.",
            "claude mcp add --transport http clickup https://mcp.clickup.com/mcp",
            remote("https://mcp.clickup.com/mcp"), "streamable_http",
        ),
        card(
            "pmcp-brave-search", "Brave Search", "developer", "search", false, false,
            "Web, news, and local search for the agent via the Brave Search API.",
            "npx -y @brave/brave-search-mcp-server   (env BRAVE_API_KEY)",
            npx(&["-y", "@brave/brave-search-mcp-server"]), "stdio",
        ),
        // ── Tier 2 (cont.) — marketing / SEO / AI-image connectors ─────────────
        card(
            "pmcp-ahrefs", "Ahrefs", "data", "trending-up", false, false,
            "Backlinks, keywords, and site metrics from Ahrefs (needs a paid Ahrefs API subscription).",
            "npx -y @ahrefs/mcp   (env API_KEY)",
            npx(&["-y", "@ahrefs/mcp"]), "stdio",
        ),
        card(
            "pmcp-dataforseo", "DataForSEO", "data", "bar-chart-3", false, false,
            "SERP, keyword, and on-page SEO data from DataForSEO.",
            "npx -y dataforseo-mcp-server   (env DATAFORSEO_USERNAME + DATAFORSEO_PASSWORD)",
            npx(&["-y", "dataforseo-mcp-server"]), "stdio",
        ),
        card(
            "pmcp-openai-image", "OpenAI GPT Image", "ai", "image", false, false,
            "Generate and edit images with OpenAI's gpt-image-1 (community server).",
            "npx -y @cloudwerxlab/gpt-image-1-mcp   (env OPENAI_API_KEY)",
            npx(&["-y", "@cloudwerxlab/gpt-image-1-mcp"]), "stdio",
        ),
        card(
            "pmcp-cloudflare-builds", "Cloudflare Workers Builds", "developer", "hammer", false, false,
            "Deploy and inspect Cloudflare Workers/Pages builds — the current successor to Pages.",
            "claude mcp add --transport http cloudflare-builds https://builds.mcp.cloudflare.com/mcp",
            remote("https://builds.mcp.cloudflare.com/mcp"), "streamable_http",
        ),
        card(
            "pmcp-inhouseseo", "InhouseSEO", "data", "line-chart", false, true,
            "Google Search Console analytics and SEO insights for Claude.",
            "claude mcp add --transport http inhouseseo https://app.inhouseseo.ai/api/mcp",
            remote("https://app.inhouseseo.ai/api/mcp"), "streamable_http",
        ),
        card(
            "pmcp-google-analytics", "Google Analytics (GA4)", "data", "bar-chart-3", false, false,
            "Query GA4 reports and metadata via Google's official Analytics MCP server (service-account JSON).",
            "uvx analytics-mcp   (env GOOGLE_APPLICATION_CREDENTIALS = your service-account JSON file)",
            // The credential is a FILE: the emit references ${GOOGLE_APPLICATION_CREDENTIALS},
            // which the launch path sets to the materialized 0600 file's path.
            json!({
                "command": "uvx",
                "args": ["analytics-mcp"],
                "env": { "GOOGLE_APPLICATION_CREDENTIALS": "${GOOGLE_APPLICATION_CREDENTIALS}" }
            }), "stdio",
        ),
    ];
    // Stamp the per-connector auth descriptor + credential schema onto each card
    // from the single Lane taxonomy, so a card stops guessing and starts *reading*
    // its real auth method (§0). Done as a post-pass to keep the 31 rows above one
    // clean call each (the taxonomy lives in `auth_and_creds_for`, not inline).
    for c in cards.iter_mut() {
        if let Some(id) = c.get("id").and_then(Value::as_str).map(str::to_string) {
            let (auth, creds) = auth_and_creds_for(&id);
            if let Value::Object(ref mut o) = c {
                o.insert("auth".into(), auth);
                // Only a Lane B/C card carries a paste field; leave Lane D/E at `[]`.
                if creds.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                    o.insert("credentials".into(), creds);
                }
            }
        }
    }
    cards
}

// ── merge + filter (pure; the handler's core) ─────────────────────────────────

/// A `GET` filter over the merged card grid.
#[derive(Debug, Default, Clone)]
pub struct CardFilter {
    /// `local` | `catalog` | `all` (default `all`).
    pub source: Option<String>,
    /// Case-insensitive substring over id / display_name / description.
    pub q: Option<String>,
    /// A category tag (or `featured`) a card must carry.
    pub category: Option<String>,
    /// Only cards with `featured == true`.
    pub featured_only: bool,
}

fn card_matches(c: &Value, f: &CardFilter) -> bool {
    if let Some(src) = f.source.as_deref() {
        if src != "all" {
            let card_src = c.get("source").and_then(Value::as_str).unwrap_or("local");
            if card_src != src {
                return false;
            }
        }
    }
    if f.featured_only && !c.get("featured").and_then(Value::as_bool).unwrap_or(false) {
        return false;
    }
    if let Some(cat) = f.category.as_deref().map(str::to_ascii_lowercase) {
        if !cat.is_empty() {
            let hit = c
                .get("categories")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .any(|t| t.eq_ignore_ascii_case(&cat))
                })
                .unwrap_or(false)
                || (cat == "featured"
                    && c.get("featured").and_then(Value::as_bool).unwrap_or(false));
            if !hit {
                return false;
            }
        }
    }
    if let Some(q) = f.q.as_deref().map(str::to_ascii_lowercase) {
        if !q.is_empty() {
            let hay = [
                c.get("id").and_then(Value::as_str).unwrap_or(""),
                c.get("display_name").and_then(Value::as_str).unwrap_or(""),
                c.get("description").and_then(Value::as_str).unwrap_or(""),
            ]
            .join("\n")
            .to_ascii_lowercase();
            if !hay.contains(&q) {
                return false;
            }
        }
    }
    true
}

/// Merge local (DB) cards with catalog cards into one grid, de-duplicated by
/// `id` (a local row always wins — an installed connector shadows its catalog
/// preview), then apply `filter`. Featured cards sort to the front. Pure: no
/// network, no DB — this is the unit the handler and the tests both exercise.
pub fn merge_and_filter(local: Vec<Value>, catalog: Vec<Value>, filter: &CardFilter) -> Vec<Value> {
    use std::collections::HashSet;
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<Value> = Vec::with_capacity(local.len() + catalog.len());
    for c in local.into_iter().chain(catalog.into_iter()) {
        let id = c.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        if id.is_empty() || !seen.insert(id) {
            continue;
        }
        if card_matches(&c, filter) {
            out.push(c);
        }
    }
    out.sort_by(|a, b| {
        let fa = a.get("featured").and_then(Value::as_bool).unwrap_or(false);
        let fb = b.get("featured").and_then(Value::as_bool).unwrap_or(false);
        fb.cmp(&fa)
    });
    out
}

// ── in-memory mirror with disk-cached icons ───────────────────────────────────

/// Process-wide catalog cache. `slot` holds the mapped cards plus the time they
/// were stored; entries older than [`TTL`] are refetched on the next read.
pub struct CatalogMirror {
    slot: RwLock<Option<(Vec<Value>, Instant)>>,
}

impl CatalogMirror {
    pub fn new() -> Self {
        Self { slot: RwLock::new(None) }
    }

    /// The catalog cards to show right now WITHOUT touching the network:
    /// the curated featured set merged with whatever the last refresh cached.
    /// Always non-empty. Used by the default `/api/connectors` list so it never
    /// blocks on an upstream call.
    pub async fn cached_cards(&self) -> Vec<Value> {
        let mirrored = self
            .slot
            .read()
            .await
            .as_ref()
            .map(|(v, _)| v.clone())
            .unwrap_or_default();
        merge_featured(mirrored)
    }

    /// True when the cache is empty or older than the TTL (a refresh is due).
    pub async fn is_stale(&self) -> bool {
        match self.slot.read().await.as_ref() {
            Some((_, t)) => t.elapsed() >= TTL,
            None => true,
        }
    }

    /// Fresh cards if the cache is warm; otherwise fetch, cache, and return.
    /// On any fetch failure returns the curated + last-good set (never errors
    /// out to the caller — a discovery grid must degrade, not break).
    pub async fn cards(&self, data_dir: &Path) -> Vec<Value> {
        if !self.is_stale().await {
            return self.cached_cards().await;
        }
        match self.refresh(data_dir).await {
            Ok(cards) => cards,
            Err(_) => self.cached_cards().await,
        }
    }

    /// Force a network fetch, mirror icons, cache the mapped cards, and return
    /// the merged (curated ∪ live) grid.
    pub async fn refresh(&self, data_dir: &Path) -> Result<Vec<Value>, String> {
        let page = fetch_page().await?;
        let mut cards = map_page(&page);
        mirror_icons(&page, &mut cards, data_dir).await;
        // Enrichment-only mirror: keep a fetched row only when its id is one of
        // the curated catalog's. This RETIRES the raw unranked page-0 dump (the
        // source of the "nonsense descriptions" — obscure alphabetical servers
        // with PulseMCP `short_description` junk) while still letting a live row
        // for a curated id win in `merge_featured` (richer stars/registry). Done
        // AFTER `mirror_icons`, which zips `page.servers` with `cards` by index.
        cards.retain(|c| c.get("id").and_then(Value::as_str).map(is_curated).unwrap_or(false));
        {
            let mut w = self.slot.write().await;
            *w = Some((cards.clone(), Instant::now()));
        }
        Ok(merge_featured(cards))
    }

    /// Seed the cache directly (tests only — no network).
    #[cfg(test)]
    pub async fn seed(&self, cards: Vec<Value>) {
        let mut w = self.slot.write().await;
        *w = Some((cards, Instant::now()));
    }
}

impl Default for CatalogMirror {
    fn default() -> Self {
        Self::new()
    }
}

/// The single process-wide mirror. A `OnceLock` (not `AppState`) so the store
/// works without threading a new field through every test constructor.
pub fn mirror() -> &'static CatalogMirror {
    static MIRROR: std::sync::OnceLock<CatalogMirror> = std::sync::OnceLock::new();
    MIRROR.get_or_init(CatalogMirror::new)
}

/// Merge the curated featured cards with a live/mirrored set, deduped by id with
/// the live row winning (it carries stars/registry/etc. the static card lacks).
///
/// A live row that SHADOWS a curated id inherits the curated card's authoritative
/// fields the mirror can't know — the `auth` descriptor above all, plus the curated
/// `lucide` glyph / `install` line / `official` badge / paste `credentials`. Without
/// this a live GitHub row (mirror `auth: none`, `lucide: null`) would erase the
/// carefully-classified Lane, re-opening the "every card is a generic dialog" bug.
fn merge_featured(mirrored: Vec<Value>) -> Vec<Value> {
    use std::collections::HashMap;
    use std::collections::HashSet;
    // The curated set in its fixed order (drives the deterministic push order below).
    let curated: Vec<Value> = featured_cards();
    let by_id: HashMap<String, usize> = curated
        .iter()
        .enumerate()
        .filter_map(|(i, c)| c.get("id").and_then(Value::as_str).map(|id| (id.to_string(), i)))
        .collect();
    let live_ids: HashSet<String> = mirrored
        .iter()
        .filter_map(|c| c.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    let mut out = mirrored;
    for c in out.iter_mut() {
        let Some(id) = c.get("id").and_then(Value::as_str).map(str::to_string) else {
            continue;
        };
        if let Some(&i) = by_id.get(&id) {
            enrich_from_curated(c, &curated[i]);
        }
    }
    // Push the curated cards the live set doesn't cover, in curated (fixed) order.
    for f in curated {
        let id = f.get("id").and_then(Value::as_str).unwrap_or("");
        if !live_ids.contains(id) {
            out.push(f);
        }
    }
    out.sort_by(|a, b| {
        let fa = a.get("featured").and_then(Value::as_bool).unwrap_or(false);
        let fb = b.get("featured").and_then(Value::as_bool).unwrap_or(false);
        fb.cmp(&fa)
    });
    out
}

/// Fold a curated card's authoritative fields onto a live mirrored row that shares
/// its id. `auth` is always taken (the Lane is classified, not guessed); the visual
/// + paste fields are taken only when the live row lacks a real value.
fn enrich_from_curated(live: &mut Value, curated: &Value) {
    let Value::Object(o) = live else { return };
    // The Lane descriptor is authoritative — always adopt the curated one.
    if let Some(auth) = curated.get("auth") {
        o.insert("auth".into(), auth.clone());
    }
    // A curated lucide glyph fills in for the mirror's null.
    if o.get("lucide").and_then(Value::as_str).unwrap_or("").is_empty() {
        if let Some(l) = curated.get("lucide") {
            o.insert("lucide".into(), l.clone());
        }
    }
    // The exact install/connect one-liner (the mirror carries none).
    if o.get("install").and_then(Value::as_str).unwrap_or("").is_empty() {
        if let Some(v) = curated.get("install") {
            o.insert("install".into(), v.clone());
        }
    }
    // The Official badge (a live row defaults to false).
    if !o.get("official").and_then(Value::as_bool).unwrap_or(false) {
        if let Some(v) = curated.get("official") {
            o.insert("official".into(), v.clone());
        }
    }
    // The Lane B/C paste field, so an api_key/form card still shows its input.
    let live_has_creds = o
        .get("credentials")
        .and_then(Value::as_array)
        .map(|a| !a.is_empty())
        .unwrap_or(false);
    if !live_has_creds {
        if let Some(creds) = curated.get("credentials").filter(|c| {
            c.as_array().map(|a| !a.is_empty()).unwrap_or(false)
        }) {
            o.insert("credentials".into(), creds.clone());
        }
    }
}

/// Where a mirrored icon lives on disk.
fn icon_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("catalog").join("icons")
}

/// Absolute path of a cached icon file for a card id (validated id → safe leaf).
pub fn icon_path(data_dir: &Path, id: &str) -> Option<PathBuf> {
    if !super::manifest::valid_connector_id(id) {
        return None;
    }
    Some(icon_dir(data_dir).join(id))
}

/// One GET for a page of the catalog.
async fn fetch_page() -> Result<ServersPage, String> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(PULSEMCP_URL)
        .query(&[("count_per_page", COUNT_PER_PAGE.to_string())])
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("pulsemcp responded {}", resp.status().as_u16()));
    }
    resp.json::<ServersPage>().await.map_err(|e| e.to_string())
}

/// Mirror each server's advertised icon to disk (best-effort) and rewrite the
/// matching card's `icon` to our local route. Never hotlinks: a card's `icon`
/// only ever points at PulseMCP if the mirror step below leaves it — which it
/// does not, it clears to "" on failure. Bounded + sequential: at most one page
/// of small images, on a 6-hour cadence.
async fn mirror_icons(page: &ServersPage, cards: &mut [Value], data_dir: &Path) {
    let dir = icon_dir(data_dir);
    let client = match reqwest::Client::builder()
        .timeout(ICON_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
    {
        Ok(c) => c,
        Err(_) => {
            // No client: make sure no card is left pointing at an upstream URL.
            for c in cards.iter_mut() {
                c["icon"] = Value::String(String::new());
            }
            return;
        }
    };
    for (s, card) in page.servers.iter().zip(cards.iter_mut()) {
        let id = match card.get("id").and_then(Value::as_str) {
            Some(i) => i.to_string(),
            None => continue,
        };
        let src = s.icons.first().map(|i| i.src.clone()).unwrap_or_default();
        let mut resolved = String::new();
        if src.starts_with("http://") || src.starts_with("https://") {
            if let Some(path) = icon_path(data_dir, &id) {
                if path.exists() {
                    resolved = format!("/api/connectors/catalog/icon/{id}");
                } else if tokio::fs::create_dir_all(&dir).await.is_ok() {
                    if let Ok(resp) = client.get(&src).send().await {
                        if resp.status().is_success() {
                            if let Ok(bytes) = resp.bytes().await {
                                if !bytes.is_empty()
                                    && tokio::fs::write(&path, &bytes).await.is_ok()
                                {
                                    resolved = format!("/api/connectors/catalog/icon/{id}");
                                }
                            }
                        }
                    }
                }
            }
        }
        // Whatever happened, never leave a hotlink in the card.
        card["icon"] = Value::String(resolved);
    }
}

/// Slugify a free-form name/segment into a connector-id-safe slug (lowercase
/// alnum with single `-` separators). Mirrors the manifest slug rules.
fn slugify(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut prev_dash = false;
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if matches!(c, '_' | '.' | '-') || c.is_whitespace() {
            if !prev_dash && !out.is_empty() {
                out.push('-');
                prev_dash = true;
            }
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out.truncate(90);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_page() -> ServersPage {
        let raw = json!({
            "servers": [
                {
                    "name": "Medium Ops",
                    "url": "https://www.pulsemcp.com/servers/06ketan-medium-ops",
                    "external_url": "https://github.com/06ketan/medium-ops",
                    "short_description": "Medium content management with 22 tools for browsing posts.",
                    "source_code_url": "https://github.com/06ketan/medium-ops",
                    "github_stars": 7,
                    "package_registry": "npm",
                    "package_name": "medium-ops-mcp",
                    "package_download_count": 1234,
                    "remotes": []
                },
                {
                    "name": "x711",
                    "url": "https://www.pulsemcp.com/servers/0580iris-lang-x711",
                    "external_url": "https://x711.io",
                    "short_description": "Pay-per-use tool API for AI agents.",
                    "source_code_url": null,
                    "github_stars": null,
                    "package_registry": null,
                    "package_name": null,
                    "remotes": [
                        { "url_direct": "https://x711.io/mcp", "transport": "streamable_http", "authentication_method": "api_key", "cost": "free_tier" }
                    ]
                }
            ],
            "total_count": 22037,
            "next": "https://api.pulsemcp.com/v0beta/servers?count_per_page=2&offset=2"
        });
        serde_json::from_value(raw).unwrap()
    }

    #[test]
    fn maps_pulsemcp_page_to_cards() {
        let page = sample_page();
        assert_eq!(page.total_count, Some(22037));
        let cards = map_page(&page);
        assert_eq!(cards.len(), 2);

        // Packaged server → npx emit, id from the PulseMCP slug, stars + count.
        let medium = &cards[0];
        assert_eq!(medium["id"], json!("pmcp-06ketan-medium-ops"));
        assert_eq!(medium["display_name"], json!("Medium Ops"));
        assert_eq!(medium["source"], json!("catalog"));
        assert_eq!(medium["emit"]["command"], json!("npx"));
        assert_eq!(medium["emit"]["args"][1], json!("medium-ops-mcp"));
        assert_eq!(medium["stars"], json!(7));
        assert_eq!(medium["tool_count"], json!(22), "‘22 tools’ parsed from blurb");
        // Icons are never hotlinked out of the pure mapper (none advertised here).
        assert_eq!(medium["icon"], json!(""));

        // Hosted server → url emit + transport carried through.
        let x711 = &cards[1];
        assert_eq!(x711["id"], json!("pmcp-0580iris-lang-x711"));
        assert_eq!(x711["emit"]["url"], json!("https://x711.io/mcp"));
        assert_eq!(x711["transport"], json!("streamable_http"));
        // `auth` is now a DESCRIPTOR object, mapped from the PulseMCP method hint.
        assert_eq!(x711["auth"]["kind"], json!("api_key"));
        assert!(x711["categories"]
            .as_array()
            .unwrap()
            .contains(&json!("hosted")));
    }

    #[test]
    fn curated_catalog_is_present_without_network() {
        let cards = merge_featured(vec![]);
        // The full curated catalog renders with zero network.
        assert_eq!(cards.len(), CURATED_IDS.len(), "all 43 curated cards present");
        // The 13 featured ids sort to the front and are flagged featured.
        let featured: Vec<&str> = cards
            .iter()
            .filter(|c| c["featured"] == json!(true))
            .filter_map(|c| c["id"].as_str())
            .collect();
        assert_eq!(featured.len(), FEATURED_IDS.len(), "13 featured cards");
        assert!(cards.iter().any(|c| c["id"] == json!("pmcp-github")));
        // The 7 first-party Anthropic/MCP reference servers wear the Official badge.
        let official: Vec<&str> = cards
            .iter()
            .filter(|c| c["official"] == json!(true))
            .filter_map(|c| c["id"].as_str())
            .collect();
        assert_eq!(official.len(), 7, "7 official reference servers");
        for id in [
            "pmcp-filesystem",
            "pmcp-fetch",
            "pmcp-git",
            "pmcp-memory",
            "pmcp-sequential-thinking",
            "pmcp-time",
            "pmcp-everything",
        ] {
            assert!(official.contains(&id), "{id} is official");
        }
        // Every curated card carries a real description + a lucide glyph name.
        assert!(cards.iter().all(|c| !c["description"].as_str().unwrap_or("").is_empty()));
        assert!(cards.iter().all(|c| !c["lucide"].as_str().unwrap_or("").is_empty()));
    }

    #[test]
    fn live_row_shadows_curated_featured() {
        // A live GitHub row must win over the static curated card (dedupe by id).
        let live = json!({
            "id": "pmcp-github", "display_name": "GitHub", "source": "catalog",
            "featured": true, "stars": 999, "categories": ["featured"], "description": ""
        });
        let merged = merge_featured(vec![live]);
        let gh: Vec<_> = merged.iter().filter(|c| c["id"] == json!("pmcp-github")).collect();
        assert_eq!(gh.len(), 1, "no duplicate github card");
        assert_eq!(gh[0]["stars"], json!(999), "live row won");
        // …but it INHERITS the curated auth descriptor + paste field the mirror
        // can't know — so GitHub stays Lane B (api_key), never the mirror's guess.
        assert_eq!(gh[0]["auth"]["kind"], json!("api_key"), "curated Lane preserved");
        assert_eq!(gh[0]["lucide"], json!("github"), "curated glyph filled in");
        assert!(
            gh[0]["credentials"].as_array().map(|a| !a.is_empty()).unwrap_or(false),
            "curated paste field preserved"
        );
    }

    #[test]
    fn curated_cards_carry_the_right_auth_lane() {
        let cards = merge_featured(vec![]);
        let kind = |id: &str| -> String {
            cards
                .iter()
                .find(|c| c["id"] == json!(id))
                .and_then(|c| c["auth"]["kind"].as_str())
                .unwrap_or("<missing>")
                .to_string()
        };
        // Lane E — no sign-in.
        assert_eq!(kind("pmcp-filesystem"), "none");
        assert_eq!(kind("pmcp-figma"), "none");
        // Lane B — a genuine key/token to paste, WITH a "Get your key" link.
        assert_eq!(kind("pmcp-github"), "api_key");
        assert_eq!(kind("pmcp-stripe"), "api_key");
        let gh = cards.iter().find(|c| c["id"] == json!("pmcp-github")).unwrap();
        assert!(gh["auth"]["help_url"].as_str().unwrap().contains("github.com"));
        assert_eq!(gh["credentials"][0]["sensitive"], json!(true));
        // Lane C — a structured DSN.
        assert_eq!(kind("pmcp-postgres"), "form");
        // Lane D — a hosted remote MCP that runs its OWN OAuth (no fake key field).
        assert_eq!(kind("pmcp-slack"), "mcp_oauth");
        assert_eq!(kind("pmcp-notion"), "mcp_oauth");
        let slack = cards.iter().find(|c| c["id"] == json!("pmcp-slack")).unwrap();
        assert_eq!(
            slack["credentials"].as_array().map(Vec::len).unwrap_or(0),
            0,
            "an mcp_oauth card carries NO credential paste field (no fake API key)"
        );
        assert!(slack["auth"]["help_text"].as_str().unwrap().contains("terminal"));
        // Every curated id resolves an auth descriptor (no card left guessing).
        assert!(cards.iter().all(|c| c["auth"]["kind"].is_string()));
    }

    #[test]
    fn expansion_cards_carry_honest_lanes() {
        let cards = merge_featured(vec![]);
        let get = |id: &str| cards.iter().find(|c| c["id"] == json!(id)).unwrap().clone();

        // The four OFFICIAL hosted remotes are mcp_oauth: a `{ url }` emit, NO paste
        // field, and the honest "signs in in the terminal" note.
        for (id, url) in [
            ("pmcp-vercel", "https://mcp.vercel.com"),
            ("pmcp-box", "https://mcp.box.com"),
            ("pmcp-monday", "https://mcp.monday.com/mcp"),
            ("pmcp-clickup", "https://mcp.clickup.com/mcp"),
        ] {
            let c = get(id);
            assert_eq!(c["auth"]["kind"], json!("mcp_oauth"), "{id} is mcp_oauth");
            assert_eq!(c["emit"]["url"], json!(url), "{id} emits its hosted remote");
            assert_eq!(
                c["credentials"].as_array().map(Vec::len).unwrap_or(0),
                0,
                "{id} carries no fake key field"
            );
            assert!(c["auth"]["help_text"].as_str().unwrap().contains("terminal"));
        }

        // Discord + Brave are api_key: a real "get your key" link + a sensitive paste
        // field (no invented hosted-remote URL).
        for (id, host) in [
            ("pmcp-discord", "discord.com"),
            ("pmcp-brave-search", "brave.com"),
        ] {
            let c = get(id);
            assert_eq!(c["auth"]["kind"], json!("api_key"), "{id} is api_key");
            assert!(
                c["auth"]["help_url"].as_str().unwrap().contains(host),
                "{id} links its real key page"
            );
            assert_eq!(c["credentials"][0]["sensitive"], json!(true), "{id} secret is sealed");
        }
    }

    #[test]
    fn marketing_seo_expansion_cards_carry_honest_lanes() {
        let cards = merge_featured(vec![]);
        let get = |id: &str| cards.iter().find(|c| c["id"] == json!(id)).unwrap().clone();

        // api_key cards: real "get your key" link + a sensitive paste field carrying
        // the intended secret env, and an npx stdio emit (no invented hosted remote).
        for (id, host, env) in [
            ("pmcp-ahrefs", "ahrefs.com", "API_KEY"),
            ("pmcp-openai-image", "openai.com", "OPENAI_API_KEY"),
        ] {
            let c = get(id);
            assert_eq!(c["auth"]["kind"], json!("api_key"), "{id} is api_key");
            assert!(c["auth"]["help_url"].as_str().unwrap().contains(host), "{id} links its key page");
            assert_eq!(c["credentials"][0]["key"], json!(env), "{id} carries its secret env");
            assert_eq!(c["credentials"][0]["sensitive"], json!(true), "{id} secret is sealed");
            assert_eq!(c["emit"]["command"], json!("npx"), "{id} launches via npx");
        }

        // DataForSEO — Lane C form: a NON-secret login + a SENSITIVE API password.
        let dfs = get("pmcp-dataforseo");
        assert_eq!(dfs["auth"]["kind"], json!("form"), "dataforseo is a form");
        assert!(dfs["auth"]["help_url"].as_str().unwrap().contains("dataforseo.com"));
        let creds = dfs["credentials"].as_array().unwrap();
        assert_eq!(creds.len(), 2, "dataforseo carries two fields");
        assert_eq!(creds[0]["key"], json!("DATAFORSEO_USERNAME"));
        assert_eq!(creds[0]["sensitive"], json!(false), "the login is not a secret");
        assert_eq!(creds[1]["key"], json!("DATAFORSEO_PASSWORD"));
        assert_eq!(creds[1]["sensitive"], json!(true), "the password is sealed");
        assert_eq!(dfs["emit"]["command"], json!("npx"), "dataforseo launches via npx");

        // Two hosted remotes are mcp_oauth: a `{ url }` emit, NO fake key field.
        for (id, url) in [
            ("pmcp-cloudflare-builds", "https://builds.mcp.cloudflare.com/mcp"),
            ("pmcp-inhouseseo", "https://app.inhouseseo.ai/api/mcp"),
        ] {
            let c = get(id);
            assert_eq!(c["auth"]["kind"], json!("mcp_oauth"), "{id} is mcp_oauth");
            assert_eq!(c["emit"]["url"], json!(url), "{id} emits its hosted remote");
            assert_eq!(
                c["credentials"].as_array().map(Vec::len).unwrap_or(0),
                0,
                "{id} carries no fake key field"
            );
            assert!(c["auth"]["help_text"].as_str().unwrap().contains("terminal"));
        }
    }

    #[test]
    fn google_analytics_is_a_file_credential_form_lane() {
        let cards = merge_featured(vec![]);
        let ga = cards
            .iter()
            .find(|c| c["id"] == json!("pmcp-google-analytics"))
            .expect("GA4 card present");

        // Lane C form, with the Google Cloud service-account console as the help link.
        assert_eq!(ga["auth"]["kind"], json!("form"), "GA4 is a form lane");
        assert!(
            ga["auth"]["help_url"].as_str().unwrap().contains("console.cloud.google.com"),
            "links the service-account console"
        );

        // The official server launched via `uvx analytics-mcp`, its emit referencing
        // the FILE-path env var (resolved to the materialized 0600 file at launch).
        assert_eq!(ga["emit"]["command"], json!("uvx"));
        assert_eq!(ga["emit"]["args"][0], json!("analytics-mcp"));
        assert_eq!(
            ga["emit"]["env"]["GOOGLE_APPLICATION_CREDENTIALS"],
            json!("${GOOGLE_APPLICATION_CREDENTIALS}"),
            "emit references the file-path env var"
        );

        // ONE sensitive FILE credential: the JSON blob, flagged to materialize to a
        // file and point GOOGLE_APPLICATION_CREDENTIALS at it.
        let creds = ga["credentials"].as_array().unwrap();
        assert_eq!(creds.len(), 1, "a single service-account JSON field");
        assert_eq!(creds[0]["key"], json!("GA_SERVICE_ACCOUNT_JSON"));
        assert_eq!(creds[0]["sensitive"], json!(true), "the JSON key is sealed");
        assert_eq!(
            creds[0]["file_env"],
            json!("GOOGLE_APPLICATION_CREDENTIALS"),
            "the field materializes to a file and sets this env to its path"
        );
    }

    #[test]
    fn curated_auth_is_none_for_a_non_catalog_id() {
        // A locally-authored connector (not in the curated set) has no curated auth
        // — the card layer then derives its lane from its own credential schema.
        assert!(curated_auth("icloud-mail").is_none());
        assert_eq!(curated_auth("pmcp-slack").unwrap()["kind"], json!("mcp_oauth"));
    }

    #[test]
    fn curated_categories_come_from_the_curated_card() {
        // An installed catalog card inherits its store category (Playwright → the
        // Browser tab). A non-curated local id has none (it declares its own).
        assert!(curated_categories("pmcp-playwright").unwrap().iter().any(|c| c == "browser"));
        assert!(curated_categories("icloud-mail").is_none());
    }

    #[test]
    fn merge_lists_catalog_and_local_together() {
        // A locally-created connector + the catalog, both surfaced by the grid.
        let local = vec![json!({
            "id": "icloud-mail", "display_name": "iCloud Mail", "source": "local",
            "description": "IMAP for iCloud", "categories": [], "featured": false
        })];
        let catalog = map_page(&sample_page());
        let all = merge_and_filter(local, catalog, &CardFilter::default());
        let ids: Vec<&str> = all.iter().filter_map(|c| c["id"].as_str()).collect();
        assert!(ids.contains(&"icloud-mail"), "local connector listed");
        assert!(ids.contains(&"pmcp-06ketan-medium-ops"), "catalog connector listed");
    }

    #[test]
    fn source_filter_splits_local_and_catalog() {
        let local = vec![json!({ "id": "icloud-mail", "source": "local", "display_name": "iCloud Mail", "description": "", "categories": [] })];
        let catalog = map_page(&sample_page());
        let only_local = merge_and_filter(
            local.clone(),
            catalog.clone(),
            &CardFilter { source: Some("local".into()), ..Default::default() },
        );
        assert_eq!(only_local.len(), 1);
        assert_eq!(only_local[0]["id"], json!("icloud-mail"));

        let only_catalog = merge_and_filter(
            local,
            catalog,
            &CardFilter { source: Some("catalog".into()), ..Default::default() },
        );
        assert!(only_catalog.iter().all(|c| c["source"] == json!("catalog")));
        assert_eq!(only_catalog.len(), 2);
    }

    #[test]
    fn search_and_category_filters() {
        let catalog = map_page(&sample_page());
        let q = merge_and_filter(
            vec![],
            catalog.clone(),
            &CardFilter { q: Some("medium".into()), ..Default::default() },
        );
        assert_eq!(q.len(), 1);
        assert_eq!(q[0]["id"], json!("pmcp-06ketan-medium-ops"));

        let hosted = merge_and_filter(
            vec![],
            catalog,
            &CardFilter { category: Some("hosted".into()), ..Default::default() },
        );
        assert_eq!(hosted.len(), 1);
        assert_eq!(hosted[0]["id"], json!("pmcp-0580iris-lang-x711"));
    }

    #[test]
    fn id_prefers_pulsemcp_slug_and_is_valid() {
        let s: PulseServer = serde_json::from_value(json!({
            "name": "Weird Name!!",
            "url": "https://www.pulsemcp.com/servers/acme-cool.tool"
        }))
        .unwrap();
        let id = catalog_id(&s).unwrap();
        assert_eq!(id, "pmcp-acme-cool-tool");
        assert!(super::super::manifest::valid_connector_id(&id));
    }
}
