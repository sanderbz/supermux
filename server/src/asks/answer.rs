//! Answer validation and the exact hook output each answer becomes.
//!
//! Pure: every function takes the client's answer body plus the hook payload
//! the waiting decision hook holds, and returns either the JSON the hook prints
//! to Claude Code (its documented decision-control output) or a 400-grade
//! message. The second value of each `Ok` is the RECORD of the answer that is
//! persisted on the ask: choices are kept (the decision, the chosen labels),
//! free text is not (a reply or a deny message can carry anything, so only its
//! presence is recorded).
//!
//! The output shapes were verified live against Claude Code 2.1.293 and
//! 2.1.300 (see `docs/ASKS.md`, "Evidence"):
//!
//! * permission allow: `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
//!   closes the terminal dialog and runs the tool ("Allowed by
//!   PermissionRequest hook").
//! * permission deny: `decision.behavior = "deny"` + `message` — the agent
//!   reads the message as the tool result and carries on.
//! * AskUserQuestion: `behavior = "allow"` with `updatedInput` = the call's
//!   own input plus `answers: {question: label}`; multi-select labels are
//!   joined with `", "` — the agent receives "User answered Claude's
//!   questions: · Which fruits do you like? → Apple, Cherry".
//! * elicitation: `{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"accept","content":{…}}}`.

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::sessions::elicitation;

/// Longest deny message / free-text answer / reply we pass on.
const MAX_TEXT: usize = 8000;

/// `POST /api/asks/{id}/answer` body. Which fields apply depends on the ask's
/// kind; anything else is ignored.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct AnswerBody {
    /// permission / question: `allow` or `deny` (a question answered through
    /// `answers` needs no decision; `deny` declines to answer it).
    #[serde(default)]
    pub decision: Option<String>,
    /// deny: the sentence the agent reads instead of the tool result.
    #[serde(default)]
    pub message: Option<String>,
    /// deny: also stop the agent's turn (Claude Code's `interrupt`).
    #[serde(default)]
    pub interrupt: Option<bool>,
    /// permission allow: indexes into the live `permission_suggestions`
    /// (Claude's own "always allow …" updates) to apply with the allow.
    #[serde(default)]
    pub permissions: Option<Vec<usize>>,
    /// question: one entry per question, keyed by the question text or its
    /// 0-based index. Value: a label, a list of labels, or
    /// `{"selected": [labels], "other": "free text"}`.
    #[serde(default)]
    pub answers: Option<Map<String, Value>>,
    /// elicitation: `accept` / `decline` / `cancel`.
    #[serde(default)]
    pub action: Option<String>,
    /// elicitation accept: the form values, keyed by field name.
    #[serde(default)]
    pub content: Option<Map<String, Value>>,
    /// needs_input / waiting: the reply typed into the session.
    #[serde(default)]
    pub text: Option<String>,
}

fn clip(s: &str, max: usize) -> String {
    s.trim().chars().take(max).collect()
}

fn decision(body: &AnswerBody) -> Option<String> {
    body.decision
        .as_deref()
        .map(|d| d.trim().to_ascii_lowercase())
}

/// The deny half shared by permission and question asks.
fn deny_output(body: &AnswerBody) -> (Value, Value) {
    let mut d = json!({ "behavior": "deny" });
    let message = body
        .message
        .as_deref()
        .map(|m| clip(m, MAX_TEXT))
        .filter(|m| !m.is_empty());
    if let Some(m) = &message {
        d["message"] = json!(m);
    }
    let interrupt = body.interrupt.unwrap_or(false);
    if interrupt {
        d["interrupt"] = json!(true);
    }
    (
        permission_request_output(d),
        json!({ "decision": "deny", "message": message.is_some(), "interrupt": interrupt }),
    )
}

fn permission_request_output(decision: Value) -> Value {
    json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } })
}

