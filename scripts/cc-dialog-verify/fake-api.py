#!/usr/bin/env python3
"""Fake Anthropic Messages API for the dialog re-verification rig (scripts/cc-dialog-verify/).

The REAL claude CLI talks to this via ANTHROPIC_BASE_URL + a dummy ANTHROPIC_AUTH_TOKEN, so it draws its real
dialogs and writes real transcripts without any model, login or key. Derived from the supermux-ios test
server's fake-api.py (itself based on bouw-179's api-stub.py), extended with one scenario per dialog family.

Deterministic: the reply is chosen by a keyword in the newest user prompt (`scenario:<name>[:N]`), and the
step within the turn is the number of assistant messages after that prompt.

Dialog scenarios (N numbers the artifact so every run proves its own side effect):
  bashaccess:N  Bash `touch <T>/work/bashN.txt`         (grant row: "always allow access to …")
  bashread      Bash `head -1 /etc/hosts`                (grant row: "allow reading from …")
  bashcmd:N     Bash `python3 -c …` writing pyN.txt      (grant row: "don't ask again for: python3 *")
  write:N       Write <T>/work/writeN.txt
  edit:N        Read, then Edit <T>/work/editN.txt (beta → BETA; seeded editN.txt for N=1..9)
  plan:N        in plan mode: Write the plan file named in the request, then ExitPlanMode

Safety: the stub only ever asks for a tool that the request offers, only with inputs below <T>/work (plus
the read-only `head -1 /etc/hosts`), and only the calls scripted here. Every request is logged to <T>/api.log.

usage: fake-api.py <T> <port>
"""
import http.server
import json
import os
import re
import socketserver
import sys
import threading
import time

T, PORT = sys.argv[1].rstrip('/'), int(sys.argv[2])
WORK = os.path.realpath(T + '/work')
HOLD = 30
lock = threading.Lock()
counter = [0]
PLAN_PATH = ['']
PLAN_HAS_ARG = [False]
# The plan file Claude names in the request: under ~/.claude/plans, or <CLAUDE_CONFIG_DIR>/plans.
PLANRE = re.compile(r'(/[^\s"\\]+/plans/[A-Za-z0-9_-]+\.md)')

REMINDER = re.compile(r'<system-reminder>.*?</system-reminder>', re.S)
SCENARIO = re.compile(r'scenario:([a-z]+)(?::(\d+))?')


def log(entry):
    with lock, open(T + '/api.log', 'a') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')


def next_id(prefix):
    with lock:
        counter[0] += 1
        return f'{prefix}_fake{int(time.time() * 1000) % 10**9:09d}{counter[0]:05d}'


def blocks_of(content):
    return [{'type': 'text', 'text': content}] if isinstance(content, str) else (content or [])


def visible_text(blocks):
    """The user-typed text of a message: text blocks minus Claude Code's <system-reminder> blocks."""
    parts = []
    for b in blocks:
        if b.get('type') == 'text':
            t = REMINDER.sub('', b.get('text', '')).strip()
            if t:
                parts.append(t)
    return '\n'.join(parts)


def tool_result_text(block):
    c = block.get('content')
    if isinstance(c, str):
        return c
    out = []
    for x in c or []:
        if x.get('type') == 'text':
            out.append(x.get('text', ''))
        elif x.get('type') == 'image':
            out.append('[image]')
    return '\n'.join(out)


def locate(messages):
    """(prompt text, step, results): the newest real user prompt, how many assistant messages follow it, and the
    tool_result blocks of the newest user message (the answers to the previous step's tool calls)."""
    idx, text = None, ''
    for i in range(len(messages) - 1, -1, -1):
        m = messages[i]
        if m.get('role') != 'user':
            continue
        bl = blocks_of(m.get('content'))
        if any(b.get('type') == 'tool_result' for b in bl) and not SCENARIO.search(visible_text(bl)):
            continue
        t = visible_text(bl)
        if t:
            idx, text = i, t
            break
    if idx is None:
        return '', 0, []
    step = sum(1 for m in messages[idx + 1:] if m.get('role') == 'assistant')
    results = []
    last = messages[-1] if messages else {}
    if last.get('role') == 'user':
        results = [b for b in blocks_of(last.get('content')) if b.get('type') == 'tool_result']
    return text, step, results


# ── content ────────────────────────────────────────────────────────────────

def thinking(text):
    return {'type': 'thinking', 'thinking': text, 'signature': 'ZmFrZS1zaWduYXR1cmU='}


def text(t):
    return {'type': 'text', 'text': t}


def tool(name, inp):
    return {'type': 'tool_use', 'id': next_id('toolu'), 'name': name, 'input': inp}


