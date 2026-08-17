//! **An MCP server is asking the human for a typed form.**
//!
//! `elicitation/create` is the MCP call where a third-party server stops the
//! tool call it is in the middle of and demands structured input: a JSON Schema
//! of flat primitive properties, which Claude Code renders as a real form
//! (`Claude Code needs your input`, per-field validation, required enforcement,
//! Accept / Decline / Escape-to-cancel). Until this module existed supermux had
//! no idea any of it was happening: `Elicitation` was not in the installed hook
//! set, nothing in the transcript records the dialog, and the turn simply stops
//! — a session parked forever on a form, wearing a green Idle dot
//! (`mcp.elicitation_form`, master catalog; "textbook green-dot-while-blocked").
//!
//! This module is the pure half of the fix, and it is pure on purpose: it turns
//! ONE hook payload into ONE typed ask, and it answers "is this filled in
//! correctly" for a set of values. No clock, no I/O, no state.
//!
//! ## The contract, verbatim
//!
//! Claude Code 2.1.227's own hook documentation (bundle strings):
//!
//! > When an MCP server requests user input (elicitation) — Input to command is
//! > JSON with `mcp_server_name`, `message`, and `requested_schema`. Output JSON
//! > with `hookSpecificOutput` containing `action` (accept/decline/cancel) and
//! > optional `content`.
//!
//! and, for the result leg:
//!
//! > After a user responds to an MCP elicitation — Input to command is JSON with
//! > `mcp_server_name`, `action`, `content`, `mode`, and `elicitation_id`.
//!
//! **The prompt is written by a third party.** `message`, every field title and
//! every enum label below is authored by whoever wrote the MCP server, not by
//! Anthropic and not by this user. It is carried verbatim (that is the only
//! honest thing to do with an ask) and it is attributed to the server BY NAME
//! everywhere it is shown, so a sentence like "supermux needs your password"
//! cannot borrow this app's voice. The renderer treats it as untrusted text:
//! plain, quoted, never markdown, never a link.
//!
//! ## What is modelled, and what is refused
//!
//! Claude Code itself rejects anything but a flat object of primitives —
//! `Elicitation requestedSchema must describe an object with flat primitive
//! properties` / `only supports flat primitive properties (string, number,
//! integer, boolean, and string enums)` — so that is exactly what
//! [`FieldKind`] covers. A property this module cannot type is kept as
//! [`FieldKind::Unsupported`] rather than dropped: a form missing one of its
//! fields is a form that lies about what was asked.
//!
//! Everything is capped ([`MAX_FIELDS`], [`MAX_TEXT`], …) because every string
//! here crosses the wire into a card, and none of it is trusted.

use serde::Serialize;
use serde_json::{Map, Value};

/// Cap on the number of fields carried to a surface. A schema with more is
/// kept up to the cap and the remainder is COUNTED
/// ([`ElicitationAsk::dropped_fields`]) — the card then says so rather than
/// silently showing a shorter form than the server asked for.
pub const MAX_FIELDS: usize = 24;
/// Cap on the server's own prompt sentence.
pub const MAX_TEXT: usize = 400;
/// Cap on a label / title / field name / enum label.
pub const MAX_LABEL: usize = 120;
/// Cap on the number of choices kept for an enum field.
pub const MAX_ENUM: usize = 32;

/// What a form control is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldKind {
    /// Free text (see [`Field::format`] for email/uri/date/date-time).
    String,
    Number,
    Integer,
    Boolean,
    /// A string enum — Claude Code draws it as a selector, so a value outside
    /// the list is unreachable there and must be refused here.
    Enum,
    /// A property this module (and Claude Code) cannot render as a control.
    /// Shown read-only and never enforced, so an odd schema degrades to a
    /// readable ask instead of an unanswerable one.
    Unsupported,
}

/// One option of an enum field: the wire `value` and the label the server wants
/// shown for it (`enumNames`, when present).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Choice {
    pub value: String,
    pub label: String,
}

/// One control of the form.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Field {
    /// The property key — what the answer's `content` is keyed by.
    pub name: String,
    /// The schema's `title`, else the property key. Third-party text.
    pub title: String,
    pub kind: FieldKind,
    /// `email` / `uri` / `date` / `date-time`, when the schema declares one of
    /// the four Claude Code validates.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    pub required: bool,
    /// The schema's `description`. Third-party text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Enum choices, in schema order. Empty for every other kind.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub options: Vec<Choice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimum: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maximum: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_length: Option<u64>,
    /// The schema's `default`, when it is a primitive. Pre-fills the control.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
}

