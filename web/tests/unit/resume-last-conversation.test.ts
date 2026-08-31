/**
 * "OPEN WHERE I LEFT OFF" — the pure rules behind the restore.
 *
 * Three load-bearing pieces are pinned here rather than assumed, because each
 * one fails SILENTLY when it is wrong:
 *
 *   1. the persisted slice ROUND-TRIPS an older `supermux-ui` blob — one written
 *      before `lastConversations` existed — instead of throwing or restoring
 *      garbage into someone's roster;
 *   2. the eligibility rule (`restorableConversation`) — exists / in scope /
 *      inside the member's fence / an explicit deep link outranks the memory.
 *      A wrong answer here opens the WRONG company's thread, which is the one
 *      outcome a scoped app may never produce;
 *   3. the cold-start gate — the restore fires once per PAGE LOAD, on the
 *      surface the browser booted onto, and never again.
 */
import { beforeEach, describe, expect, test } from 'bun:test'

import {
  MAX_REMEMBERED_SCOPES,
  isLastConversation,
  readConversation,
  rememberConversation,
  restorableConversation,
  scopeKey,
  type LastConversation,
  type ScopedSession,
} from '@/lib/last-conversation'
import {
  claimConversationRestore,
  conversationRestoreClaimed,
  isColdStartMount,
  resetColdStartForTests,
} from '@/lib/cold-start'

const bot = (name: string): LastConversation => ({ kind: 'bot', name })
const CHANNEL: LastConversation = { kind: 'channel' }

const SESSIONS: ScopedSession[] = [
  { name: 'pa-bot', company_id: null },
  { name: 'acme-assistant', company_id: 7 },
  { name: 'acme-web', company_id: 7 },
  { name: 'globex-ops', company_id: 9 },
]

describe('scopeKey — one entry per browse scope', () => {
  test('HQ and a company never collide', () => {
    expect(scopeKey(null)).toBe('hq')
    expect(scopeKey(7)).toBe('c:7')
    expect(scopeKey(7)).not.toBe(scopeKey(null))
  })
})

describe('isLastConversation — the shape guard', () => {
  test('accepts the two real arms', () => {
    expect(isLastConversation({ kind: 'channel' })).toBe(true)
    expect(isLastConversation({ kind: 'bot', name: 'x' })).toBe(true)
  })

  test('rejects everything a hand-edited or foreign blob could carry', () => {
    for (const v of [
      null,
      undefined,
      'channel',
      42,
      {},
      { kind: 'team', team: 'crew' },
      { kind: 'bot' },
      { kind: 'bot', name: '' },
      { kind: 'bot', name: 3 },
    ]) {
      expect(isLastConversation(v)).toBe(false)
    }
  })
})

describe('the persisted slice ROUND-TRIPS an older blob', () => {
  test('a blob written before the field existed reads as "remember nothing"', () => {
    // Exactly what `zustand/persist` hands back for a v1 blob: every old key
    // present, `lastConversations` absent.
    const oldBlob = {
      viewMode: 'tile',
      hideStopped: false,
      activeCompany: 7,
      botMode: true,
    } as unknown as { lastConversations?: Record<string, LastConversation> }

    expect(readConversation(oldBlob.lastConversations, 'c:7')).toBe(null)
    // …and writing into it produces a well-formed map rather than throwing.
    const next = rememberConversation(oldBlob.lastConversations ?? {}, 'c:7', bot('acme-web'))
    expect(next).toEqual({ 'c:7': bot('acme-web') })
  })

  test('a garbage value survives as an empty memory, never as a throw', () => {
    const junk = 'not-a-map' as unknown as Record<string, LastConversation>
    expect(readConversation(junk, 'c:7')).toBe(null)
    expect(rememberConversation(junk, 'c:7', CHANNEL)).toEqual({ 'c:7': CHANNEL })
  })

  test('a half-typed entry is dropped on read, and swept on the next real write', () => {
    const map = {
      'c:7': { kind: 'bot' } as unknown as LastConversation,
      hq: bot('pa-bot'),
    }
    expect(readConversation(map, 'c:7')).toBe(null)
    // The no-op fast path deliberately returns the map untouched (no store
    // churn); any write that actually changes something rebuilds it, and the
    // rebuild is where the junk goes.
    expect(rememberConversation(map, 'hq', bot('pa-bot'))).toBe(map)
    expect(rememberConversation(map, 'hq', bot('other'))).toEqual({ hq: bot('other') })
  })
})

