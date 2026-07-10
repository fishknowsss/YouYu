import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/release/**',
      '**/release-archive/**',
      'resources/generated/**',
      'src/renderer/assets/pet/**',
      'cloudflare/youyu-traffic/.wrangler/**',
      'index.js'
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'prefer-const': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ]
    }
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks
    },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      'react-hooks/set-state-in-effect': 'off'
    }
  },
  {
    files: ['cloudflare/youyu-traffic/src/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.serviceworker
      }
    }
  },
  prettier
);
