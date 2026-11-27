#!/usr/bin/env python3
"""Helpers for weekly.sh: compare a fresh capture set against the newest corpus, and copy it in redacted.

  corpus.py compare <new-dir> <base-dir> <T>   → prints JSON {identical, compared, diffs[]}; exit 0 either way
  corpus.py redact  <src-dir> <dst-dir>        → copies every file, replacing the shell prompt <user>@<host>
                                                  by an equal-width placeholder
  corpus.py add-version <verified.ts> <v>      → appends <v> to CC_VERIFIED_CURRENT (idempotent)

What "identical" means: for each captured dialog, the block from its title line (Bash command / Create file /
Edit file / Ready to code?) is compared from the QUESTION line down to the end of the footer — question, every
row, every sub-hint, the footer — whitespace collapsed (a wrap is not a change), with only the values the run
itself chose normalised: the test dir <T>, artifact numbers (bash5.txt), the plan file's random name, and the
`↑ N more lines` scroll hint (it depends on how long the plan body is).
"""
import json
import os
import re
import socket
import sys

PAIRS = [  # (file in the new set, file in the base corpus) — both written by capture-all.sh
    ('01-bash-access-caret1.txt', '01-bash-access-caret1.txt'),
    ('01-bash-access-caret2.txt', '01-bash-access-caret2.txt'),
    ('01-bash-access-caret3.txt', '01-bash-access-caret3.txt'),
    ('01-bash-access-caret4.txt', '01-bash-access-caret4.txt'),
    ('05-bash-read-caret1.txt', '05-bash-read-caret1.txt'),
    ('06-bash-cmdrule-caret1.txt', '06-bash-cmdrule-caret1.txt'),
    ('20-write-caret1.txt', '20-write-caret1.txt'),
    ('20-write-caret2.txt', '20-write-caret2.txt'),
    ('30-edit-caret1.txt', '30-edit-caret1.txt'),
    ('30-edit-caret2.txt', '30-edit-caret2.txt'),
    ('40-plan-caret1.txt', '40-plan-caret1.txt'),
    ('40-plan-caret2.txt', '40-plan-caret2.txt'),
    ('40-plan-caret3.txt', '40-plan-caret3.txt'),
]
TITLE = re.compile(r'^ (Bash command|Create file|Edit file|Ready to code\?)')
QUESTION = re.compile(r'^ (Do you want|Claude has written up a plan|Would you like)')
END = re.compile(r'^─+ \S')  # the session's own bottom rule (`──── spike-x ─`)


def block(path, t):
    lines = open(path, encoding='utf-8').read().splitlines()
    starts = [i for i, l in enumerate(lines) if TITLE.match(l)]
    if not starts:
        return None
    blk = lines[starts[-1]:]
    title = blk[0].strip()
    q = next((i for i, l in enumerate(blk) if QUESTION.match(l)), None)
    if q is None:
        return None
    out = []
    for l in blk[q:]:
        if END.match(l):
            break
        out.append(l)
    text = ' '.join(' '.join(out).split())
    for tdir in {d for d in (t, os.path.realpath(t)) if len(d) > 8}:
        text = text.replace(tdir, '<T>')
    text = re.sub(r'/private/tmp/claude-501/[A-Za-z0-9]+', '<T>', text)  # the base corpus's own test dirs
    text = re.sub(r'\b(bash|py|write|edit|hello)\d+\.txt', r'\1N.txt', text)
    text = re.sub(r'plans/[A-Za-z0-9-]+\.md', 'plans/P.md', text)
    text = re.sub(r' ?↑ \d+ more lines?', '', text)  # a scroll hint that depends on the plan's length
    return title + ' | ' + text


def compare(new, base, t):
    diffs, n = [], 0
    for a, b in PAIRS:
        pa, pb = os.path.join(new, a), os.path.join(base, b)
        if not os.path.exists(pa) or not os.path.exists(pb):
            diffs.append({'file': a, 'why': 'missing', 'new': os.path.exists(pa), 'base': os.path.exists(pb)})
            continue
        x, y = block(pa, t), block(pb, t)
        n += 1
        if x is None or x != y:
            diffs.append({'file': a, 'new': x, 'base': y})
    return {'identical': not diffs, 'compared': n, 'diffs': diffs}


def redact(src, dst):
    user = os.environ.get('USER', '')
    host = socket.gethostname().split('.')[0]
    real = f'{user}@{host}'
    ph = ('operator@supermux-host-' + '0' * 64)[:len(real)] if len(real) >= 9 else 'x' * len(real)
    n = 0
    for root, _, files in os.walk(src):
        for f in files:
            rel = os.path.relpath(os.path.join(root, f), src)
            out = os.path.join(dst, rel)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            text = open(os.path.join(root, f), encoding='utf-8').read()
            if real and user:
                text = text.replace(real, ph)
            open(out, 'w', encoding='utf-8').write(text)
            n += 1
    print(n)


def add_version(path, v):
    s = open(path, encoding='utf-8').read()
    if f"'{v}'" in s:
        return
    head, sep, tail = s.partition('] as const')
    if not sep:
        sys.exit('verified.ts: no list end found')
    open(path, 'w', encoding='utf-8').write(head.rstrip() + f"\n  '{v}',\n" + sep + tail)


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'compare':
        print(json.dumps(compare(sys.argv[2], sys.argv[3], sys.argv[4]), ensure_ascii=False, indent=1))
    elif cmd == 'redact':
        redact(sys.argv[2], sys.argv[3])
    elif cmd == 'add-version':
        add_version(sys.argv[2], sys.argv[3])
    else:
        sys.exit(__doc__)
