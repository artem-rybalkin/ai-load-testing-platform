import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**']
  },
  {
    files: ['services/*/src/**/*.ts', 'packages/*/src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        // Auto-discovers each linted file's nearest tsconfig.json (there are
        // 13 across this monorepo) instead of pointing at one fixed project —
        // required for the type-aware rules below (no-floating-promises,
        // await-thenable, no-misused-promises) to actually see type info.
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        crypto: 'readonly'
      }
    },
    plugins: {
      '@typescript-eslint': tseslint,
      import: importPlugin
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // The typescript-eslint meta-package (which exports flat-config-ready
      // camelCase configs) isn't installed here — only @typescript-eslint/eslint-plugin
      // + @typescript-eslint/parser are — so pull the type-aware rule set from
      // the plugin's own legacy-style kebab-case config export instead;
      // structurally it's still just a plain rules object.
      ...tseslint.configs['recommended-type-checked'].rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
      // Circular workspace deps are a build-time mystery; extraneous deps mean
      // a service is importing from a sibling's node_modules instead of its own
      // package.json / the shared package — both silent until they break a build.
      'import/no-cycle': 'error',
      // No packageDir override — the rule walks up from each linted file to find
      // its own nearest package.json, which is exactly right for this monorepo
      // (each service/package has independent dependencies).
      'import/no-extraneous-dependencies': 'error'
    }
  },
  {
    // Test tooling (vitest, testcontainers, etc.) is a devDependency declared
    // once at the repo root and used via npm workspace hoisting, not repeated
    // in every service's own package.json — so the default per-file packageDir
    // lookup used above would flag it as "extraneous" in every test file. The
    // production-code leak this rule exists to catch doesn't apply to tests.
    //
    // The type-aware rules below are also turned off here: enabling
    // recommended-type-checked repo-wide surfaced ~1400 findings, and 1217 of
    // them (85%) were in these test files — near-universally from mocking
    // patterns that are inherently loosely-typed by nature (vi.fn() spies cast
    // to EventEmitter subtypes, `.mock.calls[0][0] as any`, async callbacks
    // registered where a sync void-returning one is expected, etc.), not real
    // bugs. Verified: 0 of the 20 no-floating-promises/no-misused-promises hits
    // were in production code either — every one was a test-mock async-callback
    // pattern. The genuine value (216 findings, mostly untyped `pool.query()`
    // rows) is entirely in production src files, where these rules stay on.
    files: ['services/*/src/__tests__/**/*.ts', 'packages/*/src/__tests__/**/*.ts'],
    rules: {
      'import/no-extraneous-dependencies': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-floating-promises': 'off'
    }
  }
];