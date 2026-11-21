//! Opt-in, one-turn provider stream for integrations. The terminal and transcript pathways stay separate.
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

struct Wire {
    _child: Child,
    input: ChildStdin,
    output: Lines<BufReader<ChildStdout>>,
}

impl Wire {
    fn start(bin: &str, args: &[&str]) -> Result<Self> {
        // Only the official CLI can use its saved sign-in. Never inherit API keys or provider overrides.
        let mut cmd = Command::new(bin);
        cmd.args(args).env_clear().kill_on_drop(true);
        for key in [
            "HOME",
            "USERPROFILE",
            "PATH",
            "TMPDIR",
            "TMP",
            "TEMP",
            "CODEX_HOME",
            "CLAUDE_CONFIG_DIR",
        ] {
            if let Some(value) = std::env::var_os(key) {
                cmd.env(key, value);
            }
        }
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .current_dir(std::env::temp_dir())
            .spawn()
            .context("start the official provider CLI")?;
        let input = child.stdin.take().context("provider stdin")?;
        let output = BufReader::new(child.stdout.take().context("provider stdout")?).lines();
        Ok(Self {
            _child: child,
            input,
            output,
        })
    }

    async fn send(&mut self, request: Value) -> Result<()> {
        self.input
            .write_all(format!("{request}\n").as_bytes())
            .await?;
        Ok(())
    }

    async fn next(&mut self) -> Result<Option<Value>> {
        while let Some(line) = self.output.next_line().await? {
            if let Ok(message) = serde_json::from_str(&line) {
                return Ok(Some(message));
            }
        }
        Ok(None)
    }

    async fn rpc(&mut self, id: u32, method: &str, params: Value) -> Result<Value> {
        self.send(json!({"id": id, "method": method, "params": params}))
            .await?;
        while let Some(frame) = self.next().await? {
            if frame["id"] == id {
                return frame
                    .get("result")
                    .cloned()
                    .context("provider rejected its request");
            }
        }
        bail!("provider closed before answering its request")
    }
}

fn claude_delta(frame: &Value) -> Option<&str> {
    let e = &frame["event"];
    if frame["type"] == "stream_event"
        && frame["parent_tool_use_id"].is_null()
        && e["type"] == "content_block_delta"
        && e["delta"]["type"] == "text_delta"
    {
        return e["delta"]["text"].as_str();
    }
    None
}

fn codex_delta<'a>(
    frame: &'a Value,
    thread: &Value,
    commentary: &std::collections::HashSet<String>,
) -> Option<&'a str> {
    let p = &frame["params"];
    if frame["method"] == "item/agentMessage/delta"
        && &p["threadId"] == thread
        && !commentary.contains(p["itemId"].as_str()?)
    {
        return p["delta"].as_str();
    }
    None
}

async fn emit(kind: &str, text: &str) -> Result<()> {
    let mut out = tokio::io::stdout();
    out.write_all(format!("{}\n", json!({"type":kind,"text":text})).as_bytes())
        .await?;
    out.flush().await?;
    Ok(())
}

async fn claude(model: &str, effort: &str, prompt: &str) -> Result<String> {
    if std::env::var("SUPERMUX_CLAUDE_USAGE_CREDITS_OFF").as_deref() != Ok("1") {
        bail!("turn off Usage credits in Claude before enabling subscription reply streaming");
    }
    let mut login = Wire::start("claude", &["auth", "status", "--json"])?;
    login.input.shutdown().await?;
    let mut auth = String::new();
    while let Some(line) = login.output.next_line().await? {
        auth.push_str(&line);
    }
    let auth: Value = serde_json::from_str(&auth).context("read Claude sign-in status")?;
    if auth["loggedIn"] != true
        || auth["authMethod"] != "claude.ai"
        || auth["apiProvider"] != "firstParty"
    {
        bail!("Claude does not have a subscription login");
    }
    let mut wire = Wire::start(
        "claude",
        &[
            "--print",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--no-session-persistence",
            "--setting-sources",
            "",
            "--tools",
            "",
            "--strict-mcp-config",
            "--mcp-config",
            r#"{"mcpServers":{}}"#,
            "--permission-mode",
            "dontAsk",
            "--model",
            model,
            "--effort",
            effort,
        ],
    )?;
    wire.input.write_all(prompt.as_bytes()).await?;
    wire.input.shutdown().await?;
    while let Some(frame) = wire.next().await? {
        if let Some(text) = claude_delta(&frame) {
            emit("delta", text).await?;
        }
        if frame["type"] == "result" {
            if frame["is_error"] == false {
                if let Some(text) = frame["result"]
                    .as_str()
                    .filter(|text| !text.trim().is_empty())
                {
                    return Ok(text.to_owned());
                }
            }
            break;
        }
    }
    bail!("Claude did not complete a reply")
}

