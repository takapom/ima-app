module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: { pathNot: '(^|/)node_modules/' },
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      // These virtual modules are supplied by workerd and its test pool.
      to: { couldNotResolve: true, pathNot: '^cloudflare:(?:test|workers)$' },
    },
    {
      name: 'no-non-package-json',
      severity: 'error',
      // Unit-test runners are root-level dev tooling; workspace manifests own
      // production/runtime dependencies and the manifest checker covers those.
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
      from: { pathNot: '^workers/api/' },
      to: { path: '^cloudflare:workers$' },
    },
    {
      name: 'cloudflare-test-only-worker-tests',
      severity: 'error',
      from: { pathNot: '^workers/api/tests/' },
      to: { path: '^cloudflare:test$' },
    },
    {
      name: 'not-to-test',
      severity: 'error',
      from: { pathNot: '(^|/)(test|tests|scripts/fixtures)(/|$)|\\.(?:test|spec)\\.[^/]+$' },
      to: { path: '(^|/)(test|tests|scripts/fixtures)(/|$)|\\.(?:test|spec)\\.[^/]+$' },
    },
    {
      name: 'mobile-only-contracts',
      severity: 'error',
      from: { path: '^apps/mobile(?:/|$)' },
      to: { path: '^(?:packages/(?!contracts(?:/|$))|workers/|worker/)' },
    },
    {
      name: 'api-only-contracts-core',
      severity: 'error',
      from: { path: '^workers/api(?:/|$)' },
      to: { path: '^(?:apps/mobile(?:/|$)|packages/(?!(?:contracts|core)(?:/|$)))' },
    },
    {
      name: 'core-contracts-independent',
      severity: 'error',
      from: { path: '^worker/core(?:/|$)' },
      to: { path: '^packages/contracts(?:/|$)' },
    },
    {
      name: 'contracts-core-independent',
      severity: 'error',
      from: { path: '^packages/contracts(?:/|$)' },
      to: { path: '^worker/core(?:/|$)' },
    },
    {
      name: 'core-no-app-or-worker',
      severity: 'error',
      from: { path: '^worker/core(?:/|$)' },
      to: { path: '^(?:apps/mobile|workers/api)(?:/|$)' },
    },
    {
      name: 'contracts-no-app-or-worker',
      severity: 'error',
      from: { path: '^packages/contracts(?:/|$)' },
      to: { path: '^(?:apps/mobile|workers/api)(?:/|$)' },
    },
    {
      name: 'no-cross-workspace-relative-import',
      severity: 'error',
      from: { path: '^(?:apps/mobile|workers/api)(?:/|$)' },
      to: {
        path: '^(?:packages/contracts|worker/core)(?:/|$)',
        dependencyTypes: ['local', 'aliased'],
      },
    },
    {
      name: 'no-cross-workspace-relative-import-from-contracts',
      severity: 'error',
      from: { path: '^packages/contracts(?:/|$)' },
      to: {
        path: '^(?:packages/(?!contracts(?:/|$))|worker/core(?:/|$))',
        dependencyTypes: ['local', 'aliased'],
      },
    },
    {
      name: 'no-cross-workspace-relative-import-from-core',
      severity: 'error',
      from: { path: '^worker/core(?:/|$)' },
      to: {
        path: '^packages/',
        dependencyTypes: ['local', 'aliased'],
      },
    },
    {
      name: 'no-private-workspace-import-from-app',
      severity: 'error',
      from: { path: '^(?:apps/mobile|workers/api)(?:/|$)' },
      to: { path: '^(?:packages/contracts|worker/core)/(?!src/index\\.ts$)' },
    },
    {
      name: 'core-no-runtime-sdk',
      severity: 'error',
      from: { path: '^worker/core(?:/|$)' },
      to: {
        path: '(^|/)(?:cloudflare|wrangler|expo|react-native|ai|@ai-sdk|@cloudflare|workers-ai-provider)(/|$)',
      },
    },
    {
      name: 'no-fixture-in-production',
      severity: 'error',
      from: {
        path: '^(?:apps/mobile|workers/api|packages/contracts|worker/core)(?:/|$)',
        pathNot: '(^|/)(?:test|tests)(/|$)|\\.(?:test|spec)\\.[^/]+$',
      },
      to: { path: '(^|/)fixtures(/|$)' },
    },
    {
      name: 'core-domain-only-domain',
      severity: 'error',
      from: { path: '^worker/core/src/domain(?:/|$)' },
      to: { path: '^worker/core/src/(?!domain(?:/|$))' },
    },
    {
      name: 'core-ports-only-domain-ports',
      severity: 'error',
      from: { path: '^worker/core/src/ports(?:/|$)' },
      to: { path: '^worker/core/src/(?!domain(?:/|$)|ports(?:/|$))' },
    },
    {
      name: 'core-application-only-inner',
      severity: 'error',
      from: { path: '^worker/core/src/application(?:/|$)' },
      to: { path: '^worker/core/src/(?!domain(?:/|$)|ports(?:/|$)|application(?:/|$))' },
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
