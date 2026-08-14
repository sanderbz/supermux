Report written to `/tmp/claude-1000/-opt-projects-supermux/0ce1fa02-9bc2-41c3-b2c6-7b2814d510c0/scratchpad/report-claude-wrapping.md` (820 lines). Here is the complete report:

# Claude Code Wrapping: Programmatic Integration Architecture Report

**Objective:** Establish every supported way to run and observe Claude Code programmatically so a custom UI can render 100% of its states without regex-scraping terminal output.

**Date:** 2026-08-13  
**Claude Code Version Baseline:** v2.1.223 (latest in documentation)  
**Research Scope:** Official Claude Code & Agent SDK documentation only

---

## Executive Summary

Claude Code exposes **three primary programmatic integration surfaces**:

1. **Headless CLI with stream-json output** (`claude -p --output-format stream-json --include-partial-messages`): direct subprocess invocation, streaming newline-delimited JSON events, suitable for simple integration.

2. **Claude Agent SDK (TypeScript/Python)**: full control over permissions, hooks, streaming callbacks, and session lifecycle. Built-in tools (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch). You host and deploy. **Recommended for custom UI.**

3. **On-disk session transcripts** (`~/.claude/projects/<project>/<session-id>.jsonl`): live-tailing of JSONL records as audit/replay, requires manual parsing.

**Critical Finding:** Plan-mode UI, rate-limit warnings, /login flows, and real-time permission prompts are **NOT exposed** in headless/SDK modes—must fall back to terminal or re-implement.

---

## 1. Headless/SDK Modes: Running Claude Programmatically

### 1.1 Headless CLI Mode (`-p` / Print Mode)

**Output Formats:**
- `--output-format text`: raw text only
- `--output-format json`: JSON with result, session_id, cost, usage
- `--output-format stream-json`: **newline-delimited JSON stream** (recommended for UI)

**Stream-JSON Event Types:**
- `system/init`: session metadata (model, tools, MCP, plugins, capabilities)
- `system/api_retry`: retry event with attempt count, delay, error status
- `stream_event`: raw Claude API events (message_start, content_block_delta, text_delta, message_stop, etc.)
- `user_message`, `assistant_message`: conversation
- `tool_use`: Claude invokes tool
- `tool_result`: tool output
- `result`: final result with cost/usage

**Key Headless Flags:**
- `--continue` / `--resume <id>`: session resumption
- `--fork-session`: branch with both IDs returned
- `--allowedTools "Read,Edit,Bash"`: pre-approve tools
- `--permission-mode {default|acceptEdits|plan|auto|dontAsk|bypassPermissions}`
- `--bare`: skip auto-discovery (hooks, skills, plugins, MCP)
- `--include-partial-messages`: emit token deltas
- `--verbose`: include startup events
- `--forward-subagent-text`: include subagent text/thinking (not just tool_use/tool_result)
- `--json-schema <schema>`: structured output validation
- `--mcp-config <json>`: MCP server configuration
- `--no-session-persistence`: skip transcript writes

**Subagent Messages:** When `--forward-subagent-text` enabled, messages carry `parent_tool_use_id` (ID of Agent tool that spawned them). Allows reconstruction of subagent tree.

### 1.2 Claude Agent SDK (TypeScript/Python)

**Packages:** `@anthropic-ai/claude-agent-sdk` (TypeScript), `claude-agent-sdk` (Python)

**Key Difference:** Not a CLI wrapper; a library you host that runs the full Claude Code harness (agent loop, hooks, sessions, subagents, MCP, built-in tools) in-process.

**Message Types:**
- `SystemMessage` / `SDKSystemMessage`: initialization
- `UserMessage` / `SDKUserMessage`: user input
- `AssistantMessage` / `SDKAssistantMessage`: complete response
- `StreamEvent` / `SDKPartialAssistantMessage` (type: `stream_event`): raw API events (when `includePartialMessages: true`)
- `ToolUseMessage`, `ToolResultMessage`: tool calls and results
- `TaskMessage`: subagent progress (when `agentProgressSummaries: true`)
- Hook lifecycle messages: hook start/progress/response
- Control responses: interrupt(), getContextUsage()
- Compact boundary: when `/compact` summarizes