MARKDOWN = """# Fake Claude: markdown scenario

This reply is **scripted** by `fake-api.py`. It exercises the *renderer*: headings, lists, a table, `inline code`, links like [supermux](https://example.invalid/supermux) and fenced code.

## Lists

1. First numbered item
2. Second item with `code` inside
   - nested bullet A
   - nested bullet B with **bold** and _italic_
3. Third item

- [ ] an open task
- [x] a finished task

> A blockquote: the transcript entry is real, the model is not.

## Table

| Scenario | Produces | Ask? |
|:---------|:---------|:----:|
| `markdown` | thinking + this text | no |
| `tools` | 3 tool calls, 1 error | no |
| `permission` | Bash `echo` | **yes** |
| `question` | AskUserQuestion | **yes** |
| `image` | Read of a PNG | no |

## Swift

```swift
import SwiftUI

struct ChatBubble: View {
    let text: String
    var isMine = false

    var body: some View {
        Text(text)
            .padding(12)
            .background(isMine ? Color.accentColor : Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}
```

## Bash

```bash
#!/bin/bash
set -euo pipefail
T=${SMIOS_DIR:-/tmp/smios}
curl -s -H "Authorization: Bearer $(cat "$T/token")" "$(cat "$T/url")/api/asks" | jq '.data | length'
```

### Heading level 3

A final paragraph with a very long line that should wrap on a phone screen without any horizontal scrolling, because nobody wants to scroll sideways through a chat bubble on an iPhone mini.

---

*End of markdown scenario.*"""


def long_text(n_sections):
    out = ['# Long reply (scenario:long)', '',
           f'This single text entry is far over supermux\'s 16 KiB per-entry wire cap (MAX_ENTRY_BYTES), so it '
           'arrives `truncated: true` on the chat socket and in /chat/history; fetch the full body with '
           'GET /api/sessions/<name>/chat/entry/<uuid>.', '']
    for i in range(1, n_sections + 1):
        out.append(f'## Section {i}')
        out.append('')
        out.append(f'Paragraph {i}: ' + ' '.join(f'word{i}-{j}' for j in range(1, 90)) + '.')
        out.append('')
        out.append(f'- bullet {i}.a with `code{i}`')
        out.append(f'- bullet {i}.b')
        out.append('')
    out.append('*End of long reply.*')
    return '\n'.join(out)


def summarize(results, limit=300):
    lines = []
    for r in results:
        body = tool_result_text(r).strip().replace('\n', ' ')
        if len(body) > limit:
            body = body[:limit] + '...'
        status = 'ERROR' if r.get('is_error') else 'ok'
        lines.append(f'- `{r.get("tool_use_id", "?")}` ({status}): {body}')
    return '\n'.join(lines) if lines else '- (no tool results in this request)'


