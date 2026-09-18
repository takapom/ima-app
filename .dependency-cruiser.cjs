module.exports = {
  forbidden: [
    {
      name: 'worker-runtime-no-adapters-or-composition',
      severity: 'error',
      from: {
        path: '^worker/infrastructure/runtime/',
      },
      to: {
        path: '^worker/(?:infrastructure/adapters|composition|entrypoints)/',
      },
    },
    {
      name: 'worker-outbound-no-inbound',
      severity: 'error',
      from: {
        path: '^worker/infrastructure/adapters/outbound/',
      },
      to: {
        path: '^worker/infrastructure/adapters/inbound/',
      },
    },
    {
      name: 'worker-adapters-no-composition',
      severity: 'error',
      from: {
        path: '^worker/infrastructure/adapters/',
      },
      to: {
        path: '^worker/(?:composition|entrypoints)(?:/|$)',
      },
    },
    {
      name: 'worker-tools-no-outbound',
      severity: 'error',
      from: {
        path: '^worker/infrastructure/adapters/inbound/tools/',
      },
      to: {
        path: '^worker/infrastructure/adapters/outbound/',
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
        pathNot: '^worker/(?!core(?:/|$))',
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
      name: 'worker-only-contracts-core',
      severity: 'error',
      from: {
        path: '^worker/(?!core(?:/|$))',
      },
      to: {
        path: '^(?:apps/mobile(?:/|$)|packages/(?!contracts(?:/|$)))',
      },
    },
    {
      name: 'core-contracts-independent',
      severity: 'error',
      from: {
        path: '^worker/core(?:/|$)',
      },
      to: {
        path: '^packages/contracts(?:/|$)',
      },
    },
    {
      name: 'contracts-core-independent',
      severity: 'error',
      from: {
        path: '^packages/contracts(?:/|$)',
      },
      to: {
        path: '^worker/core(?:/|$)',
      },
    },
    {
      name: 'core-no-app-or-worker',
      severity: 'error',
      from: {
        path: '^worker/core(?:/|$)',
      },
      to: {
        path: '^(?:apps/mobile(?:/|$)|worker/(?!core(?:/|$)))',
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
        path: '^(?:apps/mobile(?:/|$)|worker/(?!core(?:/|$)))',
      },
      to: {
        path: '^(?:packages/contracts|worker/core)(?:/|$)',
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
      name: 'no-cross-workspace-relative-import-from-core',
      severity: 'error',
      from: {
        path: '^worker/core(?:/|$)',
      },
      to: {
        path: '^(?:packages/|worker/(?!core(?:/|$)))',
        dependencyTypes: ['local', 'aliased'],
      },
    },
    {
      name: 'no-private-workspace-import-from-app',
      severity: 'error',
      from: {
        path: '^(?:apps/mobile(?:/|$)|worker/(?!core(?:/|$)))',
      },
      to: {
        path: '^(?:packages/contracts|worker/core)/(?!src/index\\.ts$)',
      },
    },
    {
      name: 'core-no-runtime-sdk',
      severity: 'error',
      from: {
        path: '^worker/core(?:/|$)',
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
      name: 'core-domain-only-domain',
      severity: 'error',
      from: {
        path: '^worker/core/src/domain(?:/|$)',
      },
      to: {
        path: '^worker/core/src/(?!domain(?:/|$))',
      },
    },
    {
      name: 'core-ports-only-domain-ports',
      severity: 'error',
      from: {
        path: '^worker/core/src/ports(?:/|$)',
      },
      to: {
        path: '^worker/core/src/(?!domain(?:/|$)|ports(?:/|$))',
      },
    },
    {
      name: 'core-application-only-inner',
      severity: 'error',
      from: {
        path: '^worker/core/src/application(?:/|$)',
      },
      to: {
        path: '^worker/core/src/(?!domain(?:/|$)|ports(?:/|$)|application(?:/|$))',
      },
    },
  ],
  options: {
    exclude: {
      path: '(^|/)(?:\\.wrangler|\\.expo|dist|coverage)(/|$)',
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
