import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Formatting is Prettier's job; these rules only look for mistakes.
export default tseslint.config(
  // mods/ runs inside Claude Code and imports its runtime types, which are not installed here.
  { ignores: ['node_modules', 'logs', 'mods'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      eqeqeq: 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
