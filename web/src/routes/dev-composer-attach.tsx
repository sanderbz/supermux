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

  const phone =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('surface') === 'phone'

  return (
    <div className="flex min-h-dvh items-end justify-center bg-paper p-8 text-ink">
      <div className="w-full max-w-[840px]">
        <ChatComposer
          name={NAME}
          label="Release Train"
          handle={handle}
          surface={phone ? 'phone' : 'desktop'}
          attachments={staged}
          // On the phone the Attach group lives in the `+` add-menu, which only
          // renders when `actions` is present — so wire inert ones here.
          actions={
            phone ? { onSwitchSession: noop, onCommandPalette: noop } : undefined
          }
        />
      </div>
    </div>
  )
}
