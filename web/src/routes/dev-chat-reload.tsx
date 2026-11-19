import * as React from 'react'
import { ChatConversation, PHONE_QUERY } from '@/components/chat/conversation'
import { ProvisionalTail } from '@/components/chat/provisional-tail'
import { useChatTurn } from '@/components/chat/use-chat-turn'
import { useTranscriptScroll } from '@/components/chat/use-transcript-scroll'
import { useMediaQuery } from '@/hooks/use-media-query'
import { liveStates } from './dev-chat-live.fixture'

/** Controlled transport, production hook/reducer/backlog/conversation. The
 * browser test supplies all API and WS responses; no real agent is involved. */
export default function DevChatReload() {
  const [now] = React.useState(Date.now)
  const phone = useMediaQuery(PHONE_QUERY)
  const session = React.useMemo(() => ({
    ...liveStates(now)[0].session,
    name: 'reload-fixture',
    display_name: 'Reload fixture',
    provider: 'codex',
    status: 'active' as const,
  }), [now])
  const turn = useChatTurn(session.name, session)
  const scroll = useTranscriptScroll(session.name, {
    hasOlder: false, loadingOlder: false, loadOlder: () => {},
  })
  return <div data-grok="" className="h-dvh bg-paper">
    <output data-testid="reload-source-state">{turn.tail.state}:{String(turn.tail.seeded)}</output>
    <ChatConversation name={session.name} session={session} nowMs={now}
      items={turn.items} turnStart={turn.turnStart}
      scrollRef={scroll.scrollRef} onScroll={scroll.onScroll} onReserveGrew={scroll.onReserveGrew}
      provisional={turn.showProvisional ? <ProvisionalTail name={session.name} show provider="codex" surface={phone ? 'phone' : 'desktop'} /> : null}
      composer={<div aria-label="Fixture composer">Agent is working</div>}
    />
  </div>
}
