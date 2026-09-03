//! `supermux-message` / `-notify` / `-task` / `-schedule` — the bot→app hook CLIs.
//!
//! **Why these exist at all: permission prompts.** The four capability hooks
//! (`/api/hook/delegate`, `/api/hook/notify`, `/api/hook/board/*`,
//! `/api/hook/schedule/create`) were only ever reachable from a pane as a `curl`
//! line, and `Bash(curl …)` is exactly the shape Claude Code's auto-mode
//! classifier stops on: an unattended bot's message to a teammate hung on a
//! dialog nobody was there to answer. A named wrapper can be pre-approved
//! DETERMINISTICALLY instead — `Bash(supermux-message *)` in the per-session
//! `--settings` overlay skips the classifier entirely — which is the same trade
//! `supermux-memory` already made ([`crate::bot_memory::install_scripts`]).
//!
//! **They add no authority.** Each wrapper is an `exec` of THIS server binary
//! with the hidden `__hook-cli` subcommand; it reads `SUPERMUX_URL` /
//! `SUPERMUX_SESSION` / `SUPERMUX_HOOK_TOKEN` from the pane's own environment and
//! POSTs the SAME body the skill's `curl` posted, to the SAME endpoint, with the
//! SAME `X-Supermux-Hook-Token` header. The hook token already authorized those
//! routes, and every scope rule (own pane, own issue, same company) is enforced
//! server-side, so this is a spelling change, not a new door.
//!
//! The arg→(endpoint, body) mapping is [`plan`], a pure function, so the shape of
//! every call is testable without a server, a pane, or a token.

use std::path::Path;
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::{json, Map, Value};

/// Header the wrappers set to the pane's `$SUPERMUX_HOOK_TOKEN` — the same one
/// `hooks.rs`, the board/scheduler hooks and the `$EDITOR` bridge use.
const HOOK_TOKEN_HEADER: &str = "X-Supermux-Hook-Token";

/// Client-side cap on the one POST. Bounded so a wedged/unreachable server can
/// never hang the pane the bot is thinking in.
const CLIENT_TIMEOUT: Duration = Duration::from_secs(30);

/// The wrapper names installed into `<data_dir>/bin`. ONE list: the installer
/// writes these, [`crate::sessions::connector_config`] allow-lists these, and
/// [`plan`] dispatches on these — so a fifth wrapper cannot be half-added.
pub const WRAPPERS: [&str; 4] = [
    "supermux-message",
    "supermux-notify",
    "supermux-task",
    "supermux-schedule",
];

/// One resolved call: which hook endpoint, and the exact JSON body to POST.
#[derive(Debug, PartialEq)]
pub struct Call {
    /// Path under the server base URL (always a `/api/hook/…` route).
    pub path: &'static str,
    /// The request body, `session` already set to the authenticated pane.
    pub body: Value,
}

/// Map one wrapper invocation to its endpoint + body. `cmd` is the wrapper name,
/// `argv` everything the user typed after it, `session` the pane's
/// `$SUPERMUX_SESSION` (which is what the hook token authenticates — a payload
/// can never name another session, so we always write it ourselves).
///
/// Every command also takes `--json <body>` as an escape hatch: for a payload
/// field the positional form does not cover (a schedule's `done_action`, say) the
/// bot hands over the whole object and we only stamp `session` into it.
pub fn plan(cmd: &str, argv: &[String], session: &str) -> Result<Call> {
    match cmd {
        "supermux-message" => plan_message(argv, session),
        "supermux-notify" => plan_notify(argv, session),
        "supermux-task" => plan_task(argv, session),
        "supermux-schedule" => plan_schedule(argv, session),
        other => Err(anyhow!(
            "unknown command '{other}' (expected one of: {})",
            WRAPPERS.join(", ")
        )),
    }
}