describe('rememberConversation', () => {
  test('remembers per scope, independently', () => {
    let map: Record<string, LastConversation> = {}
    map = rememberConversation(map, 'hq', bot('pa-bot'))
    map = rememberConversation(map, 'c:7', CHANNEL)
    expect(readConversation(map, 'hq')).toEqual(bot('pa-bot'))
    expect(readConversation(map, 'c:7')).toEqual(CHANNEL)
  })

  test('null FORGETS just that scope (close the pane)', () => {
    let map = rememberConversation(rememberConversation({}, 'hq', bot('pa-bot')), 'c:7', CHANNEL)
    map = rememberConversation(map, 'c:7', null)
    expect(readConversation(map, 'c:7')).toBe(null)
    expect(readConversation(map, 'hq')).toEqual(bot('pa-bot'))
  })

  test('an unchanged, already-freshest write returns the SAME reference (no store churn)', () => {
    const map = rememberConversation({}, 'c:7', bot('acme-web'))
    expect(rememberConversation(map, 'c:7', bot('acme-web'))).toBe(map)
    expect(rememberConversation(map, 'hq', null)).toBe(map)
  })

  test('a changed value is written', () => {
    const map = rememberConversation({}, 'c:7', bot('acme-web'))
    expect(readConversation(rememberConversation(map, 'c:7', bot('acme-ops')), 'c:7')).toEqual(
      bot('acme-ops'),
    )
  })

  test('LRU-capped: the least-recently-opened scope is dropped, never the newest', () => {
    let map: Record<string, LastConversation> = {}
    for (let i = 0; i < MAX_REMEMBERED_SCOPES + 3; i++) {
      map = rememberConversation(map, `c:${i}`, bot(`bot-${i}`))
    }
    expect(Object.keys(map)).toHaveLength(MAX_REMEMBERED_SCOPES)
    expect(readConversation(map, 'c:0')).toBe(null)
    expect(readConversation(map, `c:${MAX_REMEMBERED_SCOPES + 2}`)).toEqual(
      bot(`bot-${MAX_REMEMBERED_SCOPES + 2}`),
    )
  })

  test('re-opening an old scope refreshes it, so the cap drops the truly stale one', () => {
    let map: Record<string, LastConversation> = {}
    for (let i = 0; i < MAX_REMEMBERED_SCOPES; i++) {
      map = rememberConversation(map, `c:${i}`, bot(`bot-${i}`))
    }
    map = rememberConversation(map, 'c:0', bot('bot-0-again'))
    map = rememberConversation(map, 'c:99', bot('newcomer'))
    expect(readConversation(map, 'c:0')).toEqual(bot('bot-0-again'))
    expect(readConversation(map, 'c:1')).toBe(null)
  })
})

