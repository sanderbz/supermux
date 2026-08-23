// The "Create your own connector" handoff payload — a single composed chat
// message the store POSTs into a bot's Claude (via `POST /api/sessions/{name}/send`,
// the `restSessionInput` submit path). Built entirely from already-loaded store
// state so the server stays thin (§2 of the design).
//
// The message is wrapped in a `<supermux-connector-task>` tag — a recognizable,
// machine-parsable instruction block. It is NOT one of the three provenance
// wrappers the send funnel refuses (`<supermux-delegation|schedule|human>`,
// `agents::delegate::wrapper_markup`), so it rides the ordinary owner/human send
// unaltered.
//
// Pure + DOM-less on purpose (no `window`, no API client), so the digest and the
// full compose are unit-testable without a browser.
import type { ConnectorCard } from '@/lib/api/connectors'

/** The instruction-block tag the bot parses the task out of. */
export const CONNECTOR_TASK_TAG = 'supermux-connector-task'

/** How many nearest-existing connectors the catalog digest carries. Compact — the
 *  digest is a "don't reinvent it" fence, not the whole catalog. */
export const DIGEST_LIMIT = 8

export interface ConnectorTaskInput {
  /** The service / API / URL the user wants connected. */
  request: string
  /** Optional free text: auth type, which actions, a docs URL. */
  notes?: string
  /** The merged store cards the grid already holds — the digest source. */
  cards: ConnectorCard[]
}

export interface DigestRow {
  id: string
  name: string
  category: string
  /** Match score against the request (higher = closer). Internal ranking only. */
  score: number
}

/** The connector's primary chip-rail category (skips the `featured` meta tag). */
function primaryCategory(c: ConnectorCard): string {
  return (c.categories ?? []).find((x) => x !== 'featured') ?? '—'
}

/** A blunt token-overlap score of the request against a card's id / name /
 *  description / categories. Name + id hits weigh most (a "Linear" request should
 *  surface `pmcp-linear` above a card that merely mentions "linear" in prose). */
export function scoreCard(request: string, c: ConnectorCard): number {
  const tokens = request.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return 0
  const name = c.display_name.toLowerCase()
  const id = c.id.toLowerCase()
  const desc = c.description.toLowerCase()
  const cats = (c.categories ?? []).join(' ').toLowerCase()
  let s = 0
  for (const t of tokens) {
    if (name.includes(t)) s += 5
    if (id.includes(t)) s += 4
    if (cats.includes(t)) s += 2
    if (desc.includes(t)) s += 1
  }
  return s
}

/** The top-N nearest existing connectors for a request. When nothing scores (a
 *  brand-new service), fall back to the first N cards so the bot still sees a
 *  representative slice of what already exists. */
export function catalogDigest(
  request: string,
  cards: ConnectorCard[],
  limit = DIGEST_LIMIT,
): DigestRow[] {
  const rows: DigestRow[] = cards.map((c) => ({
    id: c.id,
    name: c.display_name,
    category: primaryCategory(c),
    score: scoreCard(request, c),
  }))
  const matched = rows.filter((r) => r.score > 0).sort((a, b) => b.score - a.score)
  return (matched.length > 0 ? matched : rows).slice(0, limit)
}

/** The ids of the connectors ALREADY installed in this store (local rows). */
export function installedIds(cards: ConnectorCard[]): string[] {
  return cards.filter((c) => c.source === 'local').map((c) => c.id)
}

/** Compose the `<supermux-connector-task>` message from already-loaded state. */
export function composeConnectorTask({ request, notes, cards }: ConnectorTaskInput): string {
  const svc = request.trim()
  const digest = catalogDigest(svc, cards)
  const installed = installedIds(cards)
  const trimmedNotes = notes?.trim()

  const lines: string[] = [`<${CONNECTOR_TASK_TAG}>`]
  lines.push(`GOAL: Author a supermux connector for: "${svc}".`)
  if (trimmedNotes) lines.push(`NOTES FROM THE USER: ${trimmedNotes}`)
  lines.push('')
  lines.push("BEFORE YOU BUILD — check the catalog so you don't reinvent one:")
  lines.push(' Nearest existing connectors (id · name · category):')
  for (const d of digest) lines.push(`   ${d.id} · ${d.name} · ${d.category}`)
  lines.push('   ↳ if one already fits, STOP and just connect it instead of building a duplicate.')
  lines.push(` Already installed in this store: [ ${installed.length ? installed.join(', ') : 'none'} ]`)
  lines.push('')
  lines.push('HOW TO DO IT THE PROPER WAY:')
  lines.push(' Read the guide: /supermux-connector   (manifest shape, MCP server contract,')
  lines.push(' how to register so it shows in the store live, how to make it company-accessible,')
  lines.push(' secret handling via the vault). Follow it exactly — do NOT inline secrets.')
  lines.push('')
  lines.push('WHEN DONE: prepare the manifest and ask the owner to one-tap Register it (the admin')
  lines.push('import — a connector definition is global, so a human approves it), then grant it to')
  lines.push('this company and confirm the tools work.')
  lines.push(`</${CONNECTOR_TASK_TAG}>`)
  return lines.join('\n')
}