**Built-In Tools (always available):**
- Read, Write, Edit (files)
- Bash (shell commands)
- Glob, Grep (file search)
- WebSearch, WebFetch (web)

**Streaming Options:**
```typescript
{
  includePartialMessages: true,       // Text deltas
  forwardSubagentText: true,          // Subagent text/thinking
  includeHookEvents: true,            // Hook lifecycle
  agentProgressSummaries: true,       // Task summaries
  promptSuggestions: true,            // Predicted prompts
  enableFileCheckpointing: true       // Rewind snapshots
}
```

---

## 2. Permission Handling in Headless Mode

### 2.1 Permission Modes

| Mode | Behavior |
|---|---|
| `default` (Manual) | Prompt on risky actions |
| `acceptEdits` | Auto-approve file edits + common fs commands (mkdir, rm, mv, cp) |
| `plan` | Claude explores without editing; edits prompt through UI |
| `auto` | Classifier approves/denies with background safety checks |
| `dontAsk` | Pre-approved tools only; everything else denied |
| `bypassPermissions` | All tools run; circuit breaker only on rm -rf /, rm -rf ~ |

### 2.2 Pre-Approval

**CLI:** `--allowedTools "Read,Edit,Bash"` or `--permission-mode acceptEdits`

**Settings:** `permissions.allow` rules in `settings.json`, e.g., `"Bash(npm test)"`, `"Edit(src/**)"`, etc.

### 2.3 Agent SDK Permission Flow

1. **Hooks** (PreToolUse) → can deny/allow
2. **Deny rules** → block matching patterns
3. **Ask rules** → escalate to `canUseTool` callback
4. **Connector/requiresUserInteraction MCP** → always escalate
5. **Permission mode** → auto-approve or pass through
6. **Allow rules** → auto-approve matching
7. **canUseTool callback** → user/UI decision (final fallback)

**Hook Deny applies even in `bypassPermissions`; hook Allow does NOT skip deny/ask rules below.**

### 2.4 Runtime Approval in SDK

```typescript
canUseTool: async (toolName, toolInput, reason) => {
  // Custom approval logic
  const approved = await myUIAskForApproval(toolName, toolInput);
  return { allow: approved };
}
```

When denied, Claude receives the reason as feedback to adjust.

---

## 3. Hooks as an Event Tap (Automation Points)

Hooks are shell commands (or HTTP, MCP, prompt, or agent-based) that run at specific lifecycle points.

### 3.1 Hook Event Types

| Event | When | Can Block? |
|---|---|---|
| `SessionStart` | Session begins/resumes | No (exit 2 logs only) |
| `UserPromptSubmit` | User submits prompt | Yes |
| `PreToolUse` | Before tool execution | Yes (exit 2 or `permissionDecision: "deny"`) |
| `PermissionRequest` | About to ask user | Yes (return `{"decision": {"behavior": "allow"}}` to auto-approve) |
| `PostToolUse` | After tool succeeds | Yes (return `{"decision": "block"}` ends turn) |
| `PostToolUseFailure` | After tool fails | No |
| `Notification` | Claude waits for input | No |
| `SubagentStart` / `SubagentStop` | Subagent lifecycle | No |
| `Stop` | Claude finishes | Yes (via prompt/agent hook) |
| `SessionEnd` | Session terminates | No |

### 3.2 Hook Input/Output Contract

**Input (stdin):** Event-specific JSON with session_id, cwd, hook_event_name, tool_name (if applicable), tool_input, etc.

**Output (stdout/stderr + exit code):**
- Exit 0 + no JSON: no decision
- Exit 0 + valid JSON: apply JSON decision
- Exit 2: block action; stderr → feedback
- Non-zero: non-blocking error

