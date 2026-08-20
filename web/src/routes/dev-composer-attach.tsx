// /dev/composer-attach — the wired-composer bench for the attachment upgrade.
//
// DEV-only + lazy (tree-shaken from prod — verified absent from dist, like the
// other /dev/* benches). Unlike /dev/chat-live's frozen `BenchComposer` (a
// static handle), this mounts the REAL data plane: `useComposer` + the REST
// input + `useStagedAttachments`, wired exactly as `chat-panel.tsx` wires them.
// So an offline Playwright rig can drive the whole flow — pick a file (upload
// intercepted), watch the chip go ready, hit Send — and assert the POST body of
// `/api/sessions/{name}/send` carries the quoted upload path. The rig owns the
// network: it fulfils `/api/upload` with a fake absolute path and captures the
// `/send` body; no server is involved.
//
// `?surface=phone` renders the phone bar with the `+` add-menu (its Attach group
// is what the mobile screenshot captures); default is the desktop pair with the
// direct attach disc.
import * as React from 'react'

import { ChatComposer } from '@/components/chat/composer'
import { useComposer } from '@/components/chat/use-composer'
import { attachmentSentence } from '@/components/chat/composer-insert'
import { useStagedAttachments } from '@/components/focus-mode/use-staged-attachments'
import { restSessionInput } from '@/lib/session-input'

const NAME = 'release-train'
const noop = () => undefined

export default function DevComposerAttach() {
  const input = React.useMemo(() => restSessionInput(NAME), [])
  const staged = useStagedAttachments()
  const handle = useComposer({
    name: NAME,
    input,
    active: false,
    // The exact seam chat-panel uses: fold the quoted paths at submit time,
    // clear the chips on a resolved POST. No `peek` ⇒ the pre-send gate is
    // skipped (the fail-open path), so the bench never needs a peek server.
    getOutgoingPrefix: React.useCallback(
      () => attachmentSentence(staged.readyPaths()),
      [staged],
    ),
    onSent: staged.reset,
  })

  const q =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams()
  const phone = q.get('surface') === 'phone'
  // `?grok=1` stamps `data-grok` so the grok-scoped composer CSS (leading-cluster
  // gap, disc sizing) actually applies — this is how the rig reviews the grok
  // CHAT pane's real full-width 📎·@·🕐 trio at 390px (that pane ships
  // `surface="desktop"` on the phone). `?schedule=1` wires an inert `onSchedule`
  // so the 🕐 (the third leading icon) is drawn. Both DEV-only, prod-inert.
  const grok = q.get('grok') === '1'
  const schedulable = q.get('schedule') === '1'

  return (
    <div
      {...(grok ? { 'data-grok': '' } : {})}
      className="flex min-h-dvh items-end justify-center bg-paper p-8 text-ink"
    >
      <div className="w-full max-w-[840px]">
        <ChatComposer
          name={NAME}
          label="Release Train"
          handle={handle}
          surface={phone ? 'phone' : 'desktop'}
          attachments={staged}
          onSchedule={schedulable ? noop : undefined}
          // The leading `+` add-menu renders whenever `actions` is present — now
          // on BOTH surfaces (the shipped wiring: mobile.tsx + desktop-split.tsx).
          // Faithful to production: the phone sheet carries Switch-session, the
          // desktop popover omits it (its persistent session list makes it
          // redundant). Inert callbacks — this is a screenshot bench.
          actions={
            phone
              ? { onSwitchSession: noop, onCommandPalette: noop, onSnippets: noop }
              : { onCommandPalette: noop, onSnippets: noop }
          }
        />
      </div>
    </div>
  )
}
