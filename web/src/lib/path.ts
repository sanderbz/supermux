// Small path helpers shared across the chat surface.

/** `/a/b/shot.png` → `shot.png`; `shot.png?v=2#frag` → `shot.png`.
 *
 *  The robust version: a `?query`/`#hash` is stripped before the last slash is
 *  taken (an image URL can carry either), and a path with no slash returns
 *  whole. Consolidated from three drifted copies (frames.ts, slash.ts,
 *  chat-components.tsx) so a filename is basenamed the same way everywhere. */
export function basename(path: string): string {
  const clean = path.split(/[?#]/, 1)[0]
  const slash = clean.lastIndexOf('/')
  return slash >= 0 ? clean.slice(slash + 1) : clean
}
