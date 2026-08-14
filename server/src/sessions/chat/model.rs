//! Typed chat entries + the SEALED wire type.
//!
//! `WireEntry` is the only thing the WS/SSE layers may serialize, and its
//! single constructor applies the per-entry cap. An uncapped entry therefore
//! cannot reach the wire without editing this file (a0-findings §2: real
//! transcript lines reach 950 KB — a 482 KB base64 image and a 104 KB
//! `tool_result` are in the fixture corpus).
//!
//! The cap is a *type*, not a discipline: `WireEntry`'s fields live in a
//! private `sealed` module, so no other module can build one field-by-field.
//! Every path that reaches a client — live `entry` frames, seed pages, the
//! history REST page, `chat_tail` — goes through [`WireEntry::seal`].

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Per-entry wire cap. Chosen to match the hook pipe's own 16 KB `head -c`
/// truncation so both live layers clip at the same size.
pub const MAX_ENTRY_BYTES: usize = 16 * 1024;
/// A single JSONL line larger than this is never parsed into content — the
/// entry becomes an `oversize` placeholder (fetch-full can still stream it).
pub const MAX_LINE_BYTES: usize = 1024 * 1024;
/// Seed page byte budget (see Task 4).
pub const SEED_MAX_BYTES: usize = 512 * 1024;
/// Cap on a label (tool name, subtype, attachment kind) — labels are UI chrome,
/// never payload.
pub const LABEL_MAX_CHARS: usize = 200;

/// What a parsed line *is*, from the renderer's point of view.
///
/// `Unknown` is load-bearing: the corpus contains top-level types the master
/// plan never listed (`agent-name`, `agent-setting`, `bridge-session`,
/// `ai-title`) and Claude Code adds more between patch releases. An unmodelled
/// shape is kept, never dropped and never a parse failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Prompt,
    Assistant,
    Thinking,
    ToolUse,
    ToolResult,
    Queue,
    Mode,
    CompactBoundary,
    System,
    Attachment,
    Subagent,
    Unknown,
}

/// One renderable transcript entry, pre-cap and internal to the server.
#[derive(Debug, Clone)]
pub struct ChatEntry {
    /// `<line uuid>` for the first block of a line, `<line uuid>#<i>` for the
    /// rest. Lines that carry no uuid at all (`custom-title`, `mode`, …) get a
    /// synthetic `@<offset>` so every entry is addressable by fetch-full.
    pub uuid: String,
    pub kind: Kind,
    /// Claude Code's own clock (the entry `timestamp`), in ms. **Not** arrival
    /// time — A0 measured the two up to 27 s apart, so this must never be used
    /// for liveness, cross-source ordering, or the supersede window.
    pub ts_ms: i64,
    /// Byte offset of the LINE START in its file. Every block of a multi-block
    /// line shares it, so the cursor can never rewind into the middle of a line.
    pub offset: u64,
    pub session_id: Option<String>,
    pub tool_use_id: Option<String>,
    /// Tool name / system subtype / attachment kind — short UI chrome.
    pub label: Option<String>,
    /// `Some(false)` only for a `tool_result` that carries `is_error: true`.
    pub ok: Option<bool>,
    /// True for entries that belong to a subagent transcript. The main file's
    /// sidechain lines are filtered by the tailer (they are re-read, with their
    /// `agent_id`, from `subagents/agent-*.jsonl`).
    pub is_sidechain: bool,
    pub agent_id: Option<String>,
    /// The source line exceeded [`MAX_LINE_BYTES`]; `body` is a placeholder.
    pub oversize: bool,
    /// Kind-specific payload, pre-cap.
    pub body: Value,
}

impl ChatEntry {
    /// Minimal text entry — test scaffolding for the store/ws suites too.
    #[cfg(test)]
    pub fn test_text(uuid: &str, text: &str) -> Self {
        Self {
            uuid: uuid.to_string(),
            kind: Kind::Assistant,
            ts_ms: 0,
            offset: 0,
            session_id: None,
            tool_use_id: None,
            label: None,
            ok: None,
            is_sidechain: false,
            agent_id: None,
            oversize: false,
            body: serde_json::json!({ "text": text }),
        }
    }
}

/// `agent-<id>.meta.json` next to a subagent transcript.
///
/// `model` is **optional**: absent on 2.1.231, present on some 2.1.221 metas
/// (A0). `spawnDepth` is likewise treated as optional so an older/newer shape
/// cannot make the file unreadable.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SubagentMeta {
    #[serde(alias = "agentType")]
    pub agent_type: String,
    #[serde(default)]
    pub description: String,
    #[serde(alias = "toolUseId", alias = "toolUseID")]
    pub tool_use_id: String,
    #[serde(default, alias = "spawnDepth")]
    pub spawn_depth: Option<i64>,
    #[serde(default)]
    pub model: Option<String>,
}

mod sealed {
    //! Private field carrier: `WireEntry`'s fields live here so no other module
    //! can construct one field-by-field.
    use serde_json::Value;

