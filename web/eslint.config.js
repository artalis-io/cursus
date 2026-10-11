import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/* Flat ESLint config for the dispatch SPA. The point is to actually enforce the
 * React hooks rules the code already writes `eslint-disable` lines for
 * (rules-of-hooks + exhaustive-deps), plus basic TS hygiene. Type-checked rules
 * are intentionally not enabled here to keep `npm run lint` fast; `tsc -b` in
 * the build is the type gate. */
export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'tests', '**/*.config.{js,ts}', 'tsconfig*.json'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Node dev scripts (screenshots etc.) run outside the browser.
  { files: ['scripts/**/*.{js,mjs,ts}'], languageOptions: { globals: { ...globals.node } } },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
