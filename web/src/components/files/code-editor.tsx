import * as React from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'
import type { Extension } from '@codemirror/state'

import { useTheme } from '@/components/theme-provider'
import { languageLoaderFor, shouldWrap } from './file-types'

// Transparent chrome so the editor inherits the app's card surface rather than
// CodeMirror's own background — keeps the file pane materially consistent.
const baseTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', height: '100%', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.6',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--color-muted-foreground)',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-content': { caretColor: 'var(--color-primary)' },
})

export interface CodeEditorProps {
  /** Filename — drives the language grammar + wrap behaviour. */
  name: string
  value: string
  editable: boolean
  onChange?: (value: string) => void
}

/** CodeMirror 6 editor. Loads the language grammar lazily and
 *  themes to match the active light/dark mode. */
export function CodeEditor({ name, value, editable, onChange }: CodeEditorProps) {
  const { resolvedTheme } = useTheme()
  const [lang, setLang] = React.useState<Extension | null>(null)

  React.useEffect(() => {
    // `name` is constant for a given editor instance (FileViewer is keyed by
    // path), so the initial `null` is already correct for no-grammar files —
    // we only ever set state asynchronously once the grammar resolves.
    let alive = true
    const loader = languageLoaderFor(name)
    if (!loader) return
    loader()
      .then((ext) => {
        if (alive) setLang(ext)
      })
      .catch(() => {
        /* unknown grammar — fall back to plain text (lang stays null) */
      })
    return () => {
      alive = false
    }
  }, [name])

  const extensions = React.useMemo(() => {
    const exts: Extension[] = [baseTheme]
    if (shouldWrap(name)) exts.push(EditorView.lineWrapping)
    if (lang) exts.push(lang)
    return exts
  }, [name, lang])

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      editable={editable}
      readOnly={!editable}
      theme={resolvedTheme === 'dark' ? oneDark : 'light'}
      extensions={extensions}
      height="100%"
      className="h-full text-[13px]"
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: editable,
        highlightActiveLineGutter: editable,
        foldGutter: false,
        autocompletion: false,
      }}
    />
  )
}