    #[derive(Debug, Clone, serde::Serialize)]
    pub struct Inner {
        pub(super) seq: u64,
        pub(super) uuid: String,
        pub(super) kind: super::Kind,
        pub(super) ts_ms: i64,
        pub(super) offset: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub(super) session_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub(super) tool_use_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub(super) label: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub(super) ok: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub(super) agent_id: Option<String>,
        pub(super) oversize: bool,
        pub(super) truncated: bool,
        pub(super) body: Value,
    }
}

/// A capped, serializable entry. **The only** type the WS/SSE layers may put
/// on the wire.
#[derive(Debug, Clone, Serialize)]
#[serde(transparent)]
pub struct WireEntry(sealed::Inner);

impl WireEntry {
    /// THE constructor. Applies [`MAX_ENTRY_BYTES`] and stamps `truncated`.
    ///
    /// The budget is derived from the *actual* serialized header (uuid, ids,
    /// label…), not a guess, and the result is re-measured: string escaping can
    /// double a payload's serialized size (`"` → `\"`), so a single estimating
    /// pass is not enough. If even a halved budget cannot fit, the body is
    /// dropped entirely — the entry still reaches the client with its uuid, and
    /// fetch-full can resolve the rest.
    pub fn seal(seq: u64, e: &ChatEntry) -> Self {
        let mut inner = sealed::Inner {
            seq,
            uuid: e.uuid.clone(),
            kind: e.kind,
            ts_ms: e.ts_ms,
            offset: e.offset,
            session_id: e.session_id.clone(),
            tool_use_id: e.tool_use_id.clone(),
            label: e.label.as_deref().map(|l| clip_chars(l, LABEL_MAX_CHARS)),
            ok: e.ok,
            agent_id: e.agent_id.clone(),
            oversize: e.oversize,
            truncated: false,
            body: Value::Null,
        };
        let header = serde_json::to_vec(&inner).map(|v| v.len()).unwrap_or(0);
        let mut budget = MAX_ENTRY_BYTES.saturating_sub(header + 16);
        for _ in 0..6 {
            let mut left = budget;
            let mut truncated = false;
            inner.body = clip_value(&e.body, &mut left, &mut truncated);
            inner.truncated = truncated;
            let len = serde_json::to_vec(&inner)
                .map(|v| v.len())
                .unwrap_or(usize::MAX);
            if len <= MAX_ENTRY_BYTES {
                return Self(inner);
            }
            budget /= 2;
        }
        inner.body = Value::Null;
        inner.truncated = true;
        Self(inner)
    }

    pub fn seq(&self) -> u64 {
        self.0.seq
    }
    pub fn uuid(&self) -> &str {
        &self.0.uuid
    }
    pub fn kind(&self) -> Kind {
        self.0.kind
    }
    pub fn ts_ms(&self) -> i64 {
        self.0.ts_ms
    }
    pub fn offset(&self) -> u64 {
        self.0.offset
    }
    pub fn truncated(&self) -> bool {
        self.0.truncated
    }
    pub fn body(&self) -> &Value {
        &self.0.body
    }
}

/// Truncate to at most `max` **chars** (never mid-codepoint).
fn clip_chars(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => s[..i].to_string(),
        None => s.to_string(),
    }
}

/// Largest index `<= max` that is a char boundary.
fn floor_boundary(s: &str, max: usize) -> usize {
    if max >= s.len() {
        return s.len();
    }
    let mut i = max;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn spend(budget: &mut usize, n: usize) {
    *budget = budget.saturating_sub(n);
}

/// Walk `v`, keeping the output under `budget` serialized bytes (approximately
/// — see [`WireEntry::seal`] for the exact re-measure). Bounded by the budget,
/// not by the input, so a 482 KB image body costs 16 KB of work, not 482 KB.
fn clip_value(v: &Value, budget: &mut usize, truncated: &mut bool) -> Value {
    match v {
        Value::Null => {
            spend(budget, 4);
            Value::Null
        }
        Value::Bool(b) => {
            spend(budget, 5);
            Value::Bool(*b)
        }
        Value::Number(_) => {
            spend(budget, 8);
            v.clone()
        }
        Value::String(s) => {
            let need = s.len() + 2;
            if need <= *budget {
                *budget -= need;
                Value::String(s.clone())
            } else {
                let room = budget.saturating_sub(2);
                *budget = 0;
                *truncated = true;
                Value::String(s[..floor_boundary(s, room)].to_string())
            }
        }
        Value::Array(items) => {
            spend(budget, 2);
            let mut out = Vec::new();
            for item in items {
                if *budget == 0 {
                    break;
                }
                spend(budget, 1);
                out.push(clip_value(item, budget, truncated));
            }
            if out.len() < items.len() {
                *truncated = true;
            }
            Value::Array(out)
        }
        Value::Object(map) => {
            spend(budget, 2);
            let mut out = serde_json::Map::new();
            for (k, val) in map {
                if *budget == 0 {
                    break;
                }
                spend(budget, k.len() + 4);
                out.insert(k.clone(), clip_value(val, budget, truncated));
            }
            if out.len() < map.len() {
                *truncated = true;
            }
            Value::Object(out)
        }
    }
}
