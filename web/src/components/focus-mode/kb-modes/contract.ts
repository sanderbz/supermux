// KbLayout — the shared contract every keyboard-layout implements.
//
// Background. On the owner's real iPhone (standalone PWA) the mobile CHAT
// composer floats a ~68px black band above the soft keyboard. The simulator
// cannot reproduce it and `visualViewport` on that device is unreliable (the
// overlap is absorbed into `visualViewport.offsetTop`, not `.height`). The
// shipped layout drives that band to zero on the owner's hardware.
//
// The layout is exactly one `KbLayoutComponent`. It lays out the three semantic
// regions of the mobile chat view (header / body / composer) and owns keyboard
// avoidance. When it flips a global (its `documentElement.height` root resize)
// it does so in a mount `useEffect` and reverts in the cleanup — component
// lifecycle is the activation signal; there is no explicit
// onActivate/onDeactivate.
//
// TYPE-ONLY module. The layout file and `chat-surface.tsx` import from here
// type-only, so it stays free of runtime imports (chat-surface.tsx is
// rendered by `bun test`, whose root tsconfig carries no `@/` paths).

import type * as React from 'react'

export interface KbLayoutProps {
  /** Sticky/floating top chrome (the chat header card). May be null — some
   *  modes float it over the body, some pin it as a real row. The mode decides. */
  header?: React.ReactNode
  /** The scrollable transcript region (the `[data-chat-track]` scroller plus its
   *  float layer). The mode gives it the remaining space and MUST let it own its
   *  own `overflow-y:auto; overscroll-contain; min-h-0` — never scroll the page. */
  body: React.ReactNode
  /** The composer footer node (already built by ChatSurface — the
   *  `[data-testid=chat-composer]` frame + field). The mode is responsible for
   *  keeping THIS element flush above the soft keyboard with zero band. */
  composer: React.ReactNode
  /** True while the chat composer is the active input plane. Modes whose trick
   *  only makes sense under chat gate their effects on it. Under the terminal
   *  path no KbLayout is mounted, so in practice this is always true today —
   *  it is part of the contract so a mode never has to assume. */
  chatActive: boolean
}

/** Every mode file default-exports one of these. */
export type KbLayoutComponent = React.FC<KbLayoutProps>
