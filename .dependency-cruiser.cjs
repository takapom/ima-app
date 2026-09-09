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
      to: { couldNotResolve: true },
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
        pathNot: '(^|/)vitest(/|$)',
      },
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
      to: { path: '^(?:packages/core|packages/eval|workers/api)(?:/|$)' },
    },
    {
      name: 'api-only-contracts-core',
      severity: 'error',
      from: { path: '^workers/api(?:/|$)' },
      to: { path: '^(?:apps/mobile|packages/eval)(?:/|$)' },
    },
    {
      name: 'eval-only-core',
      severity: 'error',
      from: { path: '^packages/eval(?:/|$)' },
      to: { path: '^(?:apps/mobile|packages/contracts|workers/api)(?:/|$)' },
    },
    {
      name: 'core-contracts-independent',
      severity: 'error',
      from: { path: '^packages/core(?:/|$)' },
      to: { path: '^packages/contracts(?:/|$)' },
    },
    {
      name: 'contracts-core-independent',
      severity: 'error',
      from: { path: '^packages/contracts(?:/|$)' },
      to: { path: '^packages/core(?:/|$)' },
    },
    {
      name: 'core-no-app-or-worker',
      severity: 'error',
      from: { path: '^packages/core(?:/|$)' },
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
      from: { path: '^(?:apps/mobile|workers/api|packages/eval)(?:/|$)' },
      to: {
        path: '^packages/(?:contracts|core)(?:/|$)',
        dependencyTypes: ['local', 'aliased'],
      },
    },
    {
      name: 'no-cross-workspace-relative-import-from-contracts',
      severity: 'error',
      from: { path: '^packages/contracts(?:/|$)' },
      to: {
        path: '^packages/(?:core|eval)(?:/|$)',
        dependencyTypes: ['local', 'aliased'],
      },
    },
    {
      name: 'no-cross-workspace-relative-import-from-core',
      severity: 'error',
      from: { path: '^packages/core(?:/|$)' },
      to: {
        path: '^packages/(?:contracts|eval)(?:/|$)',
        dependencyTypes: ['local', 'aliased'],
      },
    },
    {
      name: 'no-private-workspace-import-from-app',
      severity: 'error',
      from: { path: '^(?:apps/mobile|workers/api|packages/eval)(?:/|$)' },
      to: { path: '^packages/(?:contracts|core)/(?!src/index\\.ts$)' },
    },
    {
      name: 'core-no-runtime-sdk',
      severity: 'error',
      from: { path: '^packages/core(?:/|$)' },
      to: {
        path: '(^|/)(?:cloudflare|wrangler|expo|react-native|ai|@ai-sdk|@cloudflare|workers-ai-provider)(/|$)',
      },
    },
    {
      name: 'no-fixture-in-production',
      severity: 'error',
      from: {
        path: '^(?:apps/mobile|workers/api|packages/contracts|packages/core)(?:/|$)',
      },
      to: { path: '(^|/)(?:fixtures|packages/eval)(/|$)' },
    },
    {
      name: 'core-domain-only-domain',
      severity: 'error',
      from: { path: '^packages/core/src/domain(?:/|$)' },
      to: { path: '^packages/core/src/(?!domain(?:/|$))' },
    },
    {
      name: 'core-ports-only-domain-ports',
      severity: 'error',
      from: { path: '^packages/core/src/ports(?:/|$)' },
      to: { path: '^packages/core/src/(?!domain(?:/|$)|ports(?:/|$))' },
    },
    {
      name: 'core-application-only-inner',
      severity: 'error',
      from: { path: '^packages/core/src/application(?:/|$)' },
      to: { path: '^packages/core/src/(?!domain(?:/|$)|ports(?:/|$)|application(?:/|$))' },
    },
  ],
  options: {
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
