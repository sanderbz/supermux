#!/bin/bash
# An isolated supermux server with ONE real Claude Code version behind a local fake API.
#
#   testserver.sh start <T> <port> <claude-binary> [server-binary]
#   testserver.sh stop  <T>
#
# Nothing here touches production: own data dir, own HOME (<T>/home), own token, own port, `env -i`.
# Claude has no login and no key; it only talks to 127.0.0.1:<fake-api-port>. Auto mode stays AVAILABLE
# (as in production, so the plan dialog keeps its first row) but is never the start mode; bypass is off.
#
# Keep <T> short (the pty-holder socket path has a length limit), and never put <T> literally on the
# command line of the shell that calls `stop`: stop kills every process whose command line contains <T>/.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
cmd=${1:-}; T=${2:-}; T=${T%/}
[ -n "$T" ] || { echo "usage: $0 start|stop <T> …"; exit 2; }

stop() {
  [ -f "$T/pid" ] && kill "$(cat "$T/pid")" 2>/dev/null
  [ -f "$T/api.pid" ] && kill "$(cat "$T/api.pid")" 2>/dev/null
  # Real claude: only a pid from our own list that still has HOME=<T>/home. Claude ignores TERM without a tty.
  [ -f "$T/claude.pids" ] && while read -r p; do
    [ -n "$p" ] && ps eww -o command= -p "$p" 2>/dev/null | grep -qE "HOME=$T/home( |$)" && kill -9 "$p" 2>/dev/null
  done < "$T/claude.pids"
  sleep 2
  ps -axo pid=,command= | grep -F "$T/" | grep -v grep | awk '{print $1}' | while read -r p; do kill "$p" 2>/dev/null; done
  sleep 1
  ps eww -axo pid=,command= | grep -E "HOME=$T/home( |$)" | grep -v grep | awk '{print $1}' | while read -r p; do kill -9 "$p" 2>/dev/null; done
  ps -axo pid=,command= | grep -F "$T/" | grep -v grep | awk '{print $1}' | while read -r p; do kill -9 "$p" 2>/dev/null; done
  rm -f "$T/pid" "$T/api.pid"
  echo "left: $(ps eww -axo pid=,command= | grep -F "$T/" | grep -v grep | wc -l | tr -d ' ') processes"
}

start() {
  local PORT=$1 CLAUDE_BIN=$2 SERVER_BIN=${3:-$HOME/.local/bin/supermux-server}
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $PORT is taken"; exit 1; }
  [ -x "$CLAUDE_BIN" ] && [ -x "$SERVER_BIN" ] || { echo "missing claude or server binary"; exit 1; }
  mkdir -p "$T/home/.claude" "$T/work" "$T/bin" "$T/d"
  cp -p "$SERVER_BIN" "$T/server-bin"
  cp "$HERE/fake-api.py" "$T/fake-api.py"; : > "$T/claude.pids"
  local APORT; APORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
  env -i PATH=/opt/homebrew/bin:/usr/bin:/bin HOME="$T/home" nohup python3 -I "$T/fake-api.py" "$T" "$APORT" >> "$T/api.err" 2>&1 < /dev/null &
  echo $! > "$T/api.pid"; echo "$APORT" > "$T/api-port"
  for _ in $(seq 1 20); do curl -s -m 2 "http://127.0.0.1:$APORT/" >/dev/null && break; sleep 0.25; done
  # The shim: supermux's own permission/tool flags are dropped, ours go last. Never bypass.
  cat > "$T/bin/claude" <<C
#!/bin/bash
case "\${1:-}" in update|install|migrate-installer|setup-token|login|logout) echo "test claude: \$1 disabled"; exit 0;; esac
a=(); skip=0
for x in "\$@"; do
  if [ \$skip = 1 ]; then skip=0; continue; fi
  case "\$x" in
    --dangerously-skip-permissions|--allow-dangerously-skip-permissions|--strict-mcp-config) continue;;
    --permission-mode|--tools|--allowedTools|--allowed-tools|--mcp-config) skip=1; continue;;
    --permission-mode=*|--tools=*|--allowedTools=*|--allowed-tools=*|--mcp-config=*) continue;;
  esac
  a+=("\$x")
done
echo \$\$ >> "$T/claude.pids"
unset CLAUDE_CONFIG_DIR ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_MODEL
export HOME="$T/home" ANTHROPIC_BASE_URL=http://127.0.0.1:$APORT ANTHROPIC_AUTH_TOKEN=dummy
export DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1
exec "$CLAUDE_BIN" "\${a[@]}" --tools Read,Bash,Write,Edit,AskUserQuestion,EnterPlanMode,ExitPlanMode --strict-mcp-config --permission-mode default
C
  chmod 755 "$T/bin/claude"
  echo '{"permissions":{"disableBypassPermissionsMode":"disable","defaultMode":"default"}}' > "$T/home/.claude/settings.json"
  local RW CV P; RW=$(cd "$T/work" && pwd -P); CV=$("$CLAUDE_BIN" --version 2>/dev/null | awk '{print $1}')
  P='{"hasTrustDialogAccepted":true,"hasCompletedProjectOnboarding":true,"allowedTools":[]}'
  printf '{"hasCompletedOnboarding":true,"lastOnboardingVersion":"%s","lastReleaseNotesSeen":"%s","numStartups":5,"theme":"dark","projects":{"%s/work":%s,"%s":%s}}\n' \
    "$CV" "$CV" "$T" "$P" "$RW" "$P" > "$T/home/.claude.json"
  for i in 1 2 3 4 5 6 7 8 9; do printf 'alpha\nbeta\ngamma\n' > "$T/work/edit$i.txt"; done
  [ -s "$T/token" ] || { openssl rand -hex 24 > "$T/token"; chmod 600 "$T/token"; }
  echo "http://127.0.0.1:$PORT" > "$T/url"
  env -i HOME="$T/home" USER="$USER" SUPERMUX_DATA_DIR="$T/d" SUPERMUX_BIND=127.0.0.1:"$PORT" \
    SUPERMUX_AUTH_TOKEN="$(cat "$T/token")" PATH="$T/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" SHELL=/bin/zsh \
    nohup "$T/server-bin" > "$T/log" 2>&1 &
  echo $! > "$T/pid"
  for _ in $(seq 1 40); do curl -s -m 3 -H "Authorization: Bearer $(cat "$T/token")" "http://127.0.0.1:$PORT/api/health" | grep -q '"db_ok":true' && break; sleep 1; done
  curl -s -m 3 -H "Authorization: Bearer $(cat "$T/token")" "http://127.0.0.1:$PORT/api/health" | grep -q '"db_ok":true' || { echo "server did not come up; see $T/log"; exit 1; }
  echo "test server on :$PORT, claude $CV, fake API :$APORT"
}

case "$cmd" in
  start) shift 2; start "$@";;
  stop) stop;;
  *) echo "usage: $0 start|stop <T> …"; exit 2;;
esac
