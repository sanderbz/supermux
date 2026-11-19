import * as React from 'react'
import { ChatConversation } from '@/components/chat/conversation'
import { toDisplayList, type ChatEntry } from '@/components/chat/entries'
import { useTranscriptScroll } from '@/components/chat/use-transcript-scroll'
import { liveStates } from './dev-chat-live.fixture'

/** Offline browser regression bench. Production conversation + scroll owner;
 * fixture changes stand in for network commits without touching a real agent. */
export default function DevChatScroll() {
  const [now] = React.useState(Date.now)
  const [sessionKey, setSessionKey] = React.useState('first')
  const make = React.useCallback((i: number): ChatEntry => ({ uuid: 'message-' + i, kind: i % 2 ? 'assistant' : 'prompt', ts: (now - 100_000 + i * 1000) / 1000, text: `Message ${i}. ` + 'Keep the conversation steady while reading earlier messages. '.repeat(4) }), [now])
  const [entries, setEntries] = React.useState(() => Array.from({ length: 40 }, (_, i) => make(39 - i)))
  const [hidden, setHidden] = React.useState(false)
  const [height, setHeight] = React.useState<number | null>(null)
  const [draft, setDraft] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const loadOlder = React.useCallback(() => {
    if (loading) return
    setLoading(true)
    setTimeout(() => { setEntries(prev => { const min = Math.min(...prev.map(e => Number(e.uuid.slice(8)))); return [...prev, ...Array.from({ length: 10 }, (_, i) => make(min - i - 1))] }); setLoading(false) }, 300)
  }, [loading, make])
  const scroll = useTranscriptScroll(sessionKey, { hasOlder: false, loadingOlder: loading, loadOlder })
  const items = React.useMemo(() => toDisplayList(entries), [entries])
  React.useEffect(() => {
    const api = {
      append: () => setEntries(prev => [make(Math.max(...prev.map(e => Number(e.uuid.slice(8)))) + 1), ...prev]),
      prepend: loadOlder,
      growEarlier: () => setEntries(prev => prev.map((entry, i) => i === prev.length - 1 ? { ...entry, text: entry.text + '\n\n' + 'Earlier content expanded. '.repeat(100) } : entry)),
      resize: (h: number | null) => setHeight(h), hidden: (value: boolean) => setHidden(value),
      reset: () => { setSessionKey('second'); setDraft(''); setEntries(Array.from({ length: 5 }, (_, i) => make(204 - i))) },
      jump: scroll.jumpToBottom,
    }
    Object.assign(window, { __chatScroll: api })
    return () => { delete (window as unknown as { __chatScroll?: unknown }).__chatScroll }
  }, [loadOlder, scroll.jumpToBottom, make])
  return <div data-grok="" className="h-dvh bg-paper" style={{ height: height ?? '100dvh', display: hidden ? 'none' : undefined }}>
    <ChatConversation name={sessionKey} session={{ ...liveStates(now)[0].session, name: sessionKey }} nowMs={now} items={items} turnStart={null}
      scrollRef={scroll.scrollRef} onScroll={scroll.onScroll} onReserveGrew={scroll.onReserveGrew}
      showJumpToBottom={scroll.showJump} onJumpToBottom={scroll.jumpToBottom} hasOlder loadingOlder={loading} onLoadOlder={loadOlder}
      composer={<textarea data-testid="scroll-composer" aria-label="Message" value={draft} onChange={e => setDraft(e.target.value)} style={{ width: '100%', height: draft.length > 20 ? 140 : 64 }} />}
      provisional={<details key={sessionKey} data-testid="scroll-receipt"><summary>Inspect saved tool output</summary><div style={{ height: 350 }}>Finished tool details</div></details>} />
  </div>
}
