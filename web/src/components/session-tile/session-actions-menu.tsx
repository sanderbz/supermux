/**
 * The overview's per-session action menu — Info · Mark unread · Rename · Pin ·
 * Stop · Archive · Renderer ▸ · Move to ▸.
 * ─────────────────────────────────────────────────────────────────────────────
 * This used to be `TileMoveToKebab`, a private function inside `group-grid.tsx`,
 * and living there was the whole bug. `GroupGrid` mounts only when
 * `layout.mode === 'custom'`, so in the SHIPPING DEFAULT (Smart sort) there were
 * ZERO `[data-vr="tile-kebab"]` elements in either tiles or list view: Pin,
 * Rename, Info and Mark unread — three of them named deliverables — were
 * unreachable on the app's front door unless you first went Display → Sort →
 * Custom. Right-click gave nothing and there was no other entry point.
 *
 * So the menu moved out to its own module and the overview's flat body renders
 * it too. "Move to ▸" is the ONLY part that needs the group layout, and it is
 * optional here: with no targets the submenu self-hides, exactly as it already
 * did for a tile in the only group.
 *
 * ── The dismiss cycle (the second half of the same defect) ──────────────────
 * Info and Rename open a Radix Popover ANCHORED TO THIS MENU'S TRIGGER. They
 * used a plain `onSelect={() => setInfoOpen(true)}`, which lets the menu run its
 * default select-and-close — and closing a Radix menu returns focus to its
 * trigger, which the just-opened popover reads as a focus-outside and closes
 * itself. Net: the menu vanished and nothing opened, from mouse AND keyboard
 * (which is how we know it was never a synthetic-click artifact).
 *
 * The fix is the canonical Radix "menu item opens an overlay" pattern: record
 * the intent, let the menu close normally, and open the overlay from
 * `onCloseAutoFocus` with `preventDefault()` so focus is never handed back to
 * the trigger in the first place. One ordering rule, no timers.
 *
 * Variants:
 *   * 'tile' — overlay on the top-right of the tile chrome (mirrors the drag
 *     handle's position); hover-revealed on fine pointers, always-shown on
 *     coarse (which is what makes it reachable by finger — a long-press quick
 *     peek carries lifecycle actions but not Pin/Rename/Mark unread).
 *   * 'row'  — inline on the right of the row chrome.
 *
 * Visual-critic hooks: `data-vr-tile-kebab` on the trigger and
 * `data-vr-move-to-submenu` on the submenu trigger so the VR battery can click
 * through deterministically.
 */
import * as React from 'react'
import { createPortal } from 'react-dom'
import {
  Archive,
  Check,
  Info,
  Mail,
  MessageSquare,
  MoveRight,
  PencilLine,
  Pin,
  RotateCcw,
  Square,
} from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SessionInfoPanel } from '@/components/focus-mode/session-info-panel'
import { useNavigateMorph } from '@/components/view-transitions/morph'
import { useAttentionContext } from '@/hooks/use-attention'
import { useSessionActions } from '@/hooks/use-session-actions'
import { useSessionConfig } from '@/hooks/use-session-config'
import { useChatRenderer } from '@/components/chat/use-chat-renderer'
import { useRendererState } from '@/components/chat/use-renderer-pref'
import { prefFor, type RendererPref } from '@/components/chat/renderer-pref'
import { onRowMenuRequest } from './row-menu-bus'
import { sessionTitle, type ApiSession } from '@/lib/api'
import { useUI } from '@/stores/ui-store'

/** The three renderer choices, in the order the switch shows them. `Auto` is
 *  first because it is the fixpoint — it is what a session is until somebody
 *  decides otherwise, and picking it again is how a pin is undone. */
const RENDERER_PREFS: { id: RendererPref; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'Follow the default' },
  { id: 'chat', label: 'Chat', hint: 'Always the conversation' },
  { id: 'terminal', label: 'Terminal', hint: 'Always the pty' },
]

/** One destination for "Move to ▸". Deliberately a plain shape rather than
 *  `group-grid`'s `Section`: this module must not depend on the custom-mode
 *  grid, or the import cycle would put us straight back where we started. */
export interface MoveTarget {
  groupId: string
  groupName: string
  /** A short note after the name ("Smart"), when the destination re-sorts. */
  note?: string
}