/// `supermux-message <teammate> <prompt…>` → `/api/hook/delegate`.
fn plan_message(argv: &[String], session: &str) -> Result<Call> {
    const USAGE: &str = "usage: supermux-message <teammate> <prompt…>";
    if let Some(body) = json_escape_hatch(argv, session)? {
        return Ok(Call { path: "/api/hook/delegate", body });
    }
    let (to, rest) = argv
        .split_first()
        .ok_or_else(|| anyhow!("a teammate name is required — {USAGE}"))?;
    if rest.is_empty() {
        return Err(anyhow!("a prompt is required — {USAGE}"));
    }
    Ok(Call {
        path: "/api/hook/delegate",
        body: json!({ "session": session, "to": to, "prompt": rest.join(" ") }),
    })
}

/// `supermux-notify <message…> [--title <t>]` → `/api/hook/notify`.
///
/// The endpoint requires a non-empty `title`; the natural thing a bot types is
/// the sentence, so the positional words are the BODY and the title defaults to
/// this bot's own name — which is precisely what the human needs on a lock
/// screen to know who is pinging ("acme-a — the 08:00 release went green").
fn plan_notify(argv: &[String], session: &str) -> Result<Call> {
    const USAGE: &str = "usage: supermux-notify <message…> [--title <title>]";
    if let Some(body) = json_escape_hatch(argv, session)? {
        return Ok(Call { path: "/api/hook/notify", body });
    }
    let mut title: Option<String> = None;
    let mut words: Vec<&str> = Vec::new();
    let mut it = argv.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--title" => {
                title = Some(
                    it.next()
                        .ok_or_else(|| anyhow!("--title needs a value — {USAGE}"))?
                        .clone(),
                );
            }
            word => words.push(word),
        }
    }
    if words.is_empty() {
        return Err(anyhow!("a message is required — {USAGE}"));
    }
    Ok(Call {
        path: "/api/hook/notify",
        body: json!({
            "session": session,
            "title": title.unwrap_or_else(|| session.to_string()),
            "body": words.join(" "),
        }),
    })
}

/// `supermux-task <comment|done|needs-input|check|link> …` → `/api/hook/board/*`.
fn plan_task(argv: &[String], session: &str) -> Result<Call> {
    const USAGE: &str = "usage: supermux-task done | needs-input <question…> | comment <text…> | check <item_id> [off] | link pr|commit <ref> [label…]";
    let (sub, rest) = argv
        .split_first()
        .ok_or_else(|| anyhow!("a subcommand is required — {USAGE}"))?;
    // The endpoint is chosen by the SUBCOMMAND, so `--json` rides behind it
    // (`supermux-task comment --json '{"body":"…"}'`), unlike the single-endpoint
    // wrappers where it can stand alone.
    let path = match sub.as_str() {
        "comment" => "/api/hook/board/comment",
        "done" => "/api/hook/board/status",
        "needs-input" => "/api/hook/board/needs-input",
        "check" => "/api/hook/board/check",
        "link" => "/api/hook/board/link",
        other => return Err(anyhow!("unknown subcommand '{other}' — {USAGE}")),
    };
    if let Some(body) = json_escape_hatch(rest, session)? {
        return Ok(Call { path, body });
    }
    let body = match sub.as_str() {
        "comment" => {
            if rest.is_empty() {
                return Err(anyhow!("comment needs text — {USAGE}"));
            }
            json!({ "session": session, "body": rest.join(" ") })
        }
        // `done` is the status hook with the one status an agent reaches for at
        // the end of its task; any other column is the human's move on the board.
        "done" => json!({ "session": session, "status": "done" }),
        "needs-input" => {
            if rest.is_empty() {
                return Err(anyhow!("needs-input needs a question — {USAGE}"));
            }
            json!({ "session": session, "question": rest.join(" ") })
        }
        "check" => {
            let id: i64 = rest
                .first()
                .ok_or_else(|| anyhow!("check needs an item id — {USAGE}"))?
                .parse()
                .map_err(|_| anyhow!("check needs a NUMERIC item id — {USAGE}"))?;
            let done = match rest.get(1).map(String::as_str) {
                None => true,
                Some("off") => false,
                Some(other) => {
                    return Err(anyhow!("check's second argument is 'off' or nothing (got '{other}') — {USAGE}"))
                }
            };
            json!({ "session": session, "item_id": id, "done": done })
        }
        "link" => {
            let kind = rest
                .first()
                .ok_or_else(|| anyhow!("link needs a kind ('pr' or 'commit') — {USAGE}"))?;
            let r#ref = rest
                .get(1)
                .ok_or_else(|| anyhow!("link needs a ref — {USAGE}"))?;
            json!({
                "session": session,
                "kind": kind,
                "ref": r#ref,
                "label": rest.get(2..).unwrap_or(&[]).join(" "),
            })
        }
        _ => unreachable!("the subcommand was validated above"),
    };
    Ok(Call { path, body })
}

