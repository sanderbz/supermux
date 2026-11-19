import * as React from 'react'
import { ChatConversation, PHONE_QUERY } from '@/components/chat/conversation'
import { ChatComposer } from '@/components/chat/composer'
import { useComposer } from '@/components/chat/use-composer'
import { usePendingSends } from '@/components/chat/use-pending-sends'
import {
  attachmentSentence,
  retryAttachmentsUnchanged,
} from '@/components/chat/composer-insert'
import { useTranscriptScroll } from '@/components/chat/use-transcript-scroll'
import { EMPTY_LENS } from '@/components/chat/peek-lens'
import { restSessionInput } from '@/lib/session-input'
import { SessionError } from '@/lib/api/sessions'
import { useMediaQuery } from '@/hooks/use-media-query'
import type { StagedAttachment } from '@/components/focus-mode/use-staged-attachments'
import { liveStates } from './dev-chat-live.fixture'

/** Offline production send/composer regression bench. No real session endpoint
 * is contacted; the first mocked POST refuses before writing to a terminal. */
export default function DevChatRetry() {
  const [now] = React.useState(Date.now)
  const [name] = React.useState(() => `retry-fixture-${now}`)
  const phone = useMediaQuery(PHONE_QUERY)
  const [attachments, setAttachments] = React.useState<StagedAttachment[]>([])
  const [transport] = React.useState(() => {
    const requests: Array<{ text: string; send_id: string }> = []
    let response: (() => void) | null = null
    return {
      requests: () => requests,
      accept: () => response?.(),
      request: (_url: string, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)))
        if (requests.length === 1)
          return Promise.reject(
            new SessionError(
              'conflict: session has an unsent terminal draft',
              409,
            ),
          )
        return new Promise<void>((resolve) => {
          response = resolve
        })
      },
    }
  })
  const peek = React.useMemo(() => ({ refresh: async () => EMPTY_LENS }), [])
  const input = React.useMemo(
    () => restSessionInput(name, { request: transport.request }),
    [name, transport],
  )
  const reset = React.useCallback(() => setAttachments([]), [])
  const readyPaths = React.useCallback(
    () =>
      attachments
        .filter((a) => !a.uploading && !a.error && a.path)
        .map((a) => a.path!),
    [attachments],
  )
  const pending = usePendingSends({
    name,
    input,
    peek,
    entries: [],
    active: false,
    onRetrySent: (send) => {
      if (retryAttachmentsUnchanged(attachments, send.attachmentPrefix)) reset()
    },
  })
  const composer = useComposer({
    name,
    input: pending.input,
    active: false,
    peek,
    getOutgoingPrefix: () => attachmentSentence(readyPaths()),
    onSent: reset,
  })
  const scroll = useTranscriptScroll(name, {
    hasOlder: false,
    loadingOlder: false,
    loadOlder: () => {},
  })
  React.useEffect(() => {
    const api = {
      requests: transport.requests,
      accept: transport.accept,
      attach: (uploading = false) =>
        setAttachments((prev) => [
          ...prev,
          {
            id: `file-${prev.length}`,
            name: uploading ? 'new-upload.png' : 'saved-image.png',
            uploading,
            path: uploading ? null : '/fixture/saved-image.png',
            previewUrl: null,
          },
        ]),
    }
    Object.assign(window, { __chatRetry: api })
    return () => {
      delete (window as unknown as { __chatRetry?: unknown }).__chatRetry
    }
  }, [transport])
  return (
    <div data-grok="" className="h-dvh bg-paper">
      <ChatConversation
        name={name}
        session={{
          ...liveStates(now)[0].session,
          name,
          status: 'idle',
          display_name: 'Retry fixture',
        }}
        nowMs={now}
        items={[]}
        turnStart={null}
        pending={pending.items}
        onRetryPending={pending.retry}
        onDismissPending={pending.dismiss}
        scrollRef={scroll.scrollRef}
        onScroll={scroll.onScroll}
        onReserveGrew={scroll.onReserveGrew}
        composer={
          <ChatComposer
            name={name}
            label="Retry fixture"
            handle={composer}
            surface={phone ? 'phone' : 'desktop'}
            attachments={{
              attachments,
              uploading: attachments.some((a) => a.uploading),
              readyPaths,
              reset,
              handleFiles: () => {},
              dismiss: (id) =>
                setAttachments((prev) => prev.filter((a) => a.id !== id)),
            }}
          />
        }
      />
    </div>
  )
}
