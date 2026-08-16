// The things a picker can offer, and where each of them goes (fase B3 T2.1).
// ─────────────────────────────────────────────────────────────────────────────
// PURE, IMPORT-FREE, ROUTER-FREE. It takes plain data and returns plain data —
// the shape `components/session-schedules/schedule-href.ts` already proved for
// one entity kind, generalised to nine rather than competed with. Three reasons
// it has to stay that way:
//
//   1. The `bun test` runner resolves no `@/` aliases and mounts no DOM, and
//      "where does an issue go" is exactly the kind of decision that should be
//      assertable without either.
//   2. The picker is a LAZY chunk that fetches nothing. A module that imported
//      react-router would drag the router into it, and a module that imported
//      the API client measurably hoists that client into a third chunk (+0.5 KB
//      gz for zero behaviour — the A4 measurement this file inherits).
//   3. Two consumers navigate to the same entity from different surfaces (the
//      palette and the chat picker, with B4's chips already a third). If the
//      route lives at the call sites, a surface that moves gets fixed in the
//      places somebody remembered.
//
// WHY A ROW IS A UNION RATHER THAN A BAG OF OPTIONAL FIELDS. Every row has to
// DO something when it is picked, and there are exactly three somethings: it
// inserts text (the `@`/`/` token anchor), it runs a function (an in-app verb),
// or it navigates to an entity (a session, an issue, a file). A row with none
// of the three renders fine, highlights fine, and does nothing when the user
// presses Enter — a dead row that looks identical to a live one. Making the
// three arms a discriminated union means `tsc` refuses it instead.

// TYPE-ONLY. Erased at build, so this module still has no runtime import — the
// point of the header comment above, and the reason a lucide icon can be named
// here without lucide being on this file's import path.
import type { ComponentType, ReactNode } from 'react'

/** An icon component, structurally — any lucide glyph satisfies it, and so does
 *  a plain SVG component, without this module knowing about either. */
export type EntityIcon = ComponentType<{ className?: string }>

/**
 * What a row IS.
 *
 * `session · file · issue · schedule · snippet · skill · host · command ·
 * action` — the §14 union. Not every kind is produced by every surface: chat's
 * `@` offers files and sessions, its `/` offers commands, the palette adds the
 * rest. The kind is what decides the icon and the destination, never the
 * renderer.
 */
export type EntityKind =
  | 'session'
  | 'file'
  | 'issue'
  | 'schedule'
  | 'snippet'
  | 'skill'
  | 'host'
  | 'command'
  | 'action'

interface EntityRowBase {
  id: string
  kind: EntityKind
  label: string
  /** Secondary text: a directory, a description, a slug. */
  meta?: string
  /** A calm badge. The row stays pickable — a refusal belongs to the SEND, not
   *  to the typing. */
  warn?: string
  icon?: EntityIcon
  /**
   * A fully-drawn leading element, for rows whose identity is not an icon.
   *
   * The one real case is a SESSION: fase B2 gave the palette's session rows the
   * session's own `SessionFace` — a 24px procedural mark, deliberately static
   * under the keyboard cursor — and a 14px lucide glyph would throw that away.
   * Takes precedence over `icon`; a row should not set both.
   */
  leading?: ReactNode
}

/** A row that INSERTS. `value` is the text that lands in the draft. */
export interface EntityRowInsert extends EntityRowBase {
  value: string
  run?: never
  slug?: never
}

/** A row that RUNS. An in-app verb — open a sheet, toggle a pref. */
export interface EntityRowRun extends EntityRowBase {
  run: () => void
  value?: never
  slug?: never
}

/** A row that NAVIGATES. `slug` is the entity's own identity — a session name,
 *  an issue id, a path — and `resolveEntityTarget` turns it into a route. */
export interface EntityRowNav extends EntityRowBase {
  slug: string
  value?: never
  run?: never
}

/** One offer. Exactly one of `value` / `run` / `slug`, by construction. */
export type EntityRow = EntityRowInsert | EntityRowRun | EntityRowNav

/** What picking a row does. `null` means "this row inserts" — the token anchor
 *  owns that case and the caller already has `row.value`. */
export type EntityTarget = { to: string } | { run: () => void } | null

/**
 * THE ONE INDIRECTION. Every consumer that navigates goes through here.
 *
 * The destinations are deliberately written down in one place because three of
 * them are NOT stable and two are actively surprising:
 *
 *   • An ISSUE has no route. B2 removed the Board page and put issues where
 *     the work is — inside the session detail panel and the team card
 *     (`components/issues/issue-surface.tsx`, mounted at
 *     `focus-mode/session-info-panel.tsx:276` and `team/team-card.tsx:152`).
 *     So "go to this issue" means "go to the session that owns it", and the
 *     issue's own id is not addressable yet. When B2's successor gives it a
 *     surface, this function changes and the palette, the picker and the chip
 *     renderer all follow.
 *   • SCHEDULES and HOSTS have no routes either — B1 folded both into Settings
 *     and left redirects behind (`App.tsx:144`, `:151`). The hash is the
 *     address.
 *   • COMMANDS, SKILLS and SNIPPETS never navigate. They are verbs, and a verb
 *     row carries its own `run`.
 */
export function resolveEntityTarget(row: EntityRow): EntityTarget {
  if (row.run) return { run: row.run }
  if (!row.slug) return null
  const slug = row.slug
  switch (row.kind) {
    case 'session':
      return { to: `/focus/${encodeURIComponent(slug)}` }
    case 'file':
      return { to: `/files?path=${encodeURIComponent(slug)}` }
    // An issue's address is the session that owns it (see above). `slug` is
    // therefore that session's name, not the issue id — the one place in this
    // file where the slug is not the entity's own identity, and the reason it
    // is spelled out rather than left to a reader to infer from a template.
    case 'issue':
      return { to: `/focus/${encodeURIComponent(slug)}` }
    case 'schedule':
      return { to: '/settings#schedules' }
    case 'host':
      return { to: '/settings#hosts' }
    default:
      return null
  }
}