/// **The live ask**: an MCP server is blocked on a human, and this is what it
/// wants. In-memory only, never persisted — same posture as
/// [`super::activity::PermissionAsk`].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ElicitationAsk {
    /// The MCP server's name, verbatim. THE attribution: nothing about this ask
    /// may be shown without it.
    pub server: String,
    /// The server's own sentence. Third-party text, carried verbatim.
    pub message: String,
    pub fields: Vec<Field>,
    /// Claude Code's id for this elicitation, when the payload carries one. The
    /// only thing that ties an `Elicitation` to its `ElicitationResult`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Properties beyond [`MAX_FIELDS`], counted rather than hidden.
    #[serde(skip_serializing_if = "is_zero", default)]
    pub dropped_fields: u32,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// One field's complaint, in Claude Code's own words where Claude Code has one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Problem {
    pub field: String,
    pub message: String,
}

/// The three answers an elicitation can be given, exactly as the MCP spec and
/// the hook's `hookSpecificOutput.action` name them.
pub const ACTIONS: [&str; 3] = ["accept", "decline", "cancel"];

/// Parse an `Elicitation` hook payload into the ask.
///
/// `None` when the payload carries no server name — without the attribution
/// there is nothing this app is willing to put on screen. Everything else
/// degrades: no schema is an ask with no fields (a bare confirmation), an
/// untyped property is [`FieldKind::Unsupported`].
pub fn parse(payload: &Value) -> Option<ElicitationAsk> {
    let obj = payload.as_object()?;
    let server = first_str(obj, &["mcp_server_name", "mcpServerName", "server_name", "serverName"])
        .map(|s| clip(s, MAX_LABEL))
        .filter(|s| !s.is_empty())?;
    let message = first_str(obj, &["message", "elicitation_prompt", "prompt"])
        .map(|s| clip(s, MAX_TEXT))
        .unwrap_or_default();
    let id = first_str(obj, &["elicitation_id", "elicitationId"]).map(|s| clip(s, MAX_LABEL));
    let schema = obj
        .get("requested_schema")
        .or_else(|| obj.get("requestedSchema"));
    let (fields, dropped_fields) = schema.map(schema_fields).unwrap_or_default();
    Some(ElicitationAsk {
        server,
        message,
        fields,
        id,
        dropped_fields,
    })
}

/// A `requested_schema` → the ordered field list + how many were left out.
///
/// **Order is the parsed map's order — lexicographic by property key, not the
/// server's authoring order.** `serde_json` is built here without
/// `preserve_order`, so the insertion order of `properties` is gone before this
/// function ever sees it, and no amount of care downstream can recover it. What
/// matters most is preserved: the order is TOTAL and STABLE, so the same schema
/// always draws the same form and a field never moves under a user's finger
/// between two renders of the same ask. Recovering the authored order means
/// turning `preserve_order` on for the whole server, which would silently
/// reorder every other JSON object this binary writes — a bigger change than
/// this card is worth (registered as debt).
pub fn schema_fields(schema: &Value) -> (Vec<Field>, u32) {
    let Some(props) = schema.get("properties").and_then(Value::as_object) else {
        return (Vec::new(), 0);
    };
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let total = props.len();
    let fields: Vec<Field> = props
        .iter()
        .take(MAX_FIELDS)
        .map(|(name, spec)| field(name, spec, required.contains(&name.as_str())))
        .collect();
    (fields, total.saturating_sub(MAX_FIELDS) as u32)
}

