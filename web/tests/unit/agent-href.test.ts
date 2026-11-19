// The bot's ADDRESS — `/agent/<name>` — and what following one means.
//
// Two facts guarded here, both of which used to be wrong in the app:
//   · a link to a bot pointed at the TERMINAL, not at the thread you talk in;
//   · a link to a bot in another company landed you in the wrong SCOPE, looking
//     at a roster that does not contain it.
// The second is why the resolver exists at all: the caller has to know it must
// switch the company BEFORE it selects, because switching re-homes the pane.

import { describe, expect, test } from 'bun:test'

import {
  agentHref,
  isAgentPath,
  resolveAgentDeepLink,
  type AgentDeepLinkRow,
} from '../../src/lib/agent-href'

const roster: AgentDeepLinkRow[] = [
  { name: 'folderwijzer', company_id: null },
  { name: 'quill', company_id: 3 },
  { name: 'patch' }, // no company_id on the wire ⇒ HQ, same as null
]

describe('agentHref', () => {
  test('addresses the bot by name', () => {
    expect(agentHref('folderwijzer')).toBe('/agent/folderwijzer')
  })

  test('encodes a name that would otherwise change the path', () => {
    // The old call sites interpolated the raw name: a bot named with a slash
    // produced a URL that resolved to a different route entirely.
    expect(agentHref('deploy fix')).toBe('/agent/deploy%20fix')
    expect(agentHref('a/b')).toBe('/agent/a%2Fb')
    expect(agentHref('100%')).toBe('/agent/100%25')
  })

  test('round-trips through the decoding react-router does', () => {
    expect(decodeURIComponent(agentHref('a/b').slice('/agent/'.length))).toBe('a/b')
  })
})

describe('isAgentPath', () => {
  test('recognises the doorway the shell must treat as home', () => {
    expect(isAgentPath('/agent/quill')).toBe(true)
    expect(isAgentPath('/')).toBe(false)
    expect(isAgentPath('/agent')).toBe(false)
    expect(isAgentPath('/agents/quill')).toBe(false)
    expect(isAgentPath('/focus/quill')).toBe(false)
  })
})

describe('resolveAgentDeepLink', () => {
  test('a bot in the scope you are browsing is just selected', () => {
    expect(resolveAgentDeepLink('folderwijzer', roster, null)).toEqual({
      kind: 'select',
      name: 'folderwijzer',
      company: null,
    })
    expect(resolveAgentDeepLink('quill', roster, 3)).toEqual({
      kind: 'select',
      name: 'quill',
      company: 3,
    })
  })

  test('a bot in ANOTHER company asks for the switch first', () => {
    expect(resolveAgentDeepLink('quill', roster, null)).toEqual({
      kind: 'switch',
      name: 'quill',
      company: 3,
    })
    // …and back out of a company to HQ, which is the same question mirrored.
    expect(resolveAgentDeepLink('folderwijzer', roster, 3)).toEqual({
      kind: 'switch',
      name: 'folderwijzer',
      company: null,
    })
  })

  test('a missing company_id is HQ, not a company of its own', () => {
    expect(resolveAgentDeepLink('patch', roster, null).kind).toBe('select')
    expect(resolveAgentDeepLink('patch', roster, 3)).toEqual({
      kind: 'switch',
      name: 'patch',
      company: null,
    })
  })

  test('a name no row carries is unknown — and says which name', () => {
    expect(resolveAgentDeepLink('ghost', roster, null)).toEqual({
      kind: 'unknown',
      name: 'ghost',
    })
    // The caller only asks once the query resolved; an empty list is then an
    // empty roster and every link into it is honestly unknown.
    expect(resolveAgentDeepLink('quill', [], null).kind).toBe('unknown')
  })

  test('matching is exact — a prefix is a different bot', () => {
    expect(resolveAgentDeepLink('quil', roster, 3).kind).toBe('unknown')
    expect(resolveAgentDeepLink('quillx', roster, 3).kind).toBe('unknown')
  })
})