def plan(prompt, step, results, offered):
    """Return (content blocks, stop_reason) for one main-loop request."""
    m = SCENARIO.search(prompt)
    name = m.group(1) if m else ''
    arg = int(m.group(2)) if m and m.group(2) else None
    have = lambda t: t in offered  # noqa: E731

    if name == 'markdown':
        return [thinking('The user asked for the markdown scenario. I will produce headings, lists, a table, '
                         'inline code and two fenced code blocks (Swift and bash).'), text(MARKDOWN)], 'end_turn'

    if name == 'tools':
        if step == 0:
            calls = []
            if have('Read'):
                calls.append(tool('Read', {'file_path': WORK + '/README.txt'}))
                calls.append(tool('Read', {'file_path': WORK + '/does-not-exist.txt'}))
            if have('Bash'):
                calls.append(tool('Bash', {'command': 'ls', 'description': 'List files in the work dir'}))
            if calls:
                return [thinking('I will read the README, try a file that does not exist, and list the directory.'),
                        text('Let me look at the work directory.')] + calls, 'tool_use'
        return [text('Done. Tool results:\n\n' + summarize(results) +
                     '\n\nThe missing file produced a tool error, as scripted.')], 'end_turn'

    # ── registry-321: one scenario per dialog family (supermux registry re-verification) ──
    n = arg or 1
    def after(what):
        denied = any(r.get('is_error') for r in results)
        return [text(f'{what}: ' + ('**denied**.' if denied else 'done.') + '\n\n' + summarize(results))], 'end_turn'
    if name == 'bashaccess':
        if step == 0 and have('Bash'):
            return [tool('Bash', {'command': f'touch {WORK}/bash{n}.txt', 'description': f'Create empty file bash{n}.txt'})], 'tool_use'
        return after('touch')
    if name == 'bashread':
        if step == 0 and have('Bash'):
            return [tool('Bash', {'command': 'head -1 /etc/hosts', 'description': 'Show the first line of /etc/hosts'})], 'tool_use'
        return after('read')
    if name == 'bashcmd':
        if step == 0 and have('Bash'):
            return [tool('Bash', {'command': f'python3 -c "open(\'{WORK}/py{n}.txt\',\'w\').write(\'x\')"',
                                  'description': f'Write marker file py{n}.txt'})], 'tool_use'
        return after('python3')
    if name == 'write':
        if step == 0 and have('Write'):
            return [tool('Write', {'file_path': f'{WORK}/write{n}.txt', 'content': f'hello {n}\n'})], 'tool_use'
        return after('write')
    if name == 'edit':
        if step == 0 and have('Read'):
            return [tool('Read', {'file_path': f'{WORK}/edit{n}.txt'})], 'tool_use'
        if step == 1 and have('Edit'):
            return [tool('Edit', {'file_path': f'{WORK}/edit{n}.txt', 'old_string': 'beta', 'new_string': 'BETA'})], 'tool_use'
        return after('edit')
    if name == 'plan':
        if step == 0 and PLAN_PATH[0] and have('Write'):
            return [tool('Write', {'file_path': PLAN_PATH[0], 'content': f'# Plan: Add hello{n}.txt\n\n## Context\n\nThe user wants a greeting file in the work dir.\n\n## Steps\n\n- Create {WORK}/hello{n}.txt containing hi\n- Verify with cat\n'})], 'tool_use'
        if step <= 1 and have('ExitPlanMode'):
            inp = {'plan': f'# Plan: Add hello{n}.txt\n\n- Create {WORK}/hello{n}.txt containing hi\n'} if PLAN_HAS_ARG[0] else {}
            return [tool('ExitPlanMode', inp)], 'tool_use'
        return after('plan')

    if name == 'permission':
        if step == 0 and have('Bash'):
            return [text('I need to run one command; this needs your approval.'),
                    tool('Bash', {'command': 'python3 -c "print(\'approved-by-human\')"',
                                  'description': 'Print a harmless marker (fake-api permission scenario)'})], 'tool_use'
        denied = any(r.get('is_error') for r in results)
        verdict = 'The command was **denied**.' if denied else 'The command ran after approval.'
        return [text(verdict + '\n\n' + summarize(results))], 'end_turn'

    if name == 'question':
        if step == 0 and have('AskUserQuestion'):
            return [tool('AskUserQuestion', {'questions': [{
                'question': 'Which colour should the test button be?',
                'header': 'Colour',
                'multiSelect': False,
                'options': [
                    {'label': 'Lime', 'description': 'The brand accent'},
                    {'label': 'Graphite', 'description': 'Neutral and calm'},
                    {'label': 'Coral', 'description': 'Warm and loud'},
                ]}]})], 'tool_use'
        return [text('Thanks, noted your answer:\n\n' + summarize(results))], 'end_turn'

    if name == 'image':
        if step == 0 and have('Read'):
            return [text('Let me open the test image.'), tool('Read', {'file_path': WORK + '/pixel.png'})], 'tool_use'
        images = sum(1 for r in results for c in (r.get('content') if isinstance(r.get('content'), list) else [])
                     if c.get('type') == 'image')
        return [text(f'I received {images} image block(s) in the tool result. It is a small gradient test PNG.')], 'end_turn'

    if name == 'long':
        rounds = max(1, min(arg or 4, 20))
        if step < rounds and have('Read'):
            calls = [tool('Read', {'file_path': WORK + '/README.txt', 'offset': k + 1, 'limit': 1})
                     for k in range(30)]
            return [thinking(f'Round {step + 1} of {rounds}: reading 30 single lines in parallel.'),
                    text(f'Round {step + 1}/{rounds}: reading 30 lines.')] + calls, 'tool_use'
        return [thinking('All rounds done; now the oversized final answer.'), text(long_text(60))], 'end_turn'

    if name == 'slow':
        return [text(f'Slow reply: held the turn for {HOLD} s.')], 'end_turn'

    return [text('Echo (fake-api): ' + prompt[:2000] +
                 '\n\nTry `scenario:markdown`, `scenario:tools`, `scenario:permission`, `scenario:question`, '
                 '`scenario:image`, `scenario:long` or `scenario:slow`.')], 'end_turn'


