import { defineConfig, globalIgnores } from 'eslint/config'
import tseslint from 'typescript-eslint'

export default defineConfig([
  globalIgnores([
    '**/dist/',
    '**/coverage/',
    '**/test-results/',
    '**/playwright-report/',
    '**/node_modules/',
    '.pnpm-store/',
    '.scratch/',
    '.workbuddy/',
    'server/data/',
    'amap-config.js',
    'amap-config.local.js',
  ]),
  {
    files: ['**/*.{js,cjs,mjs,jsx,ts,tsx,mts,cts}'],
    rules: {
      'no-debugger': 'error',
      'no-unreachable': 'error',
    },
  },
  {
    files: ['**/*.jsx'],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parser: tseslint.parser,
    },
  },
  {
    files: [
      'src/**/*.{ts,tsx,mts,cts}',
      'tests/**/*.{ts,tsx,mts,cts}',
      'server/{src,tests}/**/*.{ts,tsx,mts,cts}',
      'packages/domain/src/**/*.{ts,tsx,mts,cts}',
      'vite.config.ts',
    ],
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: {
      parserOptions: {
        project: [
          './tsconfig.eslint.json',
          './server/tsconfig.json',
          './packages/domain/tsconfig.build.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
])
