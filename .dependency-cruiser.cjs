module.exports = {
  forbidden: [
    {
      name: 'worker-runtime-no-adapters-or-composition',
      severity: 'error',
      from: {
        path: '^worker/src/(?:infrastructure/)?runtime/',
      },
      to: {
        path: '^worker/src/(?:(?:infrastructure/)?adapters|(?:platform/)?composition|(?:platform/)?entrypoints)/',
      },
    },
    {
      name: 'worker-outbound-no-inbound',
      severity: 'error',
      from: {
        path: '^worker/src/(?:infrastructure/)?adapters/out/',
      },
      to: {
        path: '^worker/src/(?:infrastructure/)?adapters/in/',
      },
    },
    {
      name: 'worker-adapters-no-composition',
      severity: 'error',
      from: {
        path: '^worker/src/(?:infrastructure/)?adapters/',
      },
      to: {
        path: '^worker/src/(?:platform/)?(?:composition|entrypoints)(?:/|$)',
      },
    },
    {
      name: 'worker-tools-no-outbound',
      severity: 'error',
      from: {
        path: '^worker/src/(?:infrastructure/)?adapters/in/tools/',
      },
      to: {
        path: '^worker/src/(?:infrastructure/)?adapters/out/',
      },
    },
    {
      name: 'worker-src-no-tooling',
      comment: 'worker/tooling の開発用・評価用の入口は配布物に含めない。',
      severity: 'error',
      from: {
        path: '^worker/src/',
      },
      to: {
        path: '^worker/tooling/',
      },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {
        pathNot: '(^|/)node_modules/',
      },
      to: {
        circular: true,
      },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: {
        couldNotResolve: true,
        pathNot: '^cloudflare:(?:test|workers)$',
      },
    },
    {
      name: 'no-non-package-json',
      severity: 'error',
      from: {
        pathNot:
          '(^|/)node_modules/|(^|/)(?:test|tests|scripts/fixtures)(/|$)|\\.(?:test|spec)\\.[^/]+$',
      },
      to: {
        dependencyTypes: ['unknown', 'npm-no-pkg', 'npm-unknown'],
        pathNot: '^cloudflare:workers$',
      },
    },
    {
      name: 'no-non-package-json-tests',
      severity: 'error',
      from: {
        path: '(^|/)(?:test|tests)(/|$)|\\.(?:test|spec)\\.[^/]+$',
      },
      to: {
        dependencyTypes: ['unknown', 'npm-no-pkg', 'npm-unknown'],
        pathNot: '(^|/)vitest(/|$)|^cloudflare:(?:test|workers)$',
      },
    },
    {
      name: 'cloudflare-workers-only-worker',
      severity: 'error',
      from: {
        pathNot: '^worker/(?!src/(?:core/)?(?:domain|application)(?:/|$))',
      },
      to: {
        path: '^cloudflare:workers$',
      },
    },
    {
      name: 'cloudflare-test-only-worker-tests',
      severity: 'error',
      from: {
        pathNot: '^worker/tests/',
      },
      to: {
        path: '^cloudflare:test$',
      },
    },
    {
      name: 'not-to-test',
      severity: 'error',
      from: {
        pathNot: '(^|/)(test|tests|scripts/fixtures)(/|$)|\\.(?:test|spec)\\.[^/]+$',
      },
      to: {
        path: '(^|/)(test|tests|scripts/fixtures)(/|$)|\\.(?:test|spec)\\.[^/]+$',
      },
    },
    {
      name: 'mobile-only-contracts',
      severity: 'error',
      from: {
        path: '^apps/mobile(?:/|$)',
      },
      to: {
        path: '^(?:packages/(?!contracts(?:/|$))|worker/)',
      },
    },
    {
      name: 'worker-only-contracts',
      severity: 'error',
      from: {
        path: '^worker/',
      },
      to: {
        path: '^(?:apps/mobile(?:/|$)|packages/(?!contracts(?:/|$)))',
      },
    },
    {
      name: 'business-contracts-independent',
      severity: 'error',
      from: {
        path: '^worker/src/(?:core/)?(?:domain|application)/',
      },
      to: {
        path: '^packages/contracts(?:/|$)',
      },
    },
    {
      name: 'business-only-inner',
      severity: 'error',
      from: {
        path: '^worker/src/(?:core/)?(?:domain|application)/',
      },
      to: {
        path: '^(?:apps/mobile(?:/|$)|worker/(?!src/(?:core/)?(?:domain|application)(?:/|$)))',
      },
    },
    {
      name: 'contracts-no-app-or-worker',
      severity: 'error',
      from: {
        path: '^packages/contracts(?:/|$)',
      },
      to: {
        path: '^(?:apps/mobile|worker)(?:/|$)',
      },
    },
    {
      name: 'no-cross-workspace-relative-import',
      severity: 'error',
      from: {
        path: '^(?:apps/mobile|worker)(?:/|$)',
      },
      to: {
        path: '^packages/contracts(?:/|$)',
        dependencyTypes: ['local', 'aliased'],
      },
    },
    {
      name: 'no-cross-workspace-relative-import-from-contracts',
      severity: 'error',
      from: {
        path: '^packages/contracts(?:/|$)',
      },
      to: {
        path: '^(?:packages/(?!contracts(?:/|$))|worker/)',
        dependencyTypes: ['local', 'aliased'],
      },
    },
    {
      name: 'no-private-workspace-import-from-app',
      severity: 'error',
      from: {
        path: '^(?:apps/mobile|worker)(?:/|$)',
      },
      to: {
        path: '^packages/contracts/(?!src/index\\.ts$)',
      },
    },
    {
      name: 'business-no-runtime-sdk',
      severity: 'error',
      from: {
        path: '^worker/src/(?:core/)?(?:domain|application)/',
      },
      to: {
        path: '(^|/)(?:cloudflare|wrangler|expo|react-native|ai|@ai-sdk|@cloudflare|workers-ai-provider)(/|$)',
      },
    },
    {
      name: 'no-fixture-in-production',
      severity: 'error',
      from: {
        path: '^(?:apps/mobile|packages/contracts|worker)(?:/|$)',
        pathNot: '(^|/)(?:test|tests)(/|$)|\\.(?:test|spec)\\.[^/]+$',
      },
      to: {
        path: '(^|/)fixtures(/|$)',
      },
    },
    {
      name: 'domain-only-domain',
      severity: 'error',
      from: {
        path: '^worker/src/(?:core/)?domain/',
      },
      to: {
        path: '^worker/src/(?!(?:core/)?domain(?:/|$))',
      },
    },
    {
      name: 'ports-only-domain-ports',
      severity: 'error',
      from: {
        path: '^worker/src/(?:core/)?application/ports/',
      },
      to: {
        path: '^worker/src/(?!(?:core/)?domain(?:/|$)|(?:core/)?application/ports(?:/|$))',
      },
    },
    {
      name: 'business-external-dependencies',
      severity: 'error',
      from: {
        path: '^worker/src/(?:core/)?(?:domain|application)/',
      },
      to: {
        path: '(^|/)node_modules/',
        pathNot: '(^|/)(?:valibot|vitest)(?:/|$)',
      },
    },
  ],
  options: {
    exclude: {
      path: '(^|/)(?:\\.wrangler|\\.cloudflare|\\.expo|dist|coverage)(/|$)',
    },
    doNotFollow: {
      path: '(^|/)(?:node_modules|dist|coverage)(/|$)',
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.base.json',
    },
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs'],
      conditionNames: ['types', 'import', 'default'],
      exportsFields: ['exports'],
    },
  },
};
