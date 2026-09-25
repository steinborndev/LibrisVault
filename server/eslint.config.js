// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  /*
   * Type-aware (2026-09-08): `projectService` was already configured here, but the rule set
   * was the untyped `recommended`, so the three rules the type information exists for never
   * ran. They report nothing today - which is the point of turning them on: the property is
   * there, and now it is held.
   */
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // This config file is not part of tsconfig's `include`, so type-aware
        // linting needs it declared as a default project or eslint errors on itself.
        projectService: { allowDefaultProject: ['eslint.config.js', 'vitest.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Credentials must never reach logs (CLAUDE.md hard rule 3); allow console
      // only through the logging helpers, not ad-hoc across the pipeline.
      'no-console': ['warn', { allow: ['error'] }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      /*
       * Off for the same reason as in the web config: the `no-unsafe-*` family fires on every
       * `as` over a database row or an SDK message, all of which are parsed at their edge.
       * A rule nobody can satisfy is a rule that gets switched off wholesale later, taking
       * the useful ones with it.
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
      /*
       * Off after trying it: it reports 62 assertions that are cosmetically redundant, and
       * its autofix removed several that generic callbacks were inferring from - `tsc` then
       * failed with implicit `any` in six test files. A rule whose fix breaks the build is
       * not worth the noise it also brings.
       */
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
  {
    // The CLI is a console program by definition.
    files: ['src/cli/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
)