/// A permission ask's answer. `payload` is the live PermissionRequest payload.
pub fn permission(body: &AnswerBody, payload: &Value) -> Result<(Value, Value), String> {
    match decision(body).as_deref() {
        Some("allow") => {
            let mut d = json!({ "behavior": "allow" });
            let chosen = body.permissions.clone().unwrap_or_default();
            if !chosen.is_empty() {
                let offered = payload
                    .get("permission_suggestions")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let mut updates = Vec::new();
                for i in &chosen {
                    match offered.get(*i) {
                        Some(u) => updates.push(u.clone()),
                        None => {
                            return Err(format!(
                                "permissions[{i}] is out of range: Claude offered {} update(s) for this ask",
                                offered.len()
                            ))
                        }
                    }
                }
                d["updatedPermissions"] = Value::Array(updates);
            }
            Ok((
                permission_request_output(d),
                json!({ "decision": "allow", "permissions": chosen }),
            ))
        }
        Some("deny") => Ok(deny_output(body)),
        Some(other) => Err(format!(
            "decision must be \"allow\" or \"deny\", got {other:?}"
        )),
        None => Err("a permission ask needs \"decision\": \"allow\" or \"deny\"".into()),
    }
}

/// One question of the live AskUserQuestion input, as Claude sent it.
struct LiveQuestion {
    /// Verbatim (untrimmed) — the `answers` map is keyed by this exact string.
    raw: String,
    multi: bool,
    labels: Vec<String>,
}

