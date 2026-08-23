// The "Create your own connector" handoff payload (§2 of the design): the catalog
// digest ranking + the composed `<supermux-connector-task>` message. Pure, so it
// tests without a DOM.
import { describe, expect, test } from 'bun:test'

import {
  CONNECTOR_TASK_TAG,
  catalogDigest,
  composeConnectorTask,
  installedIds,
  scoreCard,
} from '../../src/components/store/connector-task'
import type { ConnectorCard } from '../../src/lib/api/connectors'

function card(partial: Partial<ConnectorCard> & { id: string }): ConnectorCard {
  return {
    kind: 'mcp_catalog',
    display_name: partial.id,
    icon: '',
    description: '',
    tools: [],
    credentials: [],
    source: 'catalog',
    ...partial,
  }
}

const CARDS: ConnectorCard[] = [
  card({ id: 'pmcp-linear', display_name: 'Linear', description: 'Issues', categories: ['developer'] }),
  card({ id: 'pmcp-github', display_name: 'GitHub', description: 'Repos', categories: ['developer'], source: 'local' }),
  card({ id: 'slack', display_name: 'Slack', description: 'Chat', categories: ['communication'], source: 'local' }),
]

describe('catalog digest', () => {
  test('ranks the closest match first', () => {
    const rows = catalogDigest('Linear', CARDS)
    expect(rows[0].id).toBe('pmcp-linear')
    expect(rows[0].name).toBe('Linear')
    expect(rows[0].category).toBe('developer')
  })

  test('name/id hits outweigh a prose-only mention', () => {
    const gh = card({ id: 'pmcp-github', display_name: 'GitHub', description: '' })
    const other = card({ id: 'x', display_name: 'X', description: 'mentions github in passing' })
    expect(scoreCard('github', gh)).toBeGreaterThan(scoreCard('github', other))
  })

  test('falls back to a representative slice when nothing matches', () => {
    const rows = catalogDigest('zzzznomatch', CARDS, 2)
    expect(rows.length).toBe(2)
  })

  test('installedIds are the local rows only', () => {
    expect(installedIds(CARDS).sort()).toEqual(['pmcp-github', 'slack'])
  })
})

describe('composeConnectorTask', () => {
  const msg = composeConnectorTask({
    request: '  Linear  ',
    notes: 'API-key auth; create + list issues',
    cards: CARDS,
  })

  test('is wrapped in the connector-task tag with a trimmed goal', () => {
    expect(msg.startsWith(`<${CONNECTOR_TASK_TAG}>`)).toBe(true)
    expect(msg.trimEnd().endsWith(`</${CONNECTOR_TASK_TAG}>`)).toBe(true)
    expect(msg).toContain('GOAL: Author a supermux connector for: "Linear".')
  })

  test('carries the notes, the digest, the installed ids and the guide pointer', () => {
    expect(msg).toContain('NOTES FROM THE USER: API-key auth; create + list issues')
    expect(msg).toContain('pmcp-linear · Linear · developer')
    expect(msg).toContain('Already installed in this store: [ pmcp-github, slack ]')
    expect(msg).toContain('/supermux-connector')
  })

  test('omits the notes line when there are none', () => {
    const bare = composeConnectorTask({ request: 'Linear', cards: CARDS })
    expect(bare).not.toContain('NOTES FROM THE USER')
  })

  // The message rides `POST /api/sessions/{name}/send`, whose funnel refuses the
  // three PROVENANCE wrappers (server `agents::delegate::wrapper_markup`). Our tag
  // must not collide with any of them, or every handoff would 400.
  test('contains none of the refused provenance wrappers', () => {
    const lower = msg.toLowerCase()
    for (const t of ['supermux-delegation', 'supermux-schedule', 'supermux-human']) {
      expect(lower.includes(`<${t}`)).toBe(false)
      expect(lower.includes(`</${t}`)).toBe(false)
    }
  })
})
