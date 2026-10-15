//! Pure payload → ask-detail derivations, plus the match key.
//!
//! Everything here reads a raw Claude Code hook payload (`serde_json::Value`)
//! and returns the DISPLAY-grade detail that is persisted on the ask row. The
//! rule is the same one the `sessions` SSE delta follows: the permission side
//! gets the short, secret-conscious summary (never the raw command or file
//! content); the question side gets the agent's own words (question, options,
//! descriptions — that is the content of the ask); the elicitation side gets
//! the already-capped form from [`crate::sessions::elicitation`].
//!
//! No clock, no I/O, no state — every function is unit-tested on captured
//! payloads.

use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::sessions::activity::{self, HookPayload};
use crate::sessions::elicitation;

/// AskUserQuestion takes one to four questions; keep a little headroom.
const MAX_QUESTIONS: usize = 8;
/// Per question, the option list is the model's own; bound it.
const MAX_OPTIONS: usize = 16;
const MAX_QUESTION_TEXT: usize = 600;
const MAX_HEADER: usize = 60;
const MAX_LABEL: usize = 120;
const MAX_DESCRIPTION: usize = 300;
/// Cap for one string value inside the live (never persisted) tool input.
const MAX_LIVE_STRING: usize = 4000;

/// The tool name Claude Code uses for its multiple-choice question dialog.
pub const ASK_USER_QUESTION: &str = "AskUserQuestion";

fn clip(s: &str, max: usize) -> String {
    let s = s.trim();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i >= max {
            out.push('…');
            break;
        }
        out.push(c);
    }
    out
}

/// The hook payload's `tool_name`, trimmed, when present.
pub fn tool_name(raw: &Value) -> Option<&str> {
    raw.get("tool_name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Does this payload belong to an AskUserQuestion call?
pub fn is_question(raw: &Value) -> bool {
    tool_name(raw) == Some(ASK_USER_QUESTION)
}

/// Detail for a `permission` ask: the same `{tool, summary, kind, mode}` the
/// live `permission_request` field carries, plus whether Claude offered
/// "always allow" style updates (their content is only served live, see
/// [`live_input`]) and which subagent asked, when one did.
///
/// `suggestions_sig` is a hash of the offered updates. An answer picks them BY
/// INDEX (`permissions: [0]`), so the detail must change whenever their
/// content does: a changed detail mints a new ask id (see
/// `asks::open_or_refresh`), and an id therefore always names one set of
/// choices.
pub fn permission(raw: &Value) -> Option<Value> {
    let payload = HookPayload::deserialize(raw).unwrap_or_default();
    let ask = activity::permission_ask(&payload)?;
    let offered = raw.get("permission_suggestions").and_then(Value::as_array);
    let suggestions = offered.map(Vec::len).unwrap_or(0);
    let mut d = json!({
        "tool": ask.tool,
        "summary": ask.summary,
        "kind": ask.kind,
        "mode": ask.mode,
        "suggestions": suggestions,
    });
    if let Some(list) = offered.filter(|l| !l.is_empty()) {
        let canon =
            serde_json::to_string(&canonical(&Value::Array(list.clone()))).unwrap_or_default();
        d["suggestions_sig"] = json!(hash_hex(&["suggestions", &canon]));
    }
    if let Some(a) = payload
        .agent_type
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        d["agent_type"] = json!(clip(a, MAX_HEADER));
    }
    Some(d)
}

/// Detail for a `question` ask: EVERY question of the AskUserQuestion call (the
/// live `question_request` field only carries the first), each with its
/// header, multi-select flag and options (label + description).
///
/// `None` when the payload carries no readable question — the caller then
/// falls back to a plain permission ask rather than drawing an empty card.
pub fn question(raw: &Value) -> Option<Value> {
    let qs = raw.get("tool_input")?.get("questions")?.as_array()?;
    let mut out = Vec::new();
    for q in qs.iter().take(MAX_QUESTIONS) {
        let Some(text) = q.get("question").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        if text.is_empty() {
            continue;
        }
        let header = q
            .get("header")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| clip(s, MAX_HEADER));
        let multi = q
            .get("multiSelect")
            .or_else(|| q.get("multi_select"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let options: Vec<Value> = q
            .get("options")
            .and_then(Value::as_array)
            .map(|opts| {
                opts.iter()
                    .filter_map(|o| match o {
                        Value::String(s) => Some((s.trim().to_string(), None)),
                        Value::Object(m) => m.get("label").and_then(Value::as_str).map(|l| {
                            (
                                l.trim().to_string(),
                                m.get("description").and_then(Value::as_str),
                            )
                        }),
                        _ => None,
                    })
                    .filter(|(l, _)| !l.is_empty())
                    .take(MAX_OPTIONS)
                    .map(|(label, desc)| {
                        let mut o = json!({ "label": clip(&label, MAX_LABEL) });
                        if let Some(d) = desc.map(str::trim).filter(|d| !d.is_empty()) {
                            o["description"] = json!(clip(d, MAX_DESCRIPTION));
                        }
                        o
                    })
                    .collect()
            })
            .unwrap_or_default();
        let mut entry = json!({
            "question": clip(text, MAX_QUESTION_TEXT),
            "multi_select": multi,
            "options": options,
        });
        if let Some(h) = header {
            entry["header"] = json!(h);
        }
        out.push(entry);
    }
    if out.is_empty() {
        return None;
    }
    Some(json!({ "questions": out }))
}

/// Detail for an `elicitation` ask: the capped, attributed form
/// ([`elicitation::parse`]). `None` for an unattributed ask, exactly as the
/// live card refuses one.
pub fn elicitation(raw: &Value) -> Option<Value> {
    let ask = elicitation::parse(raw)?;
    serde_json::to_value(ask).ok()
}

/// Detail for a `waiting` ask (a needs-you Notification).
pub fn waiting(notification_type: &str, message: &str) -> Value {
    json!({
        "notification_type": notification_type,
        "message": clip(message, MAX_QUESTION_TEXT),
    })
}

/// Detail for a `needs_input` ask (a board card's blocking question).
pub fn needs_input(issue_id: &str, question: &str) -> Value {
    json!({ "issue_id": issue_id, "question": clip(question, 2000) })
}

/// Recursively sort object keys so two serializations of the same JSON are
/// byte-identical regardless of key order.
fn canonical(v: &Value) -> Value {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let mut out = Map::new();
            for k in keys {
                out.insert(k.clone(), canonical(&m[k]));
            }
            Value::Object(out)
        }
        Value::Array(a) => Value::Array(a.iter().map(canonical).collect()),
        other => other.clone(),
    }
}