/// `supermux-schedule <title> <schedule_expr> <prompt…>` → `/api/hook/schedule/create`.
/// Those three are the whole of what the create handler requires; anything else
/// it accepts (`done_action`, a step chain) goes through `--json`.
fn plan_schedule(argv: &[String], session: &str) -> Result<Call> {
    const USAGE: &str =
        "usage: supermux-schedule <title> <schedule_expr> <prompt…>   (e.g. supermux-schedule 'Deploy check' 'every weekday at 08:00' Check the 08:00 deploy)";
    if let Some(body) = json_escape_hatch(argv, session)? {
        return Ok(Call { path: "/api/hook/schedule/create", body });
    }
    let title = argv
        .first()
        .ok_or_else(|| anyhow!("a title is required — {USAGE}"))?;
    let expr = argv
        .get(1)
        .ok_or_else(|| anyhow!("a schedule expression is required — {USAGE}"))?;
    let prompt = argv.get(2..).unwrap_or(&[]);
    if prompt.is_empty() {
        return Err(anyhow!("a prompt is required — {USAGE}"));
    }
    Ok(Call {
        path: "/api/hook/schedule/create",
        body: json!({
            "session": session,
            "title": title,
            "schedule_expr": expr,
            "prompt": prompt.join(" "),
        }),
    })
}

/// The shared `--json <body>` escape hatch. Returns the parsed object with
/// `session` STAMPED to the authenticated pane (never taken from the payload —
/// the hook token binds it anyway, so a bot's own `session` field could only ever
/// 401), or `None` when the caller used the positional form.
fn json_escape_hatch(argv: &[String], session: &str) -> Result<Option<Value>> {
    let Some(i) = argv.iter().position(|a| a == "--json") else {
        return Ok(None);
    };
    let raw = argv
        .get(i + 1)
        .ok_or_else(|| anyhow!("--json needs a JSON object"))?;
    let parsed: Value = serde_json::from_str(raw).map_err(|e| anyhow!("--json is not valid JSON: {e}"))?;
    let mut obj: Map<String, Value> = match parsed {
        Value::Object(o) => o,
        _ => return Err(anyhow!("--json must be a JSON object")),
    };
    obj.insert("session".to_string(), Value::String(session.to_string()));
    Ok(Some(Value::Object(obj)))
}

/// Install (idempotently) one wrapper per [`WRAPPERS`] entry into
/// `<data_dir>/bin`, each an `exec` of the running server binary with the hidden
/// `__hook-cli` subcommand — so a wrapper is always version-matched to the server
/// that installed it, exactly like `supermux-memory`.
///
/// Best-effort: a write failure is logged and costs a bot the deterministic grant
/// (it falls back to the `curl` in the skill, prompt and all), never the server.
pub fn install_scripts(data_dir: &Path) {
    let bin_dir = data_dir.join("bin");
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "supermux-server".to_string());
    for name in WRAPPERS {
        let path = bin_dir.join(name);
        let body = format!("#!/bin/sh\nexec \"{exe}\" __hook-cli {name} \"$@\"\n");
        if let Err(e) = crate::bot_memory::write_executable(&bin_dir, &path, &body) {
            tracing::warn!(path = %path.display(), error = %e, "could not install the {name} hook wrapper");
        }
    }
}

