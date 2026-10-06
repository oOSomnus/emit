// ESLint flat configuration.
//
// Linting uses the stock recommended presets only: `@eslint/js` for plain
// JavaScript (including the `.mjs`/`.cjs` scripts) and `typescript-eslint`
// recommended for TypeScript and TSX. Full type checking stays with the
// project tsconfigs and `npm run typecheck`, so no project service is wired
// in here.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** JavaScript sources, including the Node scripts. */
const javascriptFiles = ['**/*.{js,cjs,mjs}'];

/** TypeScript sources: server, web views and tests. */
const typescriptFiles = ['**/*.{ts,tsx}'];

/** Frontend code that runs in the browser. */
const browserFiles = ['src/web/**/*.{ts,tsx}', 'test/browser/**/*.{ts,tsx}'];

export default tseslint.config(
  {
    name: 'emit/ignores',
    ignores: [
      'coverage/**',
      'dist/**',
      'megalinter-reports/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  {
    name: 'emit/javascript',
    files: javascriptFiles,
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    name: 'emit/typescript',
    files: typescriptFiles,
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    name: 'emit/browser',
    files: browserFiles,
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // Playwright requires a fixture's first callback parameter to be a
    // destructuring pattern, even when the fixture declares no dependencies
    // (`async ({}, use) => {}`), which `no-empty-pattern` rejects by default.
    name: 'emit/playwright',
    files: ['test/browser/**/*.ts'],
    rules: {
      'no-empty-pattern': ['error', { allowObjectPatternsAsParameters: true }],
    },
  },
);