fn live_questions(payload: &Value) -> Vec<LiveQuestion> {
    payload
        .get("tool_input")
        .and_then(|t| t.get("questions"))
        .and_then(Value::as_array)
        .map(|qs| {
            qs.iter()
                .filter_map(|q| {
                    let raw = q.get("question")?.as_str()?.to_string();
                    if raw.trim().is_empty() {
                        return None;
                    }
                    let multi = q
                        .get("multiSelect")
                        .or_else(|| q.get("multi_select"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let labels = q
                        .get("options")
                        .and_then(Value::as_array)
                        .map(|o| {
                            o.iter()
                                .filter_map(|x| match x {
                                    Value::String(s) => Some(s.clone()),
                                    Value::Object(m) => {
                                        m.get("label").and_then(Value::as_str).map(str::to_string)
                                    }
                                    _ => None,
                                })
                                .filter(|l| !l.trim().is_empty())
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(LiveQuestion { raw, multi, labels })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Resolve a client-written label to the option's exact label: exact match
/// after trimming first, then case-insensitive. Strict on purpose — a typo must
/// be a 400, never a free-text answer the human did not mean to give.
fn match_label<'a>(q: &'a LiveQuestion, given: &str) -> Option<&'a str> {
    let g = given.trim();
    q.labels
        .iter()
        .find(|l| l.trim() == g)
        .or_else(|| q.labels.iter().find(|l| l.trim().eq_ignore_ascii_case(g)))
        .map(String::as_str)
}

/// A question ask's answer. `payload` is the live PermissionRequest payload of
/// the AskUserQuestion call.
pub fn question(body: &AnswerBody, payload: &Value) -> Result<(Value, Value), String> {
    if decision(body).as_deref() == Some("deny") {
        return Ok(deny_output(body));
    }
    if let Some(d) = decision(body).filter(|d| d != "allow") {
        return Err(format!("decision must be \"allow\" or \"deny\", got {d:?}"));
    }
    let given = body
        .answers
        .as_ref()
        .ok_or("a question ask needs \"answers\" (or \"decision\": \"deny\")")?;
    let qs = live_questions(payload);
    if qs.is_empty() {
        return Err("this question ask carries no readable questions".into());
    }
    // Map every given key onto a question index.
    let mut by_index: Vec<Option<&Value>> = vec![None; qs.len()];
    for (k, v) in given {
        let idx = k
            .trim()
            .parse::<usize>()
            .ok()
            .filter(|i| *i < qs.len())
            .or_else(|| qs.iter().position(|q| q.raw.trim() == k.trim()))
            .ok_or_else(|| format!("answers key {k:?} matches no question of this ask"))?;
        if by_index[idx].is_some() {
            return Err(format!("question {idx} is answered twice"));
        }
        by_index[idx] = Some(v);
    }
    let mut answers = Map::new();
    let mut record = Map::new();
    for (i, q) in qs.iter().enumerate() {
        let v = by_index[i]
            .ok_or_else(|| format!("question {i} ({:?}) has no answer", q.raw.trim()))?;
        let (selected, other): (Vec<String>, Option<String>) =
            match v {
                Value::String(s) => (vec![s.clone()], None),
                Value::Array(a) => (
                    a.iter()
                        .map(|x| {
                            x.as_str()
                                .map(str::to_string)
                                .ok_or("labels must be strings")
                        })
                        .collect::<Result<_, _>>()?,
                    None,
                ),
                Value::Object(m) => (
                    m.get("selected")
                        .and_then(Value::as_array)
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str().map(str::to_string))
                                .collect()
                        })
                        .unwrap_or_default(),
                    m.get("other")
                        .and_then(Value::as_str)
                        .map(|s| clip(s, MAX_TEXT))
                        .filter(|s| !s.is_empty()),
                ),
                _ => return Err(format!(
                    "question {i}: an answer is a label, a list of labels, or {{selected, other}}"
                )),
            };
        let mut labels: Vec<(usize, &str)> = Vec::new();
        for s in &selected {
            let l = match_label(q, s).ok_or_else(|| {
                format!(
                    "question {i}: {s:?} is not one of its options ({}); use {{\"other\": \"…\"}} for a free-text answer",
                    q.labels.join(", ")
                )
            })?;
            let pos = q.labels.iter().position(|x| x == l).unwrap_or(usize::MAX);
            if !labels.iter().any(|(_, x)| *x == l) {
                labels.push((pos, l));
            }
        }
        labels.sort_by_key(|(p, _)| *p);
        let count = labels.len() + usize::from(other.is_some());
        if count == 0 {
            return Err(format!("question {i}: choose at least one option"));
        }
        if !q.multi && count > 1 {
            return Err(format!(
                "question {i} is single-select: give exactly one answer"
            ));
        }
        let mut parts: Vec<String> = labels.iter().map(|(_, l)| l.to_string()).collect();
        if let Some(o) = &other {
            parts.push(o.clone());
        }
        answers.insert(q.raw.clone(), json!(parts.join(", ")));
        record.insert(
            q.raw.trim().to_string(),
            json!({ "selected": labels.iter().map(|(_, l)| *l).collect::<Vec<_>>(), "other": other.is_some() }),
        );
    }
    let mut input = payload
        .get("tool_input")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !input.is_object() {
        input = json!({});
    }
    input["answers"] = Value::Object(answers);
    Ok((
        permission_request_output(json!({ "behavior": "allow", "updatedInput": input })),
        json!({ "decision": "answer", "answers": record }),
    ))
}

/// An elicitation ask's answer. `payload` is the live Elicitation payload.
pub fn elicitation(body: &AnswerBody, payload: &Value) -> Result<(Value, Value), String> {
    let action = body
        .action
        .as_deref()
        .map(|a| a.trim().to_ascii_lowercase())
        .ok_or("an elicitation ask needs \"action\": \"accept\", \"decline\" or \"cancel\"")?;
    if !elicitation::ACTIONS.contains(&action.as_str()) {
        return Err(format!(
            "action must be accept, decline or cancel, got {action:?}"
        ));
    }
    let mut out = json!({ "hookEventName": "Elicitation", "action": action });
    let mut record = json!({ "action": action });
    if action == "accept" {
        let content = body.content.clone().unwrap_or_default();
        let fields = elicitation::parse(payload)
            .map(|a| a.fields)
            .unwrap_or_default();
        let problems = elicitation::validate(&fields, &content);
        if !problems.is_empty() {
            let msg: Vec<String> = problems
                .iter()
                .map(|p| format!("{}: {}", p.field, p.message))
                .collect();
            return Err(format!("the form does not validate: {}", msg.join("; ")));
        }
        record["fields"] = json!(content.keys().collect::<Vec<_>>());
        out["content"] = Value::Object(content);
    }
    Ok((json!({ "hookSpecificOutput": out }), record))
}

/// A needs_input / waiting ask's answer: the reply to type into the session.
pub fn text(body: &AnswerBody) -> Result<(String, Value), String> {
    let t = body
        .text
        .as_deref()
        .map(|t| clip(t, MAX_TEXT))
        .unwrap_or_default();
    if t.is_empty() {
        return Err("this ask is answered with \"text\": the reply to send to the agent".into());
    }
    let chars = t.chars().count();
    Ok((t, json!({ "decision": "reply", "chars": chars })))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIVE_PERMISSION: &str = r#"{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"touch probe1.txt","description":"Create empty file probe1.txt"},"permission_suggestions":[{"type":"addDirectories","directories":["/w"],"destination":"session"},{"type":"setMode","mode":"acceptEdits","destination":"session"}]}"#;
    const LIVE_QUESTION: &str = r#"{"hook_event_name":"PermissionRequest","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Which fruits do you like?","header":"Fruits","options":[{"label":"Apple","description":"Apple"},{"label":"Banana","description":"Banana"},{"label":"Cherry","description":"Cherry"}],"multiSelect":true},{"question":"Which color?","header":"Color","options":[{"label":"Red","description":"Red"},{"label":"Green","description":"Green"}],"multiSelect":false}]}}"#;

    fn p(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }
    fn body(v: Value) -> AnswerBody {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn allow_is_the_documented_decision_object() {
        let (out, rec) =
            permission(&body(json!({"decision":"allow"})), &p(LIVE_PERMISSION)).unwrap();
        assert_eq!(
            out,
            json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}})
        );
        assert_eq!(rec["decision"], json!("allow"));
    }

    #[test]
    fn allow_with_a_chosen_suggestion_applies_exactly_that_update() {
        let (out, _) = permission(
            &body(json!({"decision":"allow","permissions":[0]})),
            &p(LIVE_PERMISSION),
        )
        .unwrap();
        let ups = &out["hookSpecificOutput"]["decision"]["updatedPermissions"];
        assert_eq!(ups.as_array().unwrap().len(), 1);
        assert_eq!(ups[0]["type"], json!("addDirectories"));
        assert!(permission(
            &body(json!({"decision":"allow","permissions":[5]})),
            &p(LIVE_PERMISSION)
        )
        .is_err());
    }

    #[test]
    fn deny_carries_the_message_but_the_record_does_not() {
        let (out, rec) = permission(
            &body(
                json!({"decision":"deny","message":"not now: use the staging db","interrupt":true}),
            ),
            &p(LIVE_PERMISSION),
        )
        .unwrap();
        let d = &out["hookSpecificOutput"]["decision"];
        assert_eq!(d["behavior"], json!("deny"));
        assert_eq!(d["message"], json!("not now: use the staging db"));
        assert_eq!(d["interrupt"], json!(true));
        assert!(
            !rec.to_string().contains("staging"),
            "free text must not be persisted: {rec}"
        );
    }

    #[test]
    fn a_permission_answer_needs_a_known_decision() {
        assert!(permission(&body(json!({})), &p(LIVE_PERMISSION)).is_err());
        assert!(permission(&body(json!({"decision":"maybe"})), &p(LIVE_PERMISSION)).is_err());
    }

    #[test]
    fn multi_select_answers_join_in_option_order_and_keep_the_input() {
        let (out, rec) = question(
            &body(json!({"answers": {"Which fruits do you like?": ["cherry", "Apple"], "1": "Green"}})),
            &p(LIVE_QUESTION),
        )
        .unwrap();
        let d = &out["hookSpecificOutput"]["decision"];
        assert_eq!(d["behavior"], json!("allow"));
        let input = &d["updatedInput"];
        assert_eq!(
            input["answers"]["Which fruits do you like?"],
            json!("Apple, Cherry")
        );
        assert_eq!(input["answers"]["Which color?"], json!("Green"));
        // The call's own input rides along untouched.
        assert_eq!(input["questions"][0]["header"], json!("Fruits"));
        assert_eq!(
            rec["answers"]["Which fruits do you like?"]["selected"],
            json!(["Apple", "Cherry"])
        );
    }

    #[test]
    fn free_text_rides_other_and_is_not_recorded() {
        let (out, rec) = question(
            &body(json!({"answers": {"0": {"selected": ["Banana"], "other": "and figs"}, "1": {"other": "teal"}}})),
            &p(LIVE_QUESTION),
        )
        .unwrap();
        let a = &out["hookSpecificOutput"]["decision"]["updatedInput"]["answers"];
        assert_eq!(a["Which fruits do you like?"], json!("Banana, and figs"));
        assert_eq!(a["Which color?"], json!("teal"));
        assert!(!rec.to_string().contains("figs"));
    }

    #[test]
    fn question_answers_are_validated_strictly() {
        let q = p(LIVE_QUESTION);
        // Typo → 400, never a silent free-text answer.
        assert!(question(&body(json!({"answers": {"0": ["Aple"], "1": "Red"}})), &q).is_err());
        // Single-select with two answers.
        assert!(question(
            &body(json!({"answers": {"0": ["Apple"], "1": ["Red", "Green"]}})),
            &q
        )
        .is_err());
        // A question left unanswered.
        assert!(question(&body(json!({"answers": {"0": ["Apple"]}})), &q).is_err());
        // An unknown key.
        assert!(question(
            &body(json!({"answers": {"0": "Apple", "1": "Red", "Which car?": "x"}})),
            &q
        )
        .is_err());
        // Nothing at all.
        assert!(question(&body(json!({})), &q).is_err());
    }

    #[test]
    fn a_question_can_be_declined_with_a_message() {
        let (out, _) = question(
            &body(json!({"decision":"deny","message":"skip it"})),
            &p(LIVE_QUESTION),
        )
        .unwrap();
        assert_eq!(
            out["hookSpecificOutput"]["decision"]["behavior"],
            json!("deny")
        );
    }

    const LIVE_ELICITATION: &str = r#"{"hook_event_name":"Elicitation","mcp_server_name":"probe-form","message":"Confirm the release","mode":"form","requested_schema":{"type":"object","properties":{"approver":{"type":"string","title":"Approver"},"env":{"type":"string","enum":["prod","staging"]}},"required":["approver","env"]}}"#;

    #[test]
    fn elicitation_accept_validates_against_the_form() {
        let e = p(LIVE_ELICITATION);
        let (out, rec) = elicitation(
            &body(json!({"action":"accept","content":{"approver":"ops","env":"staging"}})),
            &e,
        )
        .unwrap();
        assert_eq!(
            out,
            json!({"hookSpecificOutput":{"hookEventName":"Elicitation","action":"accept","content":{"approver":"ops","env":"staging"}}})
        );
        assert!(
            !rec.to_string().contains("ops"),
            "form values are not persisted: {rec}"
        );
        assert!(elicitation(
            &body(json!({"action":"accept","content":{"approver":"ops","env":"qa"}})),
            &e
        )
        .is_err());
        assert!(elicitation(&body(json!({"action":"accept","content":{}})), &e).is_err());
        let (out, _) = elicitation(&body(json!({"action":"decline"})), &e).unwrap();
        assert_eq!(out["hookSpecificOutput"]["action"], json!("decline"));
        assert!(elicitation(&body(json!({"action":"maybe"})), &e).is_err());
    }

    #[test]
    fn text_answers_need_text() {
        assert!(text(&body(json!({"text":"   "}))).is_err());
        let (t, rec) = text(&body(json!({"text":" use the blue one "}))).unwrap();
        assert_eq!(t, "use the blue one");
        assert_eq!(rec["chars"], json!(16));
    }
}
