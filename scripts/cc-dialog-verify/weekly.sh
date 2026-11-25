#!/bin/bash
# Weekly re-verification of chat's dialog registry against the newest Claude Code release
# (run once a week, Monday 05:30, by the supermux agent; this script holds no schedule itself).
#
#   weekly.sh [version]         (no version: the release channel's `latest`)
#
# Runs entirely OUTSIDE production: an isolated test server (testserver.sh) with the release's real binary
# behind a local fake API, in a throwaway HOME, plus a throwaway git worktree. It never touches the live
# server, its data, or another session.
#
#   1. Nothing to do when the version is already verified (web/src/components/chat/registry/verified.ts on
#      origin/main, or $BASE) or older than the newest verified one.
#   2. Download the macOS binary, check its SHA-256 against the release manifest and its code signature.
#   3. In a worktree on origin/main, add the version to verified.ts — the sequencer refuses an unlisted
#      version, so it has to be listed before it can be driven — and start the test server.
#   4. Capture every dialog family with the caret on each row; drive the eight live cases with the shipped
#      answerDialog() (web/scripts/cc-dialog-live.ts) and check their effects on disk.
#   5. Compare the captures with the newest verified corpus (corpus.py compare).
#   6. Identical AND all eight cases landed → copy the corpus in (redacted), run the chat tests, push a branch
#      and open a PR. Anything else → no PR; the report says what differed.
#
# Output: $OUT/<version>/report.json (+ run.log, captures, live frames). Exit 0 = ran (see report.status).
# A version PR is never merged by this script: each one is a merge point for a human.
set -u
REPO=${REPO:-$HOME/projects/supermux}
OUT=${OUT:-$HOME/.supermux/cc-dialog-verify}
PORT=${PORT:-18863}
NO_PR=${NO_PR:-}            # 1 = do everything except commit/push/PR (testing this script)
BASE=${BASE:-origin/main}   # the ref to verify against (a branch only for testing this script itself)
REL=https://downloads.claude.ai/claude-code-releases
HERE=$(cd "$(dirname "$0")" && pwd)
VERIFIED=web/src/components/chat/registry/verified.ts

git -C "$REPO" fetch -q origin || { echo "fetch failed"; exit 1; }
listed=$(git -C "$REPO" show "$BASE:$VERIFIED" | grep -oE "'[0-9]+\.[0-9]+\.[0-9]+'" | tr -d "'")
newest=$(printf '%s\n' $listed | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)
V=${1:-$(curl -fsS -m 20 "$REL/latest" | tr -d '[:space:]')}
echo "$V" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "no usable version (got '$V')"; exit 1; }
R="$OUT/$V"; mkdir -p "$R"
report() { # status, detail-json
  printf '{"version":"%s","newest_verified":"%s","status":"%s","at":"%s","detail":%s}\n' \
    "$V" "$newest" "$1" "$(date -u +%FT%TZ)" "${2:-null}" > "$R/report.json"; cat "$R/report.json"; }
newer() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)" = "$1" ] && [ "$1" != "$2" ]; }

if printf '%s\n' $listed | grep -qx "$V"; then report already-verified; exit 0; fi
if ! newer "$V" "$newest"; then report older-than-verified; exit 0; fi
[ -f "$R/report.json" ] && grep -qE '"status":"(pr-opened|different|failed)"' "$R/report.json" && { cat "$R/report.json"; exit 0; }
exec > >(tee -a "$R/run.log") 2>&1
echo "=== $V (newest verified $newest) $(date)"

# ── 2. binary ──
B="$R/bin"; mkdir -p "$B"
want=$(curl -fsS -m 20 "$REL/$V/manifest.json" | python3 -c 'import sys,json;print(json.load(sys.stdin)["platforms"]["darwin-arm64"]["checksum"])') \
  || { report failed '"no manifest"'; exit 0; }
curl -fsS -m 900 -o "$B/claude" "$REL/$V/darwin-arm64/claude" || { report failed '"download failed"'; exit 0; }
[ "$(shasum -a 256 "$B/claude" | cut -c1-64)" = "$want" ] || { rm -f "$B/claude"; report failed '"checksum mismatch"'; exit 0; }
chmod 755 "$B/claude"
codesign --verify --strict "$B/claude" || { rm -f "$B/claude"; report failed '"signature invalid"'; exit 0; }