describe('restorableConversation — the eligibility rule', () => {
  const base = {
    activeCompany: 7 as number | null,
    sessions: SESSIONS,
    channelAvailable: true,
  }

  test('nothing remembered ⇒ nothing restored', () => {
    expect(restorableConversation({ ...base, saved: null })).toBe(null)
  })

  test('a live, in-scope bot restores', () => {
    expect(restorableConversation({ ...base, saved: bot('acme-web') })).toEqual(bot('acme-web'))
  })

  test('an ARCHIVED / deleted bot restores nothing', () => {
    expect(restorableConversation({ ...base, saved: bot('acme-gone') })).toBe(null)
  })

  test('a bot MOVED to another company restores nothing', () => {
    expect(restorableConversation({ ...base, saved: bot('globex-ops') })).toBe(null)
  })

  test('a company bot is never restored into HQ', () => {
    expect(
      restorableConversation({ ...base, activeCompany: null, saved: bot('acme-web') }),
    ).toBe(null)
  })

  test('an HQ bot is never restored into a company', () => {
    expect(restorableConversation({ ...base, saved: bot('pa-bot') })).toBe(null)
  })

  test('an HQ bot restores in HQ (undefined company_id folds to HQ)', () => {
    expect(
      restorableConversation({
        ...base,
        activeCompany: null,
        sessions: [{ name: 'pa-bot' }],
        saved: bot('pa-bot'),
      }),
    ).toEqual(bot('pa-bot'))
  })

  test('the channel restores only where it EXISTS', () => {
    expect(restorableConversation({ ...base, saved: CHANNEL })).toEqual(CHANNEL)
    expect(restorableConversation({ ...base, saved: CHANNEL, channelAvailable: false })).toBe(null)
    // HQ has no channel at all.
    expect(
      restorableConversation({ ...base, activeCompany: null, saved: CHANNEL }),
    ).toBe(null)
  })

  test('a garbage remembered value restores nothing', () => {
    expect(
      restorableConversation({
        ...base,
        saved: { kind: 'team', team: 'crew' } as unknown as LastConversation,
      }),
    ).toBe(null)
  })

  describe('THE MEMBER LOCK', () => {
    test('a member restores inside their own company', () => {
      expect(
        restorableConversation({ ...base, memberCompany: 7, saved: bot('acme-web') }),
      ).toEqual(bot('acme-web'))
    })

    test('a member NEVER restores outside their fence, even if the scope drifted', () => {
      expect(
        restorableConversation({
          ...base,
          activeCompany: 9,
          memberCompany: 7,
          sessions: SESSIONS,
          saved: bot('globex-ops'),
        }),
      ).toBe(null)
      expect(
        restorableConversation({
          ...base,
          activeCompany: null,
          memberCompany: 7,
          saved: CHANNEL,
        }),
      ).toBe(null)
    })
  })

  describe('AN EXPLICIT DEEP LINK WINS', () => {
    test('a deep link outranks an otherwise-valid memory', () => {
      expect(
        restorableConversation({ ...base, saved: bot('acme-web'), deepLinkActive: true }),
      ).toBe(null)
      expect(
        restorableConversation({ ...base, saved: CHANNEL, deepLinkActive: true }),
      ).toBe(null)
    })
  })
})

describe('the COLD-START gate', () => {
  beforeEach(() => resetColdStartForTests())

  test('memoised, so StrictMode’s double mount gets ONE answer', () => {
    // BOOT_PATH is `/` under bun (no window) — the first caller decides.
    expect(isColdStartMount('/')).toBe(true)
    expect(isColdStartMount('/')).toBe(true)
    // A later mount elsewhere re-uses the first answer; the second restore is
    // stopped by the claim below, never by re-asking this.
    expect(isColdStartMount('/files')).toBe(true)
  })

  test('a page that booted elsewhere is not a cold start of this surface', () => {
    expect(isColdStartMount('/files')).toBe(false)
    expect(isColdStartMount('/')).toBe(false)
  })

  test('a trailing slash is the same path', () => {
    expect(isColdStartMount('/')).toBe(true)
  })

  test('the restore is claimed EXACTLY once per page load', () => {
    expect(conversationRestoreClaimed()).toBe(false)
    expect(claimConversationRestore()).toBe(true)
    expect(conversationRestoreClaimed()).toBe(true)
    expect(claimConversationRestore()).toBe(false)
    expect(claimConversationRestore()).toBe(false)
  })

  test('a fresh page load claims again', () => {
    expect(claimConversationRestore()).toBe(true)
    resetColdStartForTests()
    expect(conversationRestoreClaimed()).toBe(false)
    expect(claimConversationRestore()).toBe(true)
  })
})
