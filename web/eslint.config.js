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
       * found in the 2026-09-08 review, written against a rule that had never run. Both pass.
       */
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      /*
       * The React Compiler rules that ship with plugin v7 are OFF, and this is the reasoning
       * rather than a shrug.
       *
       * They reported 71 places. Every one of them was read on 2026-09-08 - ten
       * `set-state-in-effect` sites in full, all four `purity` sites, and a sample of the
       * canvas's `refs` and `immutability` ones - and none is a defect in this application:
       *
       *   set-state-in-effect (31)  mount gates, one-shot seeds when server data arrives,
       *                             consuming a URL parameter, reacting to a settled run.
       *                             Synchronising React with something outside it, which is
       *                             what an effect is for.
       *   refs (23)                 the `xRef.current = x` latest-value idiom.
       *   immutability (12)         the canvas's position buffer, whose whole design is a
       *                             mutable typed array that outlives the renders.
       *   purity (4)                `Date.now()` for a clock label, in memos that are keyed
       *                             to re-run on a tick anyway.
       *
       * What they describe is what the React Compiler would need in order to optimise these
       * components, and this project does not use it. Satisfying them means restructuring a
       * working canvas renderer and a dozen effects for no behaviour anyone would see. Left
       * as warnings they would be 71 permanent ones, which teaches people to ignore the
       * linter - the state this workspace was already in.
       *
       * If the React Compiler is ever adopted here, these are the first rules to turn back
       * on, and the list above is the map of what it will cost.
       */
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
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