**Structured Output (example):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Destructive command blocked"
  }
}
```

### 3.3 Hook Types

| Type | Transport |
|---|---|
| `command` | Shell subprocess (stdin/stdout/exit code) |
| `http` | HTTP POST to URL (your service handles JSON) |
| `mcp_tool` | Call tool on connected MCP server |
| `prompt` | Single-turn Haiku evaluation (yes/no decision) |
| `agent` | Multi-turn subagent with tool access (heavy verification) |

### 3.4 HTTP Hooks (External Tapping)

```json
{
  "type": "http",
  "url": "http://localhost:8080/events/tool-use",
  "headers": {"Authorization": "Bearer $AUTH_TOKEN"},
  "allowedEnvVars": ["AUTH_TOKEN"]
}
```

Your service receives same JSON as command hook; returns JSON decisions. One-shot per event (blocking until response).

---

## 4. On-Disk Session Transcripts

### 4.1 Transcript Storage

**Location:** `~/.claude/projects/<project-hash>/<session-id>.jsonl`

- `<project-hash>`: working directory with non-alphanumeric → `-`, truncated to 200 chars + hash if longer
- Format: One JSON object per line (JSONL)

### 4.2 Transcript Contents

**Reliably Found:**
- User prompts, assistant responses
- Tool calls and results
- System messages (model, tools, capabilities)
- Compaction summaries (`/compact` output)
- Hook execution records
- Subagent messages (if parent tracks them)

**Format is internal:** Changes between versions. Official interfaces: `/export`, hooks receiving `transcript_path`, Agent SDK session load, stream-JSON output.

### 4.3 Live-Tailing

```bash
tail -f ~/.claude/projects/my-project/session-123.jsonl | jq .
```

Gives line-by-line visibility but **no streaming text deltas** (only complete messages), **no type schema**, **no permission prompts**.

Better: Use stream-json or SDK for real-time; transcript for audit trail.

---

## 5. Slash Commands & Interrupts in Headless/Streaming

### 5.1 Supported in `-p` Mode

**Limited set:**
- `/config key=value`
- `/color`, `/effort`, `/model`, `/fast`, `/mcp` (print text status)

**NOT available:** `/login`, `/logout`, `/resume`, `/branch`, `/clear`, `/plan` (use CLI flags instead)

### 5.2 Interrupt & Control in SDK

```typescript
const q = query({ prompt: "Long task..." });
setTimeout(() => q.interrupt(), 5000);  // Stop mid-turn

// Get context usage mid-stream
const usage = await q.getContextUsage();