fn field(name: &str, spec: &Value, required: bool) -> Field {
    let obj = spec.as_object();
    let ty = obj.and_then(|o| o.get("type")).and_then(Value::as_str);
    let enum_values: Vec<String> = obj
        .and_then(|o| o.get("enum"))
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .take(MAX_ENUM)
                .filter_map(Value::as_str)
                .map(|v| clip(v, MAX_LABEL))
                .collect()
        })
        .unwrap_or_default();
    let enum_names: Vec<String> = obj
        .and_then(|o| o.get("enumNames").or_else(|| o.get("enum_names")))
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .take(MAX_ENUM)
                .filter_map(Value::as_str)
                .map(|v| clip(v, MAX_LABEL))
                .collect()
        })
        .unwrap_or_default();
    let kind = if !enum_values.is_empty() {
        FieldKind::Enum
    } else {
        match ty {
            Some("string") => FieldKind::String,
            Some("number") => FieldKind::Number,
            Some("integer") => FieldKind::Integer,
            Some("boolean") => FieldKind::Boolean,
            _ => FieldKind::Unsupported,
        }
    };
    let options = enum_values
        .iter()
        .enumerate()
        .map(|(i, v)| Choice {
            value: v.clone(),
            label: enum_names.get(i).cloned().unwrap_or_else(|| v.clone()),
        })
        .collect();
    Field {
        name: clip(name, MAX_LABEL),
        title: obj
            .and_then(|o| o.get("title"))
            .and_then(Value::as_str)
            .map(|t| clip(t, MAX_LABEL))
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| clip(name, MAX_LABEL)),
        kind,
        format: obj
            .and_then(|o| o.get("format"))
            .and_then(Value::as_str)
            .filter(|f| matches!(*f, "email" | "uri" | "date" | "date-time"))
            .map(str::to_string),
        required,
        description: obj
            .and_then(|o| o.get("description"))
            .and_then(Value::as_str)
            .map(|d| clip(d, MAX_TEXT))
            .filter(|d| !d.is_empty()),
        options,
        minimum: obj.and_then(|o| o.get("minimum")).and_then(Value::as_f64),
        maximum: obj.and_then(|o| o.get("maximum")).and_then(Value::as_f64),
        min_length: obj.and_then(|o| o.get("minLength")).and_then(Value::as_u64),
        max_length: obj.and_then(|o| o.get("maxLength")).and_then(Value::as_u64),
        default: obj
            .and_then(|o| o.get("default"))
            .filter(|d| d.is_string() || d.is_number() || d.is_boolean())
            .cloned(),
    }
}

/// **Is this answer submittable?** One [`Problem`] per offending field, in field
/// order, using Claude Code's own sentences (bundle strings, 2.1.227) so a user
/// who sees the terminal and the card gets told the same thing twice.
///
/// Enforced HERE and not only in the browser: the browser is a client, and an
/// answer that reaches the server having skipped a required field is an answer
/// the MCP server would reject anyway — with the rejection landing somewhere
/// nobody is looking.
pub fn validate(fields: &[Field], content: &Map<String, Value>) -> Vec<Problem> {
    let mut out = Vec::new();
    for f in fields {
        // An unsupported property is shown read-only and never enforced (see
        // the module docs): refusing an answer over a control the user was
        // never given is a dead end.
        if f.kind == FieldKind::Unsupported {
            continue;
        }
        let value = content.get(&f.name);
        if is_blank(value) {
            if f.required {
                out.push(problem(f, "This field is required"));
            }
            continue;
        }
        let value = value.expect("is_blank returns true for None");
        if let Some(message) = check(f, value) {
            out.push(Problem {
                field: f.name.clone(),
                message,
            });
        }
    }
    out
}

/// One field's value → the complaint, if any.
fn check(f: &Field, value: &Value) -> Option<String> {
    match f.kind {
        FieldKind::Enum => {
            let v = value.as_str()?;
            if f.options.iter().any(|o| o.value == v) {
                None
            } else {
                // Claude Code renders an enum as a SELECTOR, so it has no
                // message for this: an out-of-list value is unreachable there
                // and can only arrive from an API client. Ours, and it names
                // the remedy rather than the schema.
                Some("Select one of the offered options".to_string())
            }
        }
        FieldKind::Boolean => value
            .as_bool()
            .is_none()
            .then(|| "Must be true or false".to_string()),
        FieldKind::Number | FieldKind::Integer => {
            let noun = if f.kind == FieldKind::Integer {
                "an integer"
            } else {
                "a number"
            };
            let Some(n) = value.as_f64() else {
                return Some(format!("Must be {noun}"));
            };
            if f.kind == FieldKind::Integer && n.fract() != 0.0 {
                return Some(format!("Must be {noun}"));
            }
            match (f.minimum, f.maximum) {
                (Some(min), Some(max)) if n < min || n > max => Some(format!(
                    "Must be {noun} between {} and {}",
                    num(min),
                    num(max)
                )),
                (Some(min), None) if n < min => Some(format!("Must be at least {}", num(min))),
                (None, Some(max)) if n > max => Some(format!("Must be at most {}", num(max))),
                _ => None,
            }
        }
        FieldKind::String => {
            let s = value.as_str()?;
            let chars = s.chars().count() as u64;
            if let Some(min) = f.min_length {
                if chars < min {
                    return Some(format!("Must be at least {min} {}", plural(min, "character")));
                }
            }
            if let Some(max) = f.max_length {
                if chars > max {
                    return Some(format!("Must be at most {max} {}", plural(max, "character")));
                }
            }
            match f.format.as_deref() {
                Some("email") if !is_email(s) => {
                    Some("Must be a valid email address, e.g. user@example.com".to_string())
                }
                Some("uri") if !is_uri(s) => {
                    Some("Must be a valid URI, e.g. https://example.com".to_string())
                }
                // Claude Code parses natural language here by asking Haiku
                // ("tomorrow", "next Monday"); supermux has no model in this
                // path and must not pretend to — so ISO 8601 is what it
                // accepts, and the sentence is Claude Code's own fallback for
                // exactly that case.
                Some("date") if !is_iso_date(s) => Some(
                    "Unable to parse date/time. Please enter in ISO 8601 format manually"
                        .to_string(),
                ),
                Some("date-time") if !is_iso_date_time(s) => Some(
                    "Unable to parse date/time. Please enter in ISO 8601 format manually"
                        .to_string(),
                ),
                _ => None,
            }
        }
        FieldKind::Unsupported => None,
    }
}