# ── HTTP ───────────────────────────────────────────────────────────────────

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def json_reply(self, obj, status=200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def sse_start(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Transfer-Encoding', 'chunked')
        self.end_headers()

    def sse(self, event, obj):
        data = f'event: {event}\ndata: {json.dumps(obj)}\n\n'.encode()
        self.wfile.write(f'{len(data):x}\r\n'.encode() + data + b'\r\n')
        self.wfile.flush()

    def sse_end(self):
        self.wfile.write(b'0\r\n\r\n')
        self.wfile.flush()

    def do_GET(self):
        self.json_reply({'object': 'list', 'data': [], 'models': [], 'has_more': False})

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(n)
        try:
            body = json.loads(raw or b'{}')
        except ValueError:
            body = {}
        path = self.path.split('?')[0]
        try:
            if path.endswith('/count_tokens'):
                self.json_reply({'input_tokens': 100})
            elif path.endswith('/messages'):
                self.messages(body, path)
            else:
                self.json_reply({})
        except (BrokenPipeError, ConnectionResetError):
            pass

    def messages(self, body, path):
        msgs = body.get('messages') or []
        offered = [t.get('name') for t in body.get('tools') or []]
        prompt, step, results = locate(msgs)
        raw = json.dumps(body)
        pm = PLANRE.search(raw)
        if pm: PLAN_PATH[0] = pm.group(1)
        for t_ in body.get('tools') or []:
            if t_.get('name') == 'ExitPlanMode':
                PLAN_HAS_ARG[0] = 'plan' in ((t_.get('input_schema') or {}).get('properties') or {})
                log({'exitplan_schema': t_.get('input_schema')})
        main = bool(offered)  # side requests (title, topic, quota) carry no tools
        if main:
            content, stop = plan(prompt, step, results, set(offered))
        else:
            content, stop = [text('OK')], 'end_turn'
        log({'t': round(time.time(), 3), 'path': path, 'main': main, 'stream': bool(body.get('stream')),
             'model': body.get('model'), 'tools': offered, 'msgs': len(msgs), 'step': step,
             'text': prompt[:500], 'reply': [b['type'] + (':' + b['name'] if b['type'] == 'tool_use' else '')
                                             for b in content], 'stop': stop})
        model = body.get('model', 'claude-fake')
        usage = {'input_tokens': 100, 'output_tokens': 50, 'cache_creation_input_tokens': 0, 'cache_read_input_tokens': 0}
        msg_id = next_id('msg')
        if not body.get('stream'):
            self.json_reply({'id': msg_id, 'type': 'message', 'role': 'assistant', 'model': model, 'content': content,
                             'stop_reason': stop, 'stop_sequence': None, 'usage': usage})
            return
        self.sse_start()
        self.sse('message_start', {'type': 'message_start', 'message': {
            'id': msg_id, 'type': 'message', 'role': 'assistant', 'model': model, 'content': [],
            'stop_reason': None, 'stop_sequence': None, 'usage': usage}})
        if main and 'scenario:slow' in prompt:
            end = time.time() + HOLD
            while time.time() < end:
                time.sleep(2)
                self.sse('ping', {'type': 'ping'})
        for i, b in enumerate(content):
            self.block(i, b)
        self.sse('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': stop, 'stop_sequence': None},
                                   'usage': {'output_tokens': 50}})
        self.sse('message_stop', {'type': 'message_stop'})
        self.sse_end()

    def block(self, i, b):
        def delta(d):
            self.sse('content_block_delta', {'type': 'content_block_delta', 'index': i, 'delta': d})
        kind = b['type']
        if kind == 'thinking':
            self.sse('content_block_start', {'type': 'content_block_start', 'index': i,
                                             'content_block': {'type': 'thinking', 'thinking': '', 'signature': ''}})
            for c in chunks(b['thinking']):
                delta({'type': 'thinking_delta', 'thinking': c})
            delta({'type': 'signature_delta', 'signature': b['signature']})
        elif kind == 'text':
            self.sse('content_block_start', {'type': 'content_block_start', 'index': i,
                                             'content_block': {'type': 'text', 'text': ''}})
            for c in chunks(b['text']):
                delta({'type': 'text_delta', 'text': c})
        elif kind == 'tool_use':
            self.sse('content_block_start', {'type': 'content_block_start', 'index': i, 'content_block': {
                'type': 'tool_use', 'id': b['id'], 'name': b['name'], 'input': {}}})
            delta({'type': 'input_json_delta', 'partial_json': json.dumps(b['input'])})
        self.sse('content_block_stop', {'type': 'content_block_stop', 'index': i})


def chunks(s, n=400):
    return [s[i:i + n] for i in range(0, len(s), n)] or ['']


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def server_bind(self):
        # HTTPServer.server_bind does a reverse-DNS getfqdn() that can hang for minutes; not needed here.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = '127.0.0.1', self.server_address[1]


if __name__ == '__main__':
    Server(('127.0.0.1', PORT), Handler).serve_forever()
