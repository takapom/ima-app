import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const ignored = [
  '.claude/**',
  '.codex/skills/**',
  '**/node_modules/**',
  '**/.expo/**',
  '**/.wrangler/**',
  '**/.cloudflare/**',
  '**/dist/**',
  '**/coverage/**',
  '**/worker-configuration.d.ts',
  'scripts/fixtures/**',
];

const nodeGlobals = {
  AbortController: 'readonly',
  Buffer: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  globalThis: 'readonly',
  process: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  structuredClone: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
};

export default tseslint.config(
  {
    ignores: ignored,
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: nodeGlobals,
      sourceType: 'module',
    },
    rules: {
      'constructor-super': 'error',
      eqeqeq: ['error', 'always'],
      'no-constant-condition': 'error',
      'no-debugger': 'error',
      'no-dupe-keys': 'error',
      'no-fallthrough': 'error',
      'no-implicit-coercion': 'error',
      'no-new-native-nonconstructor': 'error',
      'no-throw-literal': 'error',
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-unused-vars': ['error', { args: 'none' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'prefer-rest-params': 'error',
      'prefer-spread': 'error',
      'max-lines': ['error', { max: 500, skipBlankLines: false, skipComments: false }],
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...nodeGlobals,
        __dirname: 'readonly',
        __filename: 'readonly',
        exports: 'readonly',
        module: 'readonly',
        require: 'readonly',
      },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      eqeqeq: ['error', 'always'],
      'no-debugger': 'error',
      'no-fallthrough': 'error',
      'no-implicit-coercion': 'error',
      'no-unused-vars': 'off',
      'max-lines': ['error', { max: 500, skipBlankLines: false, skipComments: false }],
    },
  },
  {
    files: ['worker/tests/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './worker/tsconfig.tests.json',
      },
    },
  },
  {
    files: [
      'apps/mobile/App.tsx',
      'apps/mobile/src/{journey,saved-places,preferences,settings,entry}/{components,hooks,state}/**/*.{ts,tsx}',
      'apps/mobile/src/entry/EntryFlow.tsx',
      'apps/mobile/src/ui/Canvas.tsx',
      'apps/mobile/src/composition/hooks/**/*.{ts,tsx}',
    ],
    rules: {
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/rules-of-hooks': 'error',
    },
  },
  {
    files: [
      'apps/mobile/App.tsx',
      'apps/mobile/src/{journey,saved-places,preferences,settings,entry}/{components,hooks,state}/**/*.{ts,tsx}',
      'apps/mobile/src/entry/EntryFlow.tsx',
      'apps/mobile/src/ui/Canvas.tsx',
      'apps/mobile/src/composition/hooks/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'document', message: 'UI code must use a service for browser I/O.' },
        { name: 'fetch', message: 'UI code must use a service for network I/O.' },
        { name: 'localStorage', message: 'UI code must use a service for storage I/O.' },
        { name: 'navigator', message: 'UI code must use a service for device I/O.' },
        { name: 'window', message: 'UI code must use a service for platform I/O.' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'expo-file-system',
                'expo-linking',
                'expo-location',
                'expo-sharing',
                'expo-sqlite',
                '@react-native-async-storage/*',
              ],
              message: 'UI code must call a mobile service for direct I/O.',
            },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Linking', property: 'openURL', message: 'Use a mobile service for links.' },
        { object: 'Share', property: 'share', message: 'Use a mobile service for sharing.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.type='MemberExpression'][callee.object.name='SQLite']",
          message: 'Use a mobile service for SQLite I/O.',
        },
        {
          selector: "MemberExpression[object.name='globalThis'][property.name='fetch']",
          message: 'UI code must use a service for network I/O.',
        },
      ],
    },
  },
  {
    files: ['worker/src/domain/**/*.{ts,tsx}', 'worker/src/application/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { projectService: false, project: './worker/tsconfig.business.json' },
    },
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'crypto', message: 'Business code must receive an ID/randomness port.' },
        { name: 'fetch', message: 'Business code must use an injected port for I/O.' },
        { name: 'process', message: 'Business code must receive environment values as input.' },
        { name: 'console', message: 'Business code must use an injected observation port.' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                'cloudflare',
                'cloudflare:*',
                '@cloudflare/*',
                'expo',
                'react-native',
                'ai',
                '@ai-sdk/*',
                'workers-ai-provider',
                'wrangler',
              ],
              message: 'Business code cannot import runtime, provider, or direct I/O SDKs.',
            },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'Business code must receive a Clock port.' },
        {
          object: 'Math',
          property: 'random',
          message: 'Business code must receive randomness as a port.',
        },
        {
          object: 'crypto',
          property: 'randomUUID',
          message: 'Business code must receive an ID port.',
        },
        {
          object: 'globalThis',
          property: 'crypto',
          message: 'Business code must receive an ID port.',
        },
        {
          object: 'process',
          property: 'env',
          message: 'Business code must receive environment values.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'Business code must receive a Clock port instead of reading the current time.',
        },
        {
          selector: "CallExpression[callee.name='Date'][arguments.length=0]",
          message: 'Business code must receive a Clock port instead of reading the current time.',
        },
        {
          selector: "MemberExpression[object.name='globalThis'][property.name='fetch']",
          message: 'Business code must use an injected port for network I/O.',
        },
        {
          selector: "CallExpression[callee.name='setTimeout']",
          message: 'Business code must receive scheduling as a port.',
        },
        {
          selector: "CallExpression[callee.name='setInterval']",
          message: 'Business code must receive scheduling as a port.',
        },
      ],
    },
  },
  {
    files: ['worker/src/adapters/in/tools/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'ai',
              importNames: ['generateText', 'streamText', 'generateObject', 'streamObject'],
              message: 'Tool bindings must not run models.',
            },
          ],
          patterns: [
            {
              group: ['@ai-sdk/*', '@cloudflare/ai', '@googlemaps/*', 'workers-ai-provider'],
              message: 'Tool bindings call a Worker provider adapter, not a provider SDK.',
            },
          ],
        },
      ],
    },
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  prettier,
);