fn problem(f: &Field, message: &str) -> Problem {
    Problem {
        field: f.name.clone(),
        message: message.to_string(),
    }
}

/// Absent, `null`, or an empty/whitespace-only string. A `false` boolean and a
/// `0` are ANSWERS, not blanks — the bug that would make "no" unsayable.
fn is_blank(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.trim().is_empty(),
        _ => false,
    }
}

/// `3.0` → `3`, `2.5` → `2.5`. The bound came from JSON, and printing a whole
/// number as `3` is what the terminal does.
fn num(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

fn plural(n: u64, word: &str) -> String {
    if n == 1 {
        word.to_string()
    } else {
        format!("{word}s")
    }
}

/// Deliberately not RFC 5322: one `@`, something either side, a dot in the
/// domain, no whitespace. The same shape the terminal accepts, and the server
/// is the real judge of its own field.
fn is_email(s: &str) -> bool {
    let s = s.trim();
    if s.split_whitespace().count() != 1 {
        return false;
    }
    let mut parts = s.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
}

fn is_uri(s: &str) -> bool {
    let s = s.trim();
    if s.split_whitespace().count() != 1 {
        return false;
    }
    match s.split_once("://") {
        Some((scheme, rest)) => !scheme.is_empty() && !rest.is_empty(),
        // `mailto:someone@example.com` is a URI too.
        None => s
            .split_once(':')
            .is_some_and(|(scheme, rest)| !scheme.is_empty() && !rest.is_empty()),
    }
}

/// `YYYY-MM-DD`, the prefix Claude Code's own `^\d{4}-\d{2}-\d{2}(T|$)` accepts.
fn is_iso_date(s: &str) -> bool {
    let s = s.trim();
    let b = s.as_bytes();
    s.len() == 10
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[7] == b'-'
        && b[8..].iter().all(u8::is_ascii_digit)
}

fn is_iso_date_time(s: &str) -> bool {
    let s = s.trim();
    match s.split_once('T') {
        Some((date, time)) => is_iso_date(date) && time.len() >= 5 && time.as_bytes()[2] == b':',
        None => false,
    }
}

fn first_str<'a>(obj: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| obj.get(*k).and_then(Value::as_str))
        .map(str::trim)
}