export interface SessionActionsMenuProps {
  /** The row this menu acts on. The whole row, not a handful of fields: "Mark
   *  unread" has to rewind the cursor relative to the session's own activity
   *  stamp, so a name is not enough. */
  session: Pick<
    ApiSession,
    | 'name'
    | 'status'
    | 'provider'
    | 'host_id'
    | 'pinned'
    | 'error'
    | 'permission_request'
    | 'chat_tail'
    | 'activity_at'
    | 'last_activity'
    | 'updated_at'
    | 'archived'
    | 'seen_ts'
    | 'seen_count'
    | 'seen_epoch'
    | 'display_name'
    | 'task_summary'
  >
  /** Where the menu sits. */
  variant: 'tile' | 'row'
  /** Custom-mode only: the other groups this tile can be moved to. Omit (or
   *  leave empty) and the "Move to ▸" submenu is not rendered at all. */
  moveTargets?: readonly MoveTarget[]
  onMoveToGroup?: (destGroupId: string) => void
  className?: string
  /** iOS-context-menu feel (grok overview long-press / right-click): while the
   *  menu is open, dim the rest of the screen behind it with a fading backdrop.
   *  Off by default so the classic overview kebab is unchanged (a hover menu
   *  wants no scrim). The scale+fade on the menu itself is the shared
   *  DropdownMenuContent transition; this only adds the backdrop. */
  backdrop?: boolean
}

