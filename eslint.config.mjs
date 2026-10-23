// ESLint flat config: recommended JS + TypeScript rules for src/ and tests/.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // `_`-prefixed names mark intentionally unused values (e.g. destructured-away keys)
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      // `declare global { namespace Express { ... } }` is how Express types are augmented
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
    },
  },
  {
    files: ['*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['tests/**/*.ts'],
    languageOptions: { globals: { ...globals.jest } },
  },
);