/// The `__hook-cli <name> …` subcommand body, dispatched from `main` before any
/// server boot (no DB, no listener) — the `__memory-save` discipline. Prints the
/// hook's response body on success; on a non-2xx (or a missing env / bad args)
/// it returns an `Err` the caller prints and exits non-zero on, so `set -e`-style
/// agent scripts and the pane's own eyes both see the failure.
pub async fn run(argv: &[String]) -> Result<()> {
    let cmd = argv
        .first()
        .cloned()
        .ok_or_else(|| anyhow!("__hook-cli needs a command name"))?;
    run_inner(&cmd, argv.get(1..).unwrap_or(&[]))
        .await
        .map_err(|e| anyhow!("{cmd}: {e}"))
}

async fn run_inner(cmd: &str, argv: &[String]) -> Result<()> {
    let url = env_required("SUPERMUX_URL")?;
    let session = env_required("SUPERMUX_SESSION")?;
    let token = env_required("SUPERMUX_HOOK_TOKEN")?;
    let call = plan(cmd, argv, &session)?;

    // Accept invalid certs: `SUPERMUX_URL` may be the https self-signed bind and
    // this is the box calling its OWN listener — the connection never leaves the
    // host. Same justification as the `$EDITOR` bridge.
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(CLIENT_TIMEOUT)
        .build()
        .map_err(|e| anyhow!("building http client: {e}"))?;
    let res = client
        .post(format!("{}{}", url.trim_end_matches('/'), call.path))
        .header(HOOK_TOKEN_HEADER, &token)
        .json(&call.body)
        .send()
        .await
        .map_err(|e| anyhow!("POST {}: {e}", call.path))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        // The hook endpoints answer a refusal with a readable sentence; hand it
        // back verbatim so the agent can act on it instead of retrying blind.
        return Err(anyhow!("{status} from {} — {text}", call.path));
    }
    println!("{text}");
    Ok(())
}