export function SessionActionsMenu({
  session,
  variant,
  moveTargets,
  onMoveToGroup,
  className,
  backdrop,
}: SessionActionsMenuProps) {
  const sessionName = session.name
  const sessionLabel = sessionTitle(session as ApiSession)

  // Shared lifecycle handlers — one source of truth across desktop kebab and
  // mobile quick-peek (busy guard, team-lead-aware confirm, optimistic cache
  // update, toasts). The menu's gating decides whether to SHOW the item; the
  // hook decides whether to RUN it.
  const { busy, restart, stop, archive } = useSessionActions(sessionName)

  // FASE A5 T5 — the per-session renderer override. The whole submenu is hidden
  // for an INELIGIBLE session and while the experiment is off: a control that
  // decides nothing is worse than no control, and `resolveRenderer` would
  // overrule it anyway.
  const chatExperiment = useUI((st) => st.botMode)
  const rendererEligible = useChatRenderer({
    provider: session.provider,
    host_id: session.host_id,
  })
  const rendererState = useRendererState()
  const rendererPref = prefFor(rendererState, sessionName)
  const setRendererPref = useUI((st) => st.setRendererPref)
  const showRenderer = chatExperiment && rendererEligible

  // Attention (fase B2 T5) — the menu is where "Mark unread" lives.
  const { markUnread, enabled: attentionEnabled } = useAttentionContext()
  // The phantom fields' controls (fase B2 T7). `pinned` has driven `smartSort`
  // and the focus strip's ordering since long before B2 with NO way to set it.
  const { togglePin, pending: configPending } = useSessionConfig()

  // Session info — the SAME panel the focus-page title-click opens, hosted here
  // for overview parity. Desktop = anchored Popover (we pass `infoAnchorRef` as
  // the trigger), mobile = bottom Sheet (the panel forks internally).
  const [infoOpen, setInfoOpen] = React.useState(false)
  // "Rename" opens the SAME panel with the name editor already focused — one
  // rename path (`use-rename-session` + `<NameEditor>`), not a second one.
  const [renameOpen, setRenameOpen] = React.useState(false)
  // What to open once the menu has finished closing. See the file header: the
  // menu's own focus restoration is what used to shut the popover again.
  const [pending, setPending] = React.useState<null | 'info' | 'rename'>(null)
  const infoAnchorRef = React.useRef<HTMLButtonElement>(null)
  // The menu is CONTROLLED so the row can open it from the keyboard (Shift+F10
  // / the Menu key). The trigger is no longer a tab stop of its own — see
  // `row-menu-bus.ts` for why a 40-session roster used to be 41 stops.
  const [open, setOpen] = React.useState(false)
  React.useEffect(
    () => onRowMenuRequest(sessionName, () => setOpen(true)),
    [sessionName],
  )
  const navigateMorph = useNavigateMorph()

  // Action visibility matrix (per user spec — keep redundancies pruned):
  //   Stop:    session is mid-flight (active / waiting / idle / starting).
  //            Skipped on 'stopped' (nothing to stop) and 'error' (the session
  //            is already dead — Archive is the actionable path).
  //   Archive: session is NOT stopped. A stopped tile already exposes a primary
  //            Archive button in its hover-peek body.
  //   Move to: at least one other group exists.
  //   Info:    always.
  const canStop =
    session.status === 'active' ||
    session.status === 'waiting' ||
    session.status === 'idle' ||
    session.status === 'starting'
  const canArchive = session.status !== 'stopped'
  const targets = moveTargets ?? []
  const canMove = targets.length > 0 && Boolean(onMoveToGroup)

  const triggerClassName =
    variant === 'tile'
      ? // Overlay on the top-right of the tile (the drag affordance is
        // decorative-only — the kebab is the only INTERACTIVE button in the
        // corner). Invisible at rest on fine pointers, always visible on coarse.
        // ≥44pt touch target.
        'absolute right-1 top-1 z-20 flex size-9 items-center justify-center rounded-md bg-card/80 text-muted-foreground/60 backdrop-blur-sm transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/tile:opacity-100 touch-none [@media(pointer:coarse)]:size-11 [@media(pointer:coarse)]:opacity-100 [@media(pointer:fine)]:opacity-0'
      : // Inline at the end of the row.
        'flex w-7 items-center justify-center rounded-md text-muted-foreground/40 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring opacity-0 transition-opacity group-hover/tile:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100'

  return (
    <>
      {/* iOS-context-menu backdrop (opt-in via `backdrop`, grok overview only).
          Dims the roster behind the menu while it is open, with a fade that
          reduced-motion users don't get (`motion-reduce:animate-none`). Portaled
          to <body> so the row's own `isolation: isolate` stacking context can't
          trap it beneath sibling rows; it sits below the Radix menu content
          (z-50) which portals to <body> after it. Radix already dismisses the
          menu on an outside pointer-down; the explicit close is belt-and-braces. */}
      {backdrop &&
        open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            aria-hidden
            data-vr="tile-menu-backdrop"
            onPointerDown={() => setOpen(false)}
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px] animate-in fade-in-0 duration-150 motion-reduce:animate-none motion-reduce:duration-0"
          />,
          document.body,
        )}
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            ref={infoAnchorRef}
            type="button"
            aria-label={`More actions for ${sessionLabel}`}
            // OUT of the tab order. The roster is meant to be ONE stop that the
            // arrows walk; a peer trigger per row makes it 1+N, and on a fine
            // pointer those N are invisible until focused. The row opens this
            // menu with Shift+F10 / the Menu key instead (`row-menu-bus.ts`),
            // and pointer users are unaffected.
            tabIndex={-1}
            aria-keyshortcuts="Shift+F10"
            data-vr="tile-kebab"
            data-vr-tile-kebab="true"
            data-vr-session-name={sessionName}
            // Stop pointer events at the trigger so opening the menu doesn't
            // initiate a drag or navigate to focus.
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            // …and keys, so the roster's roving-tabindex arrows don't move the
            // selection out from under an open menu.
            onKeyDown={(e) => e.stopPropagation()}
            className={className ? `${triggerClassName} ${className}` : triggerClassName}
          >
            <span aria-hidden className="text-base leading-none">⋯</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={6}
          // The scale+fade is the shared DropdownMenuContent transition; add the
          // reduced-motion fallback so it appears instantly for those users
          // (the iOS-context-menu mandate) — harmless for the classic kebab too.
          className="motion-reduce:animate-none motion-reduce:duration-0"
          // Stop the dnd-kit sensors / tile click from firing when the user
          // interacts with the menu content.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          // THE fix for "Info and Rename open nothing". Radix restores focus to
          // the trigger when the menu closes; the info popover is anchored to
          // that same trigger, so the restore lands outside the popover and
          // dismisses it in the same frame. Opening from here — with focus
          // restoration suppressed — is the documented pattern, and it works
          // identically for mouse and keyboard activation.
          onCloseAutoFocus={(e) => {
            if (!pending) return
            e.preventDefault()
            if (pending === 'rename') setRenameOpen(true)
            setInfoOpen(true)
            setPending(null)
          }}
        >
          <DropdownMenuItem
            data-vr="tile-info"
            disabled={busy}
            onSelect={() => setPending('info')}
          >
            <Info className="size-4" aria-hidden />
            <span>Info</span>
          </DropdownMenuItem>
          {/* Mark unread (fase B2 T5) — rewinds the seen-cursor so the row
              lights up again. The counterpart of "opening a session marks it
              read", and the only way to UN-read something: without it the tier
              model is a one-way street and a session you glanced at is silenced
              forever. Hidden when the tiers are killed off — an item that does
              nothing is worse than an absent one. */}
          {attentionEnabled && (
            <DropdownMenuItem
              data-vr="tile-mark-unread"
              onSelect={() => markUnread(session)}
            >
              <Mail className="size-4" aria-hidden />
              <span>Mark unread</span>
            </DropdownMenuItem>
          )}
          {/* Rename — reachable everywhere the name shows (§10), reusing the
              info panel's own editor rather than growing a second path. */}
          <DropdownMenuItem
            data-vr="tile-rename"
            disabled={busy}
            onSelect={() => setPending('rename')}
          >
            <PencilLine className="size-4" aria-hidden />
            <span>Rename</span>
          </DropdownMenuItem>
          {/* Pin (fase B2 T7) — `smartSort` orders by it and nothing could set
              it. Optimistic through `useSessionConfig`; the config PATCH emits
              no SSE, so the hook's invalidate is what moves the row. */}
          <DropdownMenuItem
            data-vr="tile-pin"
            disabled={busy || configPending}
            onSelect={() => void togglePin(sessionName, session.pinned)}
          >
            <Pin className="size-4" aria-hidden />
            <span>{session.pinned ? 'Unpin' : 'Pin'}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* Restart (restored overview action) — stop→start, resuming the SAME
              conversation. The mobile quick-peek has always carried this; the
              grok overview long-press / right-click restores it here. Shown for
              every session: a running one is relaunched fresh, a stopped one is
              simply resumed. */}
          <DropdownMenuItem
            data-vr="tile-restart"
            disabled={busy}
            onSelect={() => void restart()}
          >
            <RotateCcw className="size-4" aria-hidden />
            <span>Restart</span>
          </DropdownMenuItem>
          {canStop && (
            <DropdownMenuItem
              data-vr="tile-stop"
              disabled={busy}
              onSelect={() => void stop()}
              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
            >
              <Square className="size-4" aria-hidden />
              <span>Stop</span>
            </DropdownMenuItem>
          )}
          {canArchive && (
            <DropdownMenuItem
              data-vr="tile-archive"
              disabled={busy}
              // RUNNING-session archive also stops the pty — confirm before
              // committing. A stopped tile never reaches this branch
              // (`canArchive` is false there), so this archive is always the
              // "destructive" variant and the confirm is non-negotiable.
              onSelect={() => void archive({ confirm: true })}
            >
              <Archive className="size-4" aria-hidden />
              <span>Archive</span>
            </DropdownMenuItem>
          )}
          {showRenderer && (
            <>
              {/* Restart always precedes this, so the lifecycle group is never
                  empty — always divide it from the renderer submenu. */}
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger data-vr="tile-renderer">
                  <MessageSquare className="size-4" aria-hidden />
                  <span>Renderer</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent>
                    <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                      {sessionLabel} opens as
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {RENDERER_PREFS.map(({ id, label, hint }) => (
                      <DropdownMenuItem
                        key={id}
                        data-vr="tile-renderer-item"
                        data-vr-renderer={id}
                        onSelect={() => setRendererPref(sessionName, id)}
                      >
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span>{label}</span>
                          <span className="text-[11px] leading-tight text-muted-foreground">
                            {hint}
                          </span>
                        </span>
                        {rendererPref === id && (
                          <Check className="size-4 shrink-0" aria-hidden />
                        )}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
            </>
          )}
          {canMove && (
            <>
              {/* Restart always precedes the move submenu too. */}
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger
                  data-vr="tile-move-to"
                  data-vr-move-to-submenu="true"
                >
                  <MoveRight className="size-4" aria-hidden />
                  <span>Move to</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent>
                    <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                      Move {sessionLabel}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {targets.map((target) => (
                      <DropdownMenuItem
                        key={target.groupId}
                        data-vr="tile-move-to-item"
                        data-vr-dest-group-id={target.groupId}
                        onSelect={() => onMoveToGroup?.(target.groupId)}
                      >
                        {target.groupName}
                        {target.note && (
                          <span className="ml-2 text-[10px] font-normal text-muted-foreground">
                            {target.note}
                          </span>
                        )}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Session info — same component as the focus-page title-click. Desktop
          forks to an anchored Popover (positions against the kebab trigger),
          mobile forks to the bottom Sheet. Cloning navigates to the new focus
          route via the morph helper so the View Transitions handoff is
          consistent with tile-click navigation. */}
      <SessionInfoPanel
        name={sessionName}
        open={infoOpen}
        onOpenChange={(open) => {
          setInfoOpen(open)
          if (!open) setRenameOpen(false)
        }}
        triggerRef={infoAnchorRef}
        autoEditName={renameOpen}
        onNavigate={(name) => {
          setInfoOpen(false)
          navigateMorph(`/focus/${name}`)
        }}
      />
    </>
  )
}