/// Trim + cap at `max` CHARS (never bytes — a cut inside a multi-byte char is a
/// panic), appending `…` when cut.
fn clip(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).chain(std::iter::once('…')).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ask() -> ElicitationAsk {
        parse(&json!({
            "mcp_server_name": "deploy-bot",
            "message": "Confirm the release",
            "elicitation_id": "el_1",
            "requested_schema": {
                "type": "object",
                "properties": {
                    "email": {"type": "string", "format": "email", "title": "Notify"},
                    "count": {"type": "integer", "minimum": 1, "maximum": 5},
                    "env": {"type": "string", "enum": ["prod", "staging"], "enumNames": ["Production", "Staging"]},
                    "force": {"type": "boolean"}
                },
                "required": ["email", "env"]
            }
        }))
        .expect("a payload with a server name parses")
    }

    #[test]
    fn an_ask_without_a_server_name_is_refused() {
        // The attribution IS the safety property — an unattributed third-party
        // prompt must never reach a surface.
        assert!(parse(&json!({"message": "give me your password"})).is_none());
    }

    #[test]
    fn the_schema_becomes_typed_controls_in_a_stable_order() {
        let a = ask();
        assert_eq!(a.server, "deploy-bot");
        let kinds: Vec<_> = a.fields.iter().map(|f| (f.name.as_str(), f.kind)).collect();
        // Lexicographic, because the JSON object is parsed into a sorted map —
        // see `schema_fields`. The property that matters is that it never
        // changes: the same ask draws the same form every time.
        assert_eq!(
            kinds,
            vec![
                ("count", FieldKind::Integer),
                ("email", FieldKind::String),
                ("env", FieldKind::Enum),
                ("force", FieldKind::Boolean),
            ]
        );
        assert!(a.fields[1].required && !a.fields[0].required);
        assert_eq!(a.fields[1].title, "Notify");
        assert_eq!(a.fields[2].options[0].label, "Production");
    }

    #[test]
    fn a_required_field_left_blank_is_the_only_thing_it_complains_about() {
        let a = ask();
        let got = validate(&a.fields, json!({"env": "prod"}).as_object().unwrap());
        assert_eq!(
            got,
            vec![Problem {
                field: "email".into(),
                message: "This field is required".into()
            }]
        );
    }

    #[test]
    fn false_and_zero_are_answers_not_blanks() {
        let mut fields = ask().fields;
        for f in &mut fields {
            f.required = true;
        }
        let content = json!({"email": "a@b.co", "count": 0, "env": "prod", "force": false});
        let got = validate(&fields, content.as_object().unwrap());
        // `count: 0` is outside [1,5] and complains about the RANGE; `force:
        // false` complains about nothing at all.
        assert_eq!(
            got,
            vec![Problem {
                field: "count".into(),
                message: "Must be an integer between 1 and 5".into()
            }]
        );
    }

    #[test]
    fn every_format_uses_claude_codes_own_sentence() {
        let a = ask();
        let got = validate(&a.fields, json!({"email": "nope", "env": "prod"}).as_object().unwrap());
        assert_eq!(got[0].message, "Must be a valid email address, e.g. user@example.com");
    }

    #[test]
    fn an_enum_value_outside_the_list_is_refused() {
        let a = ask();
        let got = validate(
            &a.fields,
            json!({"email": "a@b.co", "env": "wherever"}).as_object().unwrap(),
        );
        assert_eq!(got[0].field, "env");
    }

    #[test]
    fn a_valid_answer_has_no_problems() {
        let a = ask();
        let content = json!({"email": "a@b.co", "count": 3, "env": "staging", "force": true});
        assert!(validate(&a.fields, content.as_object().unwrap()).is_empty());
    }

    #[test]
    fn an_unrenderable_property_is_kept_read_only_never_dropped() {
        let a = parse(&json!({
            "mcp_server_name": "s",
            "requested_schema": {"properties": {"blob": {"type": "array"}}, "required": ["blob"]}
        }))
        .unwrap();
        assert_eq!(a.fields[0].kind, FieldKind::Unsupported);
        // …and it can never make the form unanswerable.
        assert!(validate(&a.fields, json!({}).as_object().unwrap()).is_empty());
    }

    #[test]
    fn a_bare_confirmation_carries_no_fields_and_is_still_an_ask() {
        let a = parse(&json!({"mcp_server_name": "s", "message": "Proceed?"})).unwrap();
        assert!(a.fields.is_empty());
        assert!(validate(&a.fields, json!({}).as_object().unwrap()).is_empty());
    }

    #[test]
    fn third_party_text_is_capped_on_every_axis() {
        let long = "x".repeat(5_000);
        let a = parse(&json!({
            "mcp_server_name": long,
            "message": long,
            "requested_schema": {"properties": {"a": {"type": "string", "description": long}}}
        }))
        .unwrap();
        assert!(a.server.chars().count() <= MAX_LABEL + 1);
        assert!(a.message.chars().count() <= MAX_TEXT + 1);
        assert!(a.fields[0].description.as_ref().unwrap().chars().count() <= MAX_TEXT + 1);
    }

    #[test]
    fn a_schema_over_the_field_cap_counts_what_it_left_out() {
        let mut props = Map::new();
        for i in 0..MAX_FIELDS + 3 {
            props.insert(format!("f{i:02}"), json!({"type": "string"}));
        }
        let a = parse(&json!({
            "mcp_server_name": "s",
            "requested_schema": {"properties": Value::Object(props)}
        }))
        .unwrap();
        assert_eq!(a.fields.len(), MAX_FIELDS);
        assert_eq!(a.dropped_fields, 3);
    }
}