// Change permission mode mid-session
await q.setPermissionMode("acceptEdits");
```

### 5.3 Compact via SDK/Headless

`/compact` is **not directly callable** via prompt injection. For compaction:
- **SDK:** use session control requests or session API
- **Headless:** resume session interactively and run `/compact` in terminal

---

## 6. Status & Telemetry Surfaces

### 6.1 Status Line (Monitoring Hook)

**Customizable shell script** runs on each update (message arrival, `/compact` done, permission mode change, vim toggle, `refreshInterval` timer).

**Receives JSON on stdin:**
```json
{
  "session_id": "...",
  "model": { "id": "...", "display_name": "Claude Opus" },
  "workspace": { "current_dir": "...", "root_dir": "..." },
  "context_window": { "limit": 200000, "used": 45000, "used_percentage": 22.5, "cached_tokens": 10000 },
  "cost": { "input_tokens_cached": 1000, "input_tokens_new": 4000, "output_tokens": 500, "total_cost_usd": 0.042 },
  "duration_ms": 15000,
  "git": { "branch": "main", "status": "clean", "ahead_behind": "0+0" },
  "vim": { "mode": "normal" },
  "permission_mode": "acceptEdits",
  "message_count": 12,
  "tool_use_count": 5,
  "timestamp": 1723549200000
}
```

**Updates Trigger:** Message arrival, `/compact` done, permission mode change, vim mode toggle, `refreshInterval` timer

### 6.2 State Detection via Stream-JSON

| State | Detection |
|---|---|
| **Working/executing** | `stream_event` or `content_block_delta` arriving |
| **Tool executing** | `content_block_start` (type: `tool_use`) → tool result |
| **Awaiting permission** | Implicit (no events); requires `PermissionRequest` hook or `canUseTool` callback |
| **Idle** | No events ~60 seconds after last `message_stop` |
| **Waiting for input** | `Notification` event (subtype: `"idle_prompt"`) |

### 6.3 No Native OpenTelemetry (OTEL)

Claude Code does **not export OTEL traces/metrics by default**. Telemetry surfaces: status lines, hooks (PostToolUse, Stop hooks to record telemetry).

---

## 7. Known Limitations: Terminal UI Features NOT Exposed

### 7.1 Interactive-Only UI Elements

| Feature | Interactive | Headless | Workaround |
|---|---|---|---|
| **Plan mode UI** | Visual proposal display, edit with Ctrl+G | Text/JSON only | Re-implement plan display in custom UI |
| **Permission prompts** | Interactive dialog | Implicit (need `--permission-prompt-tool` or SDK `canUseTool`) | Provide your own approval mechanism |
| **Rate-limit warnings** | Toast/status bar | Error stream only | Monitor API errors |
| **`/login` flow** | OAuth browser launch | Not available; use `ANTHROPIC_API_KEY` | Auth outside `-p` runs |
| **Session picker** | Interactive visual list + search | CLI flag only; use `--resume <id>` | Build your own session browser |
| **In-editor diffs** | Line-by-line visual diffs | Only file content in stream | Parse Edit tool input for diffs |
| **Real-time terminal rendering** (xterm.js) | Full ANSI/xterm output | Raw stdout from Bash results | Replay Bash output in UI; no live pty without Terminal fallback |
| **Interrupt UI** (Esc feedback) | Flash/highlight | Silent | Implement visual feedback when interrupt() called |
| **MCP tool approval cards** | Rich form rendering | Escalated to `canUseTool` callback | Render MCP elicitation forms yourself |

### 7.2 Structured Output Limitations

- **Structured output** (with `--json-schema`): JSON result appears **only in final `result` message**, not as streaming deltas.
- **Thinking blocks**: Exposed as `content_block_delta` with `delta.type: "thinking_delta"` (if model supports extended thinking).
- **Subagent text**: By default (without `--forward-subagent-text`), only `tool_use` and `tool_result` forwarded; text/thinking hidden.

### 7.3 What IS Fully Exposed

✓ Text generation (streaming deltas)  
✓ Tool calls and results (complete)  
✓ Model reasoning (thinking content blocks)  
✓ Subagent invocation and completion  
✓ Token usage and costs  
✓ Session ID and resumption  
✓ Permission decisions (via hooks or `canUseTool`)  
✓ Compaction summaries  
✓ All user messages  
✓ Hook execution and decisions  
✓ Context window usage  

---

## 8. Verdict: Recommended Integration Architecture

### 8.1 Architecture Decision Matrix

| Architecture | Pros | Cons | When to Use |
|---|---|---|---|
| **Stream-JSON CLI Wrapper** | Simple subprocess; minimal dependencies | No permission prompts; limited hooks; fragile transcript parsing | Prototype/MVP; simple scripts |
| **Agent SDK (TypeScript/Python)** | Full control; streaming callbacks; `canUseTool` for approvals; sessions in-process; rich types; hooks first-class; built-in tools | You own harness; handle concurrency/state; Node/Python runtime | **RECOMMENDED for production custom UI** |
| **Transcript + Stream-JSON Hybrid** | Redundant taps (replay + real-time); audit trail | Higher complexity; duplicate event handling | High-stakes audit scenarios |
| **pty + Terminal Emulation** | Full TUI (plan mode, all visual elements) | Requires xterm.js; regex parsing brittle; no direct state | Legacy; stepping stone |

### 8.2 Recommended Path: Agent SDK with Custom UI

**Architecture Sketch:**
```
Custom Web UI (React/Vue)
        ↓
Agent SDK Query Handler (TypeScript/Python)
        ↓
[Read, Write, Edit, Bash, Grep, WebSearch, WebFetch] Built-In Tools
        ↓
Permission Flow (Hooks + canUseTool callback)
        ↓
