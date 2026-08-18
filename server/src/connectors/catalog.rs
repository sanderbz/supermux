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
        "auth": s.remotes.iter().find_map(|r| r.authentication_method.clone()),
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

// ── curated FEATURED set ──────────────────────────────────────────────────────

/// Ids we always surface first, even before (or without) a network fetch. Kept
/// small and hand-picked: the connectors people reach for on day one.
const FEATURED_IDS: &[&str] = &[
    "pmcp-github",
    "pmcp-notion",
    "pmcp-slack",
    "pmcp-linear",
    "pmcp-sentry",
    "pmcp-filesystem",
    "pmcp-postgres",
    "pmcp-playwright",
];

/// Is a mirrored card part of the curated featured set?
pub fn is_featured(id: &str) -> bool {
    FEATURED_IDS.contains(&id)
}

/// The always-present curated cards. These render instantly with zero network
/// (the store is never empty), and are merged/deduped with the live mirror when
/// it warms — a live PulseMCP row for the same id wins (richer metadata).
pub fn featured_cards() -> Vec<Value> {
    fn card(
        id: &str,
        name: &str,
        desc: &str,
        emit: Value,
        homepage: &str,
        cats: &[&str],
    ) -> Value {
        let mut categories: Vec<String> = vec!["featured".into()];
        categories.extend(cats.iter().map(|c| c.to_string()));
        json!({
            "id": id,
            "kind": super::manifest::KIND_MCP_CATALOG,
            "display_name": name,
            "icon": "",
            "description": desc,
            "tools": [],
            "tool_count": Value::Null,
            "credentials": [],
            "emit": emit,
            "source": SOURCE_CATALOG,
            "featured": true,
            "stars": Value::Null,
            "downloads": Value::Null,
            "homepage_url": homepage,
            "source_url": Value::Null,
            "pulsemcp_url": Value::Null,
            "registry": "npm",
            "package_name": Value::Null,
            "transport": "stdio",
            "auth": Value::Null,
            "categories": categories,
            "created_at": 0,
        })
    }
    vec![
        card(
            "pmcp-github",
            "GitHub",
            "Repos, issues, and pull requests — read and act on your GitHub from an agent.",
            json!({ "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }),
            "https://github.com/modelcontextprotocol/servers",
            &["devtools", "hosted"],
        ),
        card(
            "pmcp-notion",
            "Notion",
            "Search, read, and update Notion pages and databases.",
            json!({ "command": "npx", "args": ["-y", "@notionhq/notion-mcp-server"] }),
            "https://github.com/makenotion/notion-mcp-server",
            &["productivity"],
        ),
        card(
            "pmcp-slack",
            "Slack",
            "Post messages and read channels in your Slack workspace.",
            json!({ "command": "npx", "args": ["-y", "@modelcontextprotocol/server-slack"] }),
            "https://github.com/modelcontextprotocol/servers",
            &["communication"],
        ),
        card(
            "pmcp-linear",
            "Linear",
            "Triage and update Linear issues, projects, and cycles.",
            json!({ "command": "npx", "args": ["-y", "mcp-linear"] }),
            "https://linear.app",
            &["devtools", "productivity"],
        ),
        card(
            "pmcp-sentry",
            "Sentry",
            "Inspect Sentry issues and error events for your projects.",
            json!({ "command": "npx", "args": ["-y", "@sentry/mcp-server"] }),
            "https://github.com/getsentry/sentry-mcp",
            &["devtools", "observability"],
        ),
        card(
            "pmcp-filesystem",
            "Filesystem",
            "Read and write files under a sandboxed local directory.",
            json!({ "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"] }),
            "https://github.com/modelcontextprotocol/servers",
            &["local"],
        ),
        card(
            "pmcp-postgres",
            "Postgres",
            "Run read-only SQL and inspect schemas on a Postgres database.",
            json!({ "command": "npx", "args": ["-y", "@modelcontextprotocol/server-postgres"] }),
            "https://github.com/modelcontextprotocol/servers",
            &["database"],
        ),
        card(
            "pmcp-playwright",
            "Playwright",
            "Drive a real browser — navigate, click, and extract pages.",
            json!({ "command": "npx", "args": ["-y", "@playwright/mcp"] }),
            "https://github.com/microsoft/playwright-mcp",
            &["browser", "devtools"],
        ),
    ]
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
fn merge_featured(mirrored: Vec<Value>) -> Vec<Value> {
    use std::collections::HashSet;
    let live_ids: HashSet<String> = mirrored
        .iter()
        .filter_map(|c| c.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    let mut out = mirrored;
    for f in featured_cards() {
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
        assert_eq!(x711["auth"], json!("api_key"));
        assert!(x711["categories"]
            .as_array()
            .unwrap()
            .contains(&json!("hosted")));
    }

    #[test]
    fn featured_set_is_present_without_network() {
        let cards = merge_featured(vec![]);
        assert!(cards.len() >= 8);
        assert!(cards.iter().all(|c| c["featured"] == json!(true)));
        assert!(cards.iter().any(|c| c["id"] == json!("pmcp-github")));
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