async fn codex(model: &str, effort: &str, prompt: &str) -> Result<String> {
    let mut wire = Wire::start(
        "codex",
        &[
            "--no-daemon",
            "--disable",
            "shell_tool",
            "-c",
            r#"web_search="disabled""#,
            "-c",
            "mcp_servers={}",
            "-c",
            r#"forced_login_method="chatgpt""#,
            "-c",
            r#"model_provider="openai""#,
            "app-server",
            "--listen",
            "stdio://",
        ],
    )?;
    wire.rpc(
        1,
        "initialize",
        json!({"clientInfo":{"name":"supermux-reply","version":"1"}}),
    )
    .await?;
    wire.send(json!({"method":"initialized"})).await?;
    if wire
        .rpc(2, "account/read", json!({"refreshToken":false}))
        .await?["account"]["type"]
        != "chatgpt"
    {
        bail!("Codex does not have a ChatGPT login");
    }
    let usage = wire.rpc(3, "account/rateLimits/read", json!({})).await?;
    let limits = usage["rateLimitsByLimitId"]
        .get("codex")
        .unwrap_or(&usage["rateLimits"]);
    if limits["credits"]["hasCredits"] == true
        || !limits["rateLimitReachedType"].is_null()
        || limits["primary"]["usedPercent"].as_f64().unwrap_or(100.) >= 100.
        || limits["secondary"]["usedPercent"].as_f64().unwrap_or(0.) >= 100.
    {
        bail!("Codex has no verified included allowance or has a paid credit balance");
    }
    let thread = wire.rpc(4, "thread/start", json!({
        "cwd":std::env::temp_dir(), "model":model, "sandbox":"read-only", "approvalPolicy":"never", "ephemeral":true
    })).await?;
    let id = &thread["thread"]["id"];
    if !id.is_string() {
        bail!("Codex did not open a thread");
    }
    // Do not wait for the RPC response before processing early turn notifications.
    wire.send(json!({"id":5,"method":"turn/start","params":{
        "threadId":id,"effort":effort,"input":[{"type":"text","text":prompt}]
    }}))
    .await?;
    let mut commentary = std::collections::HashSet::new();
    let mut final_text = None;
    while let Some(frame) = wire.next().await? {
        if frame["id"] == 5 && !frame["error"].is_null() {
            break;
        }
        let e = &frame["params"];
        if &e["threadId"] != id {
            continue;
        }
        if frame["method"] == "item/started" && e["item"]["phase"] == "commentary" {
            if let Some(item) = e["item"]["id"].as_str() {
                commentary.insert(item.to_owned());
            }
        } else if let Some(text) = codex_delta(&frame, id, &commentary) {
            emit("delta", text).await?;
        } else if frame["method"] == "item/completed"
            && e["item"]["type"] == "agentMessage"
            && e["item"]["phase"] != "commentary"
        {
            final_text = e["item"]["text"].as_str().map(str::to_owned);
        } else if frame["method"] == "turn/completed" {
            if e["turn"]["status"] == "completed" {
                return final_text
                    .filter(|text| !text.trim().is_empty())
                    .context("Codex returned no answer text");
            }
            break;
        }
    }
    bail!("Codex did not complete a reply")
}

pub async fn run(mut args: impl Iterator<Item = String>) -> Result<()> {
    let usage = "usage: supermux-server stream-reply <claude|codex> <model> <low|medium|high|xhigh> < prompt.txt";
    let provider = args.next().context(usage)?;
    let model = args.next().context(usage)?;
    let effort = args.next().context(usage)?;
    if !matches!(provider.as_str(), "claude" | "codex")
        || !matches!(effort.as_str(), "low" | "medium" | "high" | "xhigh")
        || model.is_empty()
        || model.len() > 64
        || !model
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-._".contains(&c))
        || args.next().is_some()
    {
        bail!(usage);
    }
    let mut prompt = String::new();
    tokio::io::stdin()
        .take(65537)
        .read_to_string(&mut prompt)
        .await?;
    if prompt.trim().is_empty() || prompt.len() > 65536 {
        bail!("prompt must be between 1 and 65536 bytes");
    }
    let reply = tokio::time::timeout(std::time::Duration::from_secs(120), async {
        if provider == "claude" {
            claude(&model, &effort, &prompt).await
        } else {
            codex(&model, &effort, &prompt).await
        }
    })
    .await
    .context("provider reply timed out")??;
    emit("final", &reply).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_only_relays_primary_answer_text() {
        let mut frame = json!({"type":"stream_event","parent_tool_use_id":null,"event":{
            "type":"content_block_delta","delta":{"type":"text_delta","text":"één"}
        }});
        assert_eq!(claude_delta(&frame), Some("één"));
        frame["parent_tool_use_id"] = json!("other");
        assert!(claude_delta(&frame).is_none());
        frame["parent_tool_use_id"] = Value::Null;
        frame["event"]["delta"]["type"] = json!("thinking_delta");
        assert!(claude_delta(&frame).is_none());
    }

    #[test]
    fn codex_only_relays_text_from_the_selected_thread() {
        let frame = json!({"method":"item/agentMessage/delta","params":{"threadId":"here","itemId":"msg","delta":"two"}});
        let mut commentary = std::collections::HashSet::new();
        assert_eq!(
            codex_delta(&frame, &json!("here"), &commentary),
            Some("two")
        );
        assert!(codex_delta(&frame, &json!("elsewhere"), &commentary).is_none());
        commentary.insert("msg".into());
        assert!(codex_delta(&frame, &json!("here"), &commentary).is_none());
    }
}