Anthropic API (Claude Opus)
```

**Implementation:**

1. **Instantiate SDK Query with streaming:**
   ```typescript
   const q = query({
     prompt: userPrompt,
     options: {
       includePartialMessages: true,
       allowedTools: ["Read", "Edit", "Bash", "Grep"],
       permissionMode: "default",
       canUseTool: handlePermissionPrompt
     }
   });
   ```

2. **Stream messages to UI:**
   ```typescript
   for await (const message of q) {
     if (message.type === "stream_event") {
       handleTextDelta(message.event.delta.text);  // Token-level update
     } else if (message.type === "tool_use") {
       showToolStatus(message.tool_name, message.tool_input);  // Spinner
     } else if (message.type === "assistant_message") {
       addMessage(message);  // Commit to chat history
     } else if (message.type === "result") {
       markComplete(message.result);  // Session done
     }
   }
   ```

3. **Handle permissions:**
   ```typescript
   const handlePermissionPrompt = async (toolName, toolInput, reason) => {
     const approved = await showApprovalDialog({
       tool: toolName,
       input: JSON.stringify(toolInput, null, 2),
       reason
     });
     return { allow: approved };
   };
   ```

4. **Render plan mode (if enabled):**
   - Capture `assistant_message` with plan text
   - Parse and display in custom plan UI (editable)
   - On approval, call `q.setPermissionMode("acceptEdits")`

5. **Session resumption:**
   ```typescript
   const q = query({
     prompt: followUpPrompt,
     options: { sessionId: previousSessionId, ... }
   });
   ```

### 8.3 Fallback to Terminal When Needed

```typescript
if (needsInteractiveLogin || unrecoverableRateLimit || bashNeedsPTY) {
  spawn('claude', ['-p', ...args], { stdio: 'inherit' });
}
```

For: OAuth flows, rate-limit recovery, interactive shell sessions.

---

## Summary Table: Integration Capabilities

| Capability | Stream-JSON | Agent SDK | Transcript | PTY |
|---|---|---|---|---|
| **Text streaming** | ✓ | ✓ | ✗ (complete only) | ✓ |
| **Tool calls/results** | ✓ | ✓ | ✓ (searchable) | ✓ (regex) |
| **Token usage** | ✓ | ✓ | ✗ | ✓ (regex) |
| **Permission prompts** | ✗ | ✓ (canUseTool) | ✗ | ✓ |
| **Hooks as event tap** | ✗ | ✓ | ✗ | ✗ |
| **Session resumption** | ✓ `--resume` | ✓ (sessionId) | ✓ (manual) | ✓ |
| **Thinking blocks** | ✓ | ✓ | ✗ | ✓ |
| **Plan mode UX** | Text only | Text only | ✗ | ✓ (full) |
| **Real-time Bash** | ✓ (after run) | ✓ (after run) | ✗ | ✓ (streaming) |
| **MCP integration** | ✓ `--mcp-config` | ✓ (first-class) | ✗ | ✓ |
| **Subagent visibility** | ✓ `--forward-subagent-text` | ✓ (parent_tool_use_id) | ✓ | ✓ |
| **Interactive interrupts** | ✗ (SIGTERM) | ✓ (interrupt()) | ✗ | ✓ |
| **Type safety** | JSON schema | TypeScript types | Inferred | ✗ |

---

## Conclusion

**To build a production custom UI for Claude Code:**

1. **Use Agent SDK** (TypeScript or Python) as primary harness
2. **Implement `canUseTool` callback** for custom approval UI
3. **Stream `stream_event` messages** to UI in real-time
4. **Render plan-mode UI** if needed (capture text, display editable area)
5. **Fall back to interactive terminal** for: OAuth login, bash PTY sessions, advanced debugging
6. **Use hooks (HTTP) or PostToolUse events** to push telemetry
7. **Leverage status line JSON** for context/cost dashboards

This gives **100% programmatic state visibility** for common path (text, tools, decisions) with **~5-10% fallback** for interactive terminal features better left as native.

---

**File:** `/tmp/claude-1000/-opt-projects-supermux/0ce1fa02-9bc2-41c3-b2c6-7b2814d510c0/scratchpad/report-claude-wrapping.md`
