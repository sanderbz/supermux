// The asks API — `server/src/asks`, documented in `docs/ASKS.md`.
//
// An ask is one moment an agent waits on a human: a permission dialog, an
// AskUserQuestion, an MCP form, a board needs-input, a needs-you notification.
// A permission / question / form is answered through Claude Code's own
// `PermissionRequest` / `Elicitation` hook (supermux's decision hook): the
// answer is the hook's output, so it lands in Claude Code's dialog the native
// way — no keystrokes, no screen reading, no dependence on which Claude Code
// build draws the dialog.
//
// `answerable` is the server's word on whether an answer can be delivered RIGHT
// NOW (for a hook kind: a decision hook is connected and waiting). A session
// whose hooks predate the decision hook records its asks but cannot answer
// them until it restarts; chat falls back to its older paths for those.

import { settingsRequest } from './client'

export type AskKind = 'permission' | 'question' | 'elicitation' | 'needs_input' | 'waiting'
export type AskState = 'open' | 'answered' | 'dismissed' | 'resolved'

/** One question of an AskUserQuestion call — `detail.questions[i]`. */
export interface AskQuestion {
  question: string
  header?: string
  multi_select: boolean
  options: { label: string; description?: string }[]
}

/** `detail` of a `permission` ask: the secret-conscious summary the session
 *  card shows, never the raw command (that is `input.tool_input`, live only). */
export interface AskPermissionDetail {
  tool?: string
  summary?: string
  kind?: string
  mode?: string
  /** How many "always allow" updates Claude offered. */
  suggestions?: number
  agent_type?: string
}

/** One of Claude's own "Yes, and …" permission updates, as the hook received
 *  it (`input.permission_suggestions[i]`). Picked by index on the answer. */
export interface PermissionSuggestion {
  type?: string
  rules?: { toolName?: string; ruleContent?: string }[]
  behavior?: string
  mode?: string
  directories?: string[]
  destination?: string
  [key: string]: unknown
}

export interface Ask {
  id: string
  session: string
  kind: AskKind
  state: AskState
  answerable: boolean
  detail: Record<string, unknown>
  resolution?: Record<string, unknown>
  issue_id?: string
  created_ms: number
  updated_ms: number
  resolved_ms?: number
  rev: number
  /** LIVE ONLY (`GET /api/asks/{id}` while a decision hook waits): the real
   *  tool input and Claude's offered permission updates. Never on SSE. */
  input?: {
    tool_input?: Record<string, unknown>
    permission_suggestions?: PermissionSuggestion[]
  }
}

/** The `asks` SSE frame. */
export interface AskFrame {
  op: 'opened' | 'updated' | 'closed'
  rev: number
  ask: Ask
}

/** A question's answer: a label, a list of labels (multi-select), or the
 *  dialog's "Type something" row (`other`), optionally beside chosen labels. */
export type QuestionAnswerValue = string | string[] | { selected: string[]; other: string }

export type AskAnswer =
  | { decision: 'allow'; permissions?: number[] }
  | { decision: 'deny'; message?: string; interrupt?: boolean }
  | { answers: Record<string, QuestionAnswerValue> }
  | { action: 'accept'; content?: Record<string, unknown> }
  | { action: 'decline' | 'cancel' }
  | { text: string }

/** The kinds whose answer goes through a waiting decision hook. */
export const HOOK_KINDS: readonly AskKind[] = ['permission', 'question', 'elicitation']

/** Parse an `asks` frame defensively — a drifting payload must not crash the
 *  surface that listens. */
export function askFromFrame(payload: unknown): AskFrame | null {
  const f = payload as Partial<AskFrame> | null
  if (!f || typeof f !== 'object' || !f.ask || typeof f.ask !== 'object') return null
  const a = f.ask as Partial<Ask>
  if (typeof a.id !== 'string' || typeof a.session !== 'string' || typeof a.kind !== 'string') return null
  return { op: f.op ?? 'updated', rev: Number(f.rev ?? a.rev ?? 0), ask: a as Ask }
}

/** The questions of a `question` ask, or `[]`. */
export function askQuestions(ask: Ask): AskQuestion[] {
  const qs = (ask.detail as { questions?: unknown }).questions
  if (!Array.isArray(qs)) return []
  return qs.filter(
    (q): q is AskQuestion =>
      !!q && typeof q === 'object' && typeof (q as AskQuestion).question === 'string' &&
      Array.isArray((q as AskQuestion).options),
  )
}

export const asksApi = {
  /** Every open ask (owner/admin). */
  open: async (): Promise<Ask[]> => {
    const body = await settingsRequest<{ asks?: Ask[] }>('/api/asks?state=open&limit=1000')
    return Array.isArray(body?.asks) ? body.asks : []
  },
  /** One ask, with its live `input` while a decision hook waits. */
  get: (id: string): Promise<Ask> => settingsRequest<Ask>(`/api/asks/${encodeURIComponent(id)}`),
  /** Answer an ask. A 200 means DELIVERED: for a permission / question / form
   *  the ask's final verdict arrives later as an `updated` frame (the terminal
   *  may have answered first — docs/ASKS.md "Delivered is not applied"). */
  answer: (id: string, answer: AskAnswer, client = 'chat'): Promise<Ask> =>
    settingsRequest<Ask>(`/api/asks/${encodeURIComponent(id)}/answer`, {
      method: 'POST',
      body: JSON.stringify({ ...answer, client }),
    }),
  dismiss: (id: string, client = 'chat'): Promise<Ask> =>
    settingsRequest<Ask>(`/api/asks/${encodeURIComponent(id)}/dismiss`, {
      method: 'POST',
      body: JSON.stringify({ client }),
    }),
}