# ── 3. worktree + server ──
WT="$REPO-wt.noindex/cc-verify-$V"; BR="cc-verify/$V"
git -C "$REPO" worktree remove --force "$WT" 2>/dev/null; git -C "$REPO" branch -D "$BR" 2>/dev/null
git -C "$REPO" worktree add -q -b "$BR" "$WT" "$BASE" || { report failed '"worktree"'; exit 0; }
( cd "$WT/web" && bun install --frozen-lockfile >/dev/null 2>&1 ) || { report failed '"bun install"'; exit 0; }
python3 -I "$HERE/corpus.py" add-version "$WT/$VERIFIED" "$V"
T=/private/tmp/claude-501/ccv; mkdir -p "$T"
cleanup() { bash "$HERE/testserver.sh" stop "$T" >/dev/null; rm -f "$B/claude"; }
trap cleanup EXIT
bash "$HERE/testserver.sh" start "$T" "$PORT" "$B/claude" || { report failed '"test server did not start"'; exit 0; }
api() { local m=$1 p=$2; shift 2; curl -s -m 30 -X "$m" -H "Authorization: Bearer $(cat "$T/token")" -H 'Content-Type: application/json' "$(cat "$T/url")$p" "$@"; }
peek() { api GET "/api/sessions/$1/peek?lines=${2:-60}" | python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("data",d);sys.stdout.write(d if isinstance(d,str) else (d.get("text") or d.get("content") or ""))'; }
key() { api POST "/api/sessions/$1/keys" -d "{\"key\":\"$2\"}" >/dev/null; sleep "${3:-1}"; }
send() { api POST "/api/sessions/$1/send" -d "{\"text\":\"$2\"}" >/dev/null; sleep "${3:-6}"; }
mkdir -p "$T/work2/.claude"; echo '{"permissions":{"disableAutoMode":"disable"}}' > "$T/work2/.claude/settings.json"
for s in auto:work noauto:work2; do
  api POST /api/sessions -d "{\"name\":\"cc-${s%%:*}\",\"dir\":\"$T/${s##*:}\",\"provider\":\"claude\"}" >/dev/null
  api POST "/api/sessions/cc-${s%%:*}/start" -d '{}' >/dev/null
done
sleep 6
for n in cc-auto cc-noauto; do # the boot-time "make auto mode your default?" → No, keep manual mode
  for _ in 1 2 3 4 5; do scr=$(peek $n 30)
    if echo "$scr" | grep -q 'Make auto mode your default'; then key $n Down; key $n Enter 2; fi
    echo "$scr" | grep -q 'manual mode on' && break; sleep 2
  done
done
peek cc-auto 30 | grep -q "Claude Code v$V" || { report failed '"the session did not boot the expected version"'; exit 0; }

# ── 4a. captures ──
C="$R/captures"; mkdir -p "$C"
cap() { peek "$1" 60 > "$2"; }
rows() { grep -cE '^ (❯| ) [0-9]\. ' "$1"; }
fam() { # <scenario> <prefix-name>
  send cc-auto /clear 3; send cc-auto "$1"; cap cc-auto "$C/$2-caret1.txt"
  local r i=2; r=$(rows "$C/$2-caret1.txt")
  while [ "$i" -le "$r" ]; do key cc-auto Down; cap cc-auto "$C/$2-caret$i.txt"; i=$((i+1)); done
  key cc-auto Escape 3
}
cap cc-auto "$C/00-boot-banner.txt"
fam scenario:bashaccess:5 01-bash-access
fam scenario:bashread 05-bash-read
fam scenario:bashcmd:5 06-bash-cmdrule
fam scenario:write:5 20-write
fam scenario:edit:5 30-edit
send cc-auto /clear 3; api POST /api/sessions/cc-auto/mode -d '{"mode":"plan"}' >/dev/null; sleep 2
fam scenario:plan:5 40-plan
api POST /api/sessions/cc-auto/mode -d '{"mode":"normal"}' >/dev/null; sleep 2

# ── 4b. live cases ──
L="$C/live"; mkdir -p "$L"
live() { ( cd "$WT/web" && bun scripts/cc-dialog-live.ts "$T" "$@" ) 2>&1 | tail -1; }
live cc-auto "$L" case1-bash-deny scenario:bashaccess:11 permission.bash 3
live cc-auto "$L" case2-bash-allow scenario:bashaccess:12 permission.bash 0
live cc-auto "$L" case3-write-option2 scenario:write:13 permission.write 1
live cc-auto "$L" case4-plan-manual scenario:plan:14 plan.approval 1 plan
live cc-auto "$L" case5-edit-escape scenario:edit:7 permission.edit escape
live cc-auto "$L" case6-cmdrule-deny scenario:bashcmd:16 permission.bash 3
live cc-noauto "$L" case7-noauto-bash-deny scenario:bashaccess:17 permission.bash 2
live cc-noauto "$L" case8-write-outside-option2 scenario:write:18 permission.write 1
W="$T/work"; effects=ok; why=()
exp() { [ "$1" = "$2" ] || { effects=bad; why+=("$3"); }; }
exp "$([ -e "$W/bash11.txt" ] && echo y || echo n)" n "case1 ran the command"
exp "$([ -e "$W/bash12.txt" ] && echo y || echo n)" y "case2 did not run"
exp "$([ -e "$W/write13.txt" ] && echo y || echo n)" y "case3 did not write"
exp "$(tr -d '\n' < "$W/edit7.txt")" alphabetagamma "case5 changed the file"
exp "$([ -e "$W/py16.txt" ] && echo y || echo n)" n "case6 ran the command"
exp "$([ -e "$W/bash17.txt" ] && echo y || echo n)" n "case7 ran the command"
exp "$([ -e "$W/write18.txt" ] && echo y || echo n)" y "case8 did not write"
grep -q '⏵⏵ accept edits on' "$L/case3-write-option2-99-after.txt" || { effects=bad; why+=("case3 no accept edits"); }
grep -q '⏸ manual mode on' "$L/case4-plan-manual-99-after.txt" || { effects=bad; why+=("case4 not manual"); }
okc=$(grep -l '"ok": true' "$L"/*-sequence.json 2>/dev/null | wc -l | tr -d ' ')
[ "$okc" = 8 ] || { effects=bad; why+=("only $okc of 8 cases ok"); }
cleanup; trap - EXIT

# ── 5. compare with the newest corpus ──
F="$WT/web/tests/fixtures/tui/cc321"
base="$F/$(cd "$WT/web" && bun -e "import { corpusDirFor } from './src/components/chat/registry/verified'; console.log(corpusDirFor('$newest'))")"
python3 -I "$HERE/corpus.py" compare "$C" "$base" "$T" > "$R/compare.json"
identical=$(python3 -c "import json;print(json.load(open('$R/compare.json'))['identical'])")
whyj=$(printf '%s\n' "${why[@]+"${why[@]}"}" | python3 -c 'import sys,json;print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')
if [ "$identical" != True ] || [ "$effects" != ok ]; then
  report different "{\"identical\":$( [ "$identical" = True ] && echo true || echo false ),\"effects\":$whyj,\"compare\":\"$R/compare.json\"}"
  git -C "$REPO" worktree remove --force "$WT"; git -C "$REPO" branch -D "$BR" >/dev/null
  exit 0
fi

# ── 6. the PR ──
dst="$F/$(cd "$WT/web" && bun -e "import { corpusDirFor } from './src/components/chat/registry/verified'; console.log(corpusDirFor('$V'))")"
python3 -I "$HERE/corpus.py" redact "$C" "$dst" >/dev/null
( cd "$WT/web" && bun test tests/unit/chat-cc321.test.ts tests/unit/chat-registry.test.ts tests/unit/chat-registry-structure.test.ts tests/unit/chat-dialog-answer.test.tsx ) > "$R/tests.log" 2>&1 \
  || { report failed "\"chat tests failed with $V added, see $R/tests.log\""; exit 0; }
if [ -n "$NO_PR" ]; then report would-open-pr "\"$WT\""; exit 0; fi
cd "$WT" && git add -A web && git commit -q -m "feat(chat): dialog registry verified on Claude Code $V

Weekly re-verification (scripts/cc-dialog-verify/weekly.sh): the release binary
(checksum + signature checked) on an isolated test server behind a fake API drew
dialogs identical to $newest, and all eight live cases landed their effects." \
  && git push -q -u origin "$BR" \
  && url=$(gh pr create --base main --head "$BR" --title "feat(chat): dialog registry verified on Claude Code $V" --body "Weekly re-verification by \`scripts/cc-dialog-verify/weekly.sh\`.

- Release binary $V for darwin-arm64, SHA-256 checked against the release manifest, plus Anthropic's code signature.
- Isolated test server behind a local fake API, with a throwaway HOME. Production was not touched.
- The dialogs are identical to the newest verified version ($newest) on all 13 compared captures (\`compare.json\`).
- 8/8 live cases were driven by \`answerDialog()\` and their effects checked on disk.
- Corpus: \`web/tests/fixtures/tui/cc321/$(basename "$dst")\`.

This PR is a merge point: merge only on an approval.") \
  || { report failed '"commit/push/PR failed"'; exit 0; }
report pr-opened "\"$url\""