fn hash_hex(parts: &[&str]) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p.as_bytes());
        h.update([0u8]);
    }
    let out = h.finalize();
    out.iter().take(12).map(|b| format!("{b:02x}")).collect()
}

/// The match key of a tool-call ask (permission / question): the tool name,
/// WHO asked — Claude's `session_id` (an in-process teammate has its own,
/// under the lead's pane token) and the subagent's `agent_id` (subagents share
/// their parent's session id) — and the canonical tool input, minus the
/// `answers` an AskUserQuestion carries once it has been answered. So the
/// question's PreToolUse, its PermissionRequest and its PostToolUse all map to
/// the same key, while the same command asked by the lead and by a teammate
/// are two asks. A hash: no content reaches the row.
///
/// The `PermissionRequest` payload carries no `tool_use_id` (Claude Code
/// 2.1.300), so it cannot be part of the key.
pub fn tool_key(raw: &Value) -> String {
    let tool = tool_name(raw).unwrap_or_default();
    let session = raw
        .get("session_id")
        .or_else(|| raw.get("sessionId"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let agent = raw
        .get("agent_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut input = raw.get("tool_input").cloned().unwrap_or(Value::Null);
    if let Value::Object(m) = &mut input {
        m.remove("answers");
    }
    let input = serde_json::to_string(&canonical(&input)).unwrap_or_default();
    hash_hex(&["tool", tool, session, agent, &input])
}

/// The `answers` an answered AskUserQuestion's payload carries (its
/// PostToolUse `tool_input.answers`), when present.
pub fn question_answers(raw: &Value) -> Option<&Map<String, Value>> {
    raw.get("tool_input")?.get("answers")?.as_object()
}

/// The match key of an elicitation: Claude's own `elicitation_id` when the
/// payload carries one (the only thing tying it to its ElicitationResult), else
/// the server + message + schema.
pub fn elicitation_key(raw: &Value) -> String {
    if let Some(id) = raw
        .get("elicitation_id")
        .or_else(|| raw.get("elicitationId"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        return hash_hex(&["elicitation-id", id]);
    }
    let server = raw
        .get("mcp_server_name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message = raw
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let schema = raw
        .get("requested_schema")
        .map(|s| serde_json::to_string(&canonical(s)).unwrap_or_default())
        .unwrap_or_default();
    hash_hex(&["elicitation", server, message, &schema])
}

/// Copy `v` with every string longer than [`MAX_LIVE_STRING`] chars cut (and
/// marked) and arrays/objects bounded, so the live view of a huge Write never
/// ships megabytes to a client.
fn cap_strings(v: &Value, depth: usize) -> Value {
    if depth > 12 {
        return json!("…");
    }
    match v {
        Value::String(s) if s.chars().count() > MAX_LIVE_STRING => {
            let mut c: String = s.chars().take(MAX_LIVE_STRING).collect();
            c.push_str("…[truncated]");
            Value::String(c)
        }
        Value::Array(a) => Value::Array(
            a.iter()
                .take(200)
                .map(|x| cap_strings(x, depth + 1))
                .collect(),
        ),
        Value::Object(m) => Value::Object(
            m.iter()
                .take(200)
                .map(|(k, x)| (k.clone(), cap_strings(x, depth + 1)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// What a client may see of a LIVE ask beyond its persisted detail: the real
/// tool input (so a human approving `Bash` reads the actual command, not only
/// Claude's description of it) and Claude's offered permission updates (the
/// "always allow" choices, addressed by index in an answer). Built from the
/// payload the waiting decision hook holds in memory; never written to disk.
pub fn live_input(raw: &Value) -> Value {
    let mut out = json!({});
    if let Some(ti) = raw.get("tool_input") {
        out["tool_input"] = cap_strings(ti, 0);
    }
    if let Some(s) = raw.get("permission_suggestions").filter(|s| s.is_array()) {
        out["permission_suggestions"] = cap_strings(s, 0);
    }
    if let Some(s) = raw.get("requested_schema") {
        out["requested_schema"] = cap_strings(s, 0);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A live PermissionRequest off Claude Code 2.1.300 (captured in a scratch
    /// session; paths shortened).
    const LIVE_PERMISSION: &str = r#"{"session_id":"35ed81d5","transcript_path":"/x.jsonl","cwd":"/w","permission_mode":"default","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"touch probe1.txt","description":"Create empty file probe1.txt"},"permission_suggestions":[{"type":"addDirectories","directories":["/w"],"destination":"session"},{"type":"setMode","mode":"acceptEdits","destination":"session"}]}"#;

    /// A live AskUserQuestion PermissionRequest off 2.1.300: two questions, the
    /// first multi-select.
    const LIVE_QUESTION: &str = r#"{"session_id":"b9aab2cc","hook_event_name":"PermissionRequest","permission_mode":"default","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Which fruits do you like?","header":"Fruits","options":[{"label":"Apple","description":"Apple"},{"label":"Banana","description":"Banana"},{"label":"Cherry","description":"Cherry"}],"multiSelect":true},{"question":"Which color?","header":"Color","options":[{"label":"Red","description":"Red"},{"label":"Green","description":"Green"}],"multiSelect":false}]}}"#;

    fn p(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn permission_detail_is_the_summary_never_the_raw_command() {
        let d = permission(&p(LIVE_PERMISSION)).unwrap();
        assert_eq!(d["tool"], json!("Bash"));
        assert_eq!(d["summary"], json!("⚡ Create empty file probe1.txt"));
        assert_eq!(d["kind"], json!("bash"));
        assert_eq!(d["mode"], json!("default"));
        assert_eq!(d["suggestions"], json!(2));
        assert!(
            !d.to_string().contains("touch probe1.txt"),
            "raw command must not be persisted: {d}"
        );
    }

    #[test]
    fn question_detail_carries_every_question_and_its_options() {
        let d = question(&p(LIVE_QUESTION)).unwrap();
        let qs = d["questions"].as_array().unwrap();
        assert_eq!(qs.len(), 2);
        assert_eq!(qs[0]["question"], json!("Which fruits do you like?"));
        assert_eq!(qs[0]["header"], json!("Fruits"));
        assert_eq!(qs[0]["multi_select"], json!(true));
        assert_eq!(qs[0]["options"][2]["label"], json!("Cherry"));
        assert_eq!(qs[1]["multi_select"], json!(false));
        assert_eq!(qs[1]["options"].as_array().unwrap().len(), 2);
        assert!(question_answers(&p(LIVE_QUESTION)).is_none());
        let mut answered = p(LIVE_QUESTION);
        answered["tool_input"]["answers"] = json!({"Which color?": "Red"});
        assert_eq!(
            question_answers(&answered).unwrap()["Which color?"],
            json!("Red")
        );
    }

    #[test]
    fn a_question_payload_without_text_is_not_a_question_detail() {
        assert!(question(&p(
            r#"{"tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"  "}]}}"#
        ))
        .is_none());
        assert!(question(&p(r#"{"tool_name":"AskUserQuestion"}"#)).is_none());
    }

    #[test]
    fn the_question_key_ignores_key_order_and_the_answers() {
        // PreToolUse, PermissionRequest and the answered PostToolUse of the SAME
        // call must agree on the key.
        let pre = p(LIVE_QUESTION);
        let mut answered = pre.clone();
        answered["tool_input"]["answers"] = json!({"Which color?": "Red"});
        let reordered = p(
            r#"{"session_id":"b9aab2cc","tool_input":{"questions":[{"multiSelect":true,"header":"Fruits","question":"Which fruits do you like?","options":[{"description":"Apple","label":"Apple"},{"label":"Banana","description":"Banana"},{"label":"Cherry","description":"Cherry"}]},{"question":"Which color?","header":"Color","options":[{"label":"Red","description":"Red"},{"label":"Green","description":"Green"}],"multiSelect":false}]},"tool_name":"AskUserQuestion"}"#,
        );
        assert_eq!(tool_key(&pre), tool_key(&answered));
        assert_eq!(tool_key(&pre), tool_key(&reordered));
        // A different command is a different ask.
        let mut other = p(LIVE_PERMISSION);
        assert_ne!(tool_key(&other), tool_key(&pre));
        let k1 = tool_key(&other);
        other["tool_input"]["command"] = json!("touch probe2.txt");
        assert_ne!(k1, tool_key(&other));
    }

    #[test]
    fn the_same_call_from_another_claude_session_or_agent_is_another_key() {
        // The lead and an in-process teammate (own session_id, same pane token)
        // asking the very same command are two pending requests, not one.
        let lead = p(LIVE_PERMISSION);
        let mut mate = lead.clone();
        mate["session_id"] = json!("teammate-1");
        assert_ne!(tool_key(&lead), tool_key(&mate));
        // A subagent shares its parent's session_id; its agent_id tells it apart.
        let mut sub = lead.clone();
        sub["agent_id"] = json!("a7ff6f317c2b6cb05");
        assert_ne!(tool_key(&lead), tool_key(&sub));
        // The PostToolUse of the same call (no suggestions, extra fields) keeps
        // the key.
        let mut post = lead.clone();
        post.as_object_mut()
            .unwrap()
            .remove("permission_suggestions");
        post["hook_event_name"] = json!("PostToolUse");
        post["tool_use_id"] = json!("toolu_1");
        post["tool_response"] = json!({"stdout": ""});
        assert_eq!(tool_key(&lead), tool_key(&post));
    }

    #[test]
    fn the_permission_detail_changes_when_the_offered_updates_do() {
        let a = permission(&p(LIVE_PERMISSION)).unwrap();
        let mut other = p(LIVE_PERMISSION);
        other["permission_suggestions"][0] = json!({"type":"addRules","rules":[{"toolName":"Bash"}],"behavior":"allow","destination":"userSettings"});
        let b = permission(&other).unwrap();
        assert_eq!(a["suggestions"], b["suggestions"], "same count");
        assert_ne!(a, b, "but not the same choices: {a} vs {b}");
        // Key order inside an update does not matter.
        let mut reordered = p(LIVE_PERMISSION);
        reordered["permission_suggestions"][0] =
            json!({"destination":"session","directories":["/w"],"type":"addDirectories"});
        assert_eq!(a, permission(&reordered).unwrap());
        let mut none = p(LIVE_PERMISSION);
        none.as_object_mut()
            .unwrap()
            .remove("permission_suggestions");
        assert!(permission(&none).unwrap().get("suggestions_sig").is_none());
    }

    #[test]
    fn the_elicitation_key_prefers_claudes_id() {
        let a = p(r#"{"mcp_server_name":"s","message":"m","elicitation_id":"el_1"}"#);
        let b = p(r#"{"mcp_server_name":"s2","message":"other","elicitation_id":"el_1"}"#);
        assert_eq!(elicitation_key(&a), elicitation_key(&b));
        let c = p(r#"{"mcp_server_name":"s","message":"m","requested_schema":{"b":1,"a":2}}"#);
        let d = p(r#"{"mcp_server_name":"s","message":"m","requested_schema":{"a":2,"b":1}}"#);
        assert_eq!(elicitation_key(&c), elicitation_key(&d));
    }

    #[test]
    fn live_input_caps_huge_strings() {
        let big = "x".repeat(10_000);
        let raw = json!({"tool_name":"Write","tool_input":{"file_path":"a.txt","content": big}});
        let live = live_input(&raw);
        let c = live["tool_input"]["content"].as_str().unwrap();
        assert!(c.chars().count() < 4100 && c.ends_with("[truncated]"));
        assert_eq!(live["tool_input"]["file_path"], json!("a.txt"));
    }
}
