import js from '@eslint/js'
import globals from 'globals'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
      // fase A6 T7.7 — the a11y net. There was none: no `eslint-plugin-jsx-a11y`,
      // no axe, zero matches for "axe" repo-wide, which is how a surface as
      // large as the chat renderer shipped with no `aria-*` on its live layer at
      // all. Dev-only by construction (an eslint plugin is never bundled) —
      // verified in `tests/unit/a11y-tooling.test.ts`, not assumed.
      jsxA11y.flatConfigs.recommended,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // Intentional unused params/vars use a leading underscore (e.g. typed API
      // stub signatures in lib/api.ts and hook stubs).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // shadcn copy-source primitives export their cva variant maps alongside
      // the component (allowed as constant exports); the theme hook ships with
      // its provider (HMR-only concern, downgraded to a warning).
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // ── fase A6 T7.7: the a11y rules this codebase's real patterns need ──
      //
      // A DELIBERATE, NAMED TAB STOP IS NOT A BUG. Two shapes in here are tab
      // stops on purpose and both carry an `aria-label`: the choice card's
      // evidence box (`chat/ui/choice-card.tsx` — a `<pre>` that scrolls in both
      // axes, so a keyboard user must be able to reach and pan it) and the
      // roster's group header (`session-tile/group-header.tsx` — dnd-kit's
      // keyboard drag handle). The rule ships an allowlist for exactly this;
      // `tabpanel` is its default and these are the same class of thing.
      'jsx-a11y/no-noninteractive-tabindex': [
        'error',
        { tags: [], roles: ['tabpanel', 'region', 'group'], allowExpressionValues: true },
      ],
      // The file viewer previews WHATEVER is on disk. There is no caption track
      // for an arbitrary user file and inventing an empty one would be worse
      // than none, so this rule cannot be satisfied here — it is off rather
      // than warned, because a warning nobody can ever clear is noise.
      'jsx-a11y/media-has-caption': 'off',
      // Autofocus IS the interaction for a command palette and for the
      // acceptance-checklist row it opens: the surface exists because the user
      // just asked for a text field. Carried as a warning so a THIRD site has
      // to argue for itself.
      'jsx-a11y/no-autofocus': 'warn',
    },
  },
  {
    // CARRIED, BY NAME (T7.7). Each of these is a pre-existing pattern outside
    // the chat surfaces this fase owns; they are warnings rather than errors so
    // the "zero NEW errors" bar stays true while the findings stay visible.
    //   · markdown-viewer — `heading-has-content` false-positives on
    //     react-markdown component overrides (`h1: (props) => <h1 {...props}/>`:
    //     the content arrives through the spread, which the rule cannot see).
    //   · last-send-recall / stopped-session — a static click target that
    //     deliberately DUPLICATES an adjacent real button; adding a key handler
    //     would give the same action two keyboard paths.
    //   · new-session-sheet — a `<label>` over a custom control group.
    //   · group-header — dnd-kit's keyboard drag handle, see above.
    files: [
      'src/components/files/markdown-viewer.tsx',
      'src/components/focus-mode/last-send-recall.tsx',
      'src/components/terminal/stopped-session.tsx',
      'src/components/session-tile/new-session-sheet.tsx',
      'src/components/session-tile/group-header.tsx',
    ],
    rules: {
      'jsx-a11y/heading-has-content': 'warn',
      'jsx-a11y/click-events-have-key-events': 'warn',
      'jsx-a11y/no-static-element-interactions': 'warn',
      'jsx-a11y/no-noninteractive-element-interactions': 'warn',
      'jsx-a11y/label-has-associated-control': 'warn',
    },
  },
])