/// Read an env var, erroring if missing/empty. All three are injected per-pane by
/// `sessions::lifecycle`; a missing one means this is not a supermux pane.
fn env_required(key: &str) -> Result<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| anyhow!("{key} is not set (run this inside a supermux session)"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(|w| w.to_string()).collect()
    }

    #[test]
    fn message_joins_the_prompt_and_sends_as_this_session() {
        let call = plan(
            "supermux-message",
            &args(&["billing-bot", "reconcile", "invoice", "#91"]),
            "acme-a",
        )
        .unwrap();
        assert_eq!(call.path, "/api/hook/delegate");
        assert_eq!(
            call.body,
            json!({ "session": "acme-a", "to": "billing-bot", "prompt": "reconcile invoice #91" })
        );
    }

    #[test]
    fn notify_titles_with_the_bot_name_unless_told_otherwise() {
        let call = plan("supermux-notify", &args(&["release", "is", "green"]), "acme-a").unwrap();
        assert_eq!(call.path, "/api/hook/notify");
        assert_eq!(
            call.body,
            json!({ "session": "acme-a", "title": "acme-a", "body": "release is green" })
        );
        // `--title` anywhere wins, and its value never leaks into the body.
        let call = plan(
            "supermux-notify",
            &args(&["release", "is", "green", "--title", "Deploy done"]),
            "acme-a",
        )
        .unwrap();
        assert_eq!(
            call.body,
            json!({ "session": "acme-a", "title": "Deploy done", "body": "release is green" })
        );
    }

    #[test]
    fn task_maps_each_subcommand_to_its_board_endpoint() {
        let done = plan("supermux-task", &args(&["done"]), "acme-a").unwrap();
        assert_eq!(done.path, "/api/hook/board/status");
        assert_eq!(done.body, json!({ "session": "acme-a", "status": "done" }));

        let c = plan("supermux-task", &args(&["comment", "tests", "pass"]), "acme-a").unwrap();
        assert_eq!(c.path, "/api/hook/board/comment");
        assert_eq!(c.body, json!({ "session": "acme-a", "body": "tests pass" }));

        let n = plan("supermux-task", &args(&["needs-input", "drop", "the", "column?"]), "acme-a").unwrap();
        assert_eq!(n.path, "/api/hook/board/needs-input");
        assert_eq!(n.body, json!({ "session": "acme-a", "question": "drop the column?" }));

        let tick = plan("supermux-task", &args(&["check", "42"]), "acme-a").unwrap();
        assert_eq!(tick.path, "/api/hook/board/check");
        assert_eq!(tick.body, json!({ "session": "acme-a", "item_id": 42, "done": true }));
        let untick = plan("supermux-task", &args(&["check", "42", "off"]), "acme-a").unwrap();
        assert_eq!(untick.body, json!({ "session": "acme-a", "item_id": 42, "done": false }));

        let link = plan(
            "supermux-task",
            &args(&["link", "pr", "https://example.test/pull/1", "the", "fix"]),
            "acme-a",
        )
        .unwrap();
        assert_eq!(link.path, "/api/hook/board/link");
        assert_eq!(
            link.body,
            json!({
                "session": "acme-a",
                "kind": "pr",
                "ref": "https://example.test/pull/1",
                "label": "the fix",
            })
        );
    }

    #[test]
    fn schedule_takes_title_expression_then_prompt() {
        let call = plan(
            "supermux-schedule",
            &args(&["Deploy check", "every weekday at 08:00", "Check", "the", "deploy"]),
            "acme-a",
        )
        .unwrap();
        assert_eq!(call.path, "/api/hook/schedule/create");
        assert_eq!(
            call.body,
            json!({
                "session": "acme-a",
                "title": "Deploy check",
                "schedule_expr": "every weekday at 08:00",
                "prompt": "Check the deploy",
            })
        );
    }

    #[test]
    fn the_json_escape_hatch_always_stamps_the_authenticated_session() {
        // A field the positional form does not cover…
        let call = plan(
            "supermux-schedule",
            &args(&[
                "--json",
                r#"{"title":"CI","schedule_expr":"in 20m","prompt":"look","done_action":"notify"}"#,
            ]),
            "acme-a",
        )
        .unwrap();
        assert_eq!(call.path, "/api/hook/schedule/create");
        assert_eq!(call.body["done_action"], json!("notify"));
        assert_eq!(call.body["session"], json!("acme-a"));

        // …and a payload that names ANOTHER session is overwritten, never sent.
        let call = plan(
            "supermux-message",
            &args(&["--json", r#"{"session":"someone-else","to":"b","prompt":"hi"}"#]),
            "acme-a",
        )
        .unwrap();
        assert_eq!(call.body["session"], json!("acme-a"));

        // On the board wrappers the escape hatch rides BEHIND the subcommand,
        // because the subcommand is what picks the endpoint.
        let call = plan(
            "supermux-task",
            &args(&["comment", "--json", r#"{"body":"multi\nline"}"#]),
            "acme-a",
        )
        .unwrap();
        assert_eq!(call.path, "/api/hook/board/comment");
        assert_eq!(call.body, json!({ "session": "acme-a", "body": "multi\nline" }));
    }

    #[test]
    fn a_missing_argument_is_a_usage_error_not_a_half_built_call() {
        for (cmd, argv) in [
            ("supermux-message", vec!["billing-bot"]),
            ("supermux-notify", vec![]),
            ("supermux-task", vec![]),
            ("supermux-task", vec!["check"]),
            ("supermux-task", vec!["link", "pr"]),
            ("supermux-schedule", vec!["title only"]),
        ] {
            let err = plan(cmd, &args(&argv), "acme-a").unwrap_err().to_string();
            assert!(err.contains("usage"), "{cmd} {argv:?} → {err}");
        }
        // An unknown wrapper name and an unknown board subcommand are refused too.
        assert!(plan("supermux-nope", &[], "acme-a").is_err());
        assert!(plan("supermux-task", &args(&["archive"]), "acme-a").is_err());
        // A non-numeric acceptance id is refused rather than silently sent.
        assert!(plan("supermux-task", &args(&["check", "x"]), "acme-a").is_err());
    }
}
