import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const vitestGlobals = {
  afterAll: 'readonly',
  afterEach: 'readonly',
  beforeAll: 'readonly',
  beforeEach: 'readonly',
  describe: 'readonly',
  expect: 'readonly',
  it: 'readonly',
  test: 'readonly',
  vi: 'readonly',
};

export default tseslint.config(
  {
    ignores: [
      '.claude/',
      '**/dist/',
      '**/node_modules/',
      '**/*.d.ts',
      '**/*.astro',
      'coverage/',
      'eslint.config.js',
      'apps/web/src/static-demo/',
      'apps/web/test-results/',
      'apps/www/public/',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'apps/control-plane/vitest.load.config.ts',
            'apps/web/e2e/*.ts',
            'apps/web/playwright.config.ts',
            'apps/web/vitest.config.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-base-to-string': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // 2026-06-12 baseline: 2,769 existing unsafe assignments, low signal for initial lint gate.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // 2026-06-12 baseline: 498 existing unsafe arguments, low signal for initial lint gate.
      '@typescript-eslint/no-unsafe-argument': 'off',
      // 2026-06-12 baseline: 8,722 existing unsafe calls, low signal for initial lint gate.
      '@typescript-eslint/no-unsafe-call': 'off',
      // 2026-06-12 baseline: 6,793 existing unsafe member accesses, low signal for initial lint gate.
      '@typescript-eslint/no-unsafe-member-access': 'off',
      // 2026-06-12 baseline: 785 existing unsafe returns, low signal for initial lint gate.
      '@typescript-eslint/no-unsafe-return': 'off',
      // 2026-06-12 baseline: 116 existing redundant constituents, low signal for initial lint gate.
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'error',
      // Stylistic; Prettier owns formatting and this baseline avoids style-only churn.
      'prefer-const': 'off',
    },
  },
  {
    files: ['**/*.{test,spec}.{ts,tsx}', '**/test/**/*.{ts,tsx}', 'apps/web/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...vitestGlobals,
      },
    },
  },
  {
    files: ['apps/web/*.config.ts', 'apps/web/e2e/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ['apps/control-plane/**/*.{ts,tsx}', 'packages/sandbox-bridge/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...vitestGlobals,
      },
    },
  },
);
