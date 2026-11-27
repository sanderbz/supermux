// Live driver for the dialog re-verification (scripts/cc-dialog-verify/). Output lands in
// <outdir>; every key is chosen by the shipped answerDialog() through GET /peek and POST /keys.
//   bun scripts/cc-dialog-live.ts <T dir> <session> <outdir> <case> <scenario> <entryId> <target> [mode]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { answerDialog, sightingKey, type AnswerDeps } from '../src/components/chat/dialog-answer'
import { readLens, type DialogContinuity, type PeekLens } from '../src/components/chat/peek-lens'
import { entryFor, pinFor, type RegistryId } from '../src/components/chat/registry'
import type { KeyName } from '../src/lib/session-input/types'

const [T, session, outdir, name, scenario, entryId, targetArg, mode] = process.argv.slice(2)
const target: number | 'escape' = targetArg === 'escape' ? 'escape' : Number(targetArg)
const url = readFileSync(join(T, 'url'), 'utf8').trim()
const token = readFileSync(join(T, 'token'), 'utf8').trim()
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(url + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined })
  return r.json() as Promise<unknown>
}
type PeekBody = string | { text?: string; content?: string }
const peekText = async (lines: number): Promise<string> => {
  const d = (await api('GET', `/api/sessions/${session}/peek?lines=${lines}`)) as { data?: PeekBody } & PeekBody
  const x: PeekBody = (typeof d === 'object' && d !== null && 'data' in d ? d.data : d) ?? ''
  return typeof x === 'string' ? x : (x.text ?? x.content ?? '')
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
mkdirSync(outdir, { recursive: true })

const summary = (l: PeekLens) =>
  l.dialog
    ? { family: l.dialog.family, variant: l.dialog.variant, caret: l.dialog.caretIndex, key: sightingKey(l.dialog) }
    : null

async function main() {
  await api('POST', `/api/sessions/${session}/send`, { text: '/clear' })
  await sleep(3000)
  // Always set the mode explicitly: a session left in plan mode draws a different
  // (auto-mode fallback) dialog for the same tool call.
  await api('POST', `/api/sessions/${session}/mode`, { mode: mode || 'normal' })
  await sleep(2000)
  await api('POST', `/api/sessions/${session}/send`, { text: scenario })
  let first: PeekLens | null = null
  let firstText = ''
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    firstText = await peekText(60)
    const l = readLens(firstText)
    if (l.dialog) { first = l; break }
  }
  if (!first) throw new Error('no dialog appeared')
  const livePin = pinFor(readLens(await peekText(10000)))
  let n = 0
  const looks: unknown[] = []
  const save = (tag: string, text: string) => writeFileSync(join(outdir, `${tag}.txt`), text)
  const tag0 = `${name}-01-strict`
  save(tag0, firstText)
  looks.push({ tag: tag0, anchor: null, strict: summary(first), returned: summary(first) })
  n = 1
  const deps: AnswerDeps = {
    refresh: async (continuing?: DialogContinuity | null) => {
      const text = await peekText(60)
      n += 1
      const tag = `${name}-${String(n).padStart(2, '0')}-${continuing ? 'continuity' : 'strict'}`
      save(tag, text)
      const strict = readLens(text)
      const returned = continuing ? readLens(text, continuing) : strict
      looks.push({ tag, anchor: continuing ?? null, strict: summary(strict), returned: summary(returned) })
      return returned
    },
    sendKey: async (k: KeyName) => {
      await api('POST', `/api/sessions/${session}/keys`, { key: k })
    },
    pin: livePin,
  }
  const match = entryFor(first, livePin)
  const out = await answerDialog(deps, { entryId: entryId as RegistryId, target, key: sightingKey(first.dialog!) })
  await sleep(4000)
  save(`${name}-99-after`, await peekText(60))
  writeFileSync(
    join(outdir, `${name}-sequence.json`),
    JSON.stringify(
      {
        case: name, session, at: new Date().toISOString(), scenario, livePin, pinUsed: livePin, pinOverridden: false,
        entryId, target, cardDegraded: match.degraded, outcome: out, looks,
      },
      null, 1,
    ) + '\n',
  )
  console.log(name, 'pin', livePin, 'ok', out.ok, 'committed', out.committed, 'sent', JSON.stringify(out.sent), out.ok ? '' : `${out.failure} ${out.detail ?? ''}`)
}
main().catch((e) => { console.error(name, 'ERROR', e.message); process.exit(1) })
