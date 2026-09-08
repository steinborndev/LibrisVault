// @ts-check
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  // `public/sw.js` is a hand-written service worker in plain JS and `eslint.config.js` is
  // this file: neither belongs to the type project the rules below need.
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'public/**', 'eslint.config.js'] },
  js.configs.recommended,
  // Type-aware, like the server's: the rules worth having here are the ones that need
  // types (a forgotten await, a promise handed to something expecting void).
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        /*
         * A lint-only project, because the build's `tsconfig.json` stops at `src`: the
         * linter needs a project for every file it reads, and the tests are worth type-aware
         * rules too. Keeping them out of the build's project is deliberate for now - they
         * carry 22 fixture drifts under `exactOptionalPropertyTypes` that are their own
         * change.
         */
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      /*
       * The two classic rules are errors: `rules-of-hooks` is correctness, and
       * `exhaustive-deps` is the reason this config exists - ten suppressions for it were
       * found in the 2026-09-08 review, written against a rule that had never run.
       *
       * The React Compiler rules that ship with plugin v7 (set-state-in-effect, refs,
       * immutability, purity, preserve-manual-memoization) are WARNINGS. This codebase does
       * not use the compiler, and they report 71 places - a lint that is red on arrival is a
       * lint nobody runs, which is how the workspace ended up with none. As warnings they
       * are visible and can be worked down file by file.
       */
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      /*
       * The rules the type information is here for. Enabled after the 2026-09-08 review found
       * ten `react-hooks/exhaustive-deps` suppressions for a rule that had never run, in a
       * workspace with no lint at all.
       */
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      /*
       * Off on purpose. The `no-unsafe-*` family fires on every `as` over an API payload and
       * on every untyped third-party value; this codebase parses its payloads at the edge
       * (api/types.ts) and the rules would report hundreds of lines that are already checked
       * there. `restrict-template-expressions` objects to `${count}` in a string. None of
       * them describes a defect here, and a rule nobody can satisfy is a rule that gets
       * switched off wholesale later, taking the useful ones with it.
       */
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
  {
    // Tests read fixtures off disk and run under node, not a browser.
    files: ['test/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
)
