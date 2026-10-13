export const baseFiles = {
  'apps/mobile/package.json':
    '{"name":"@ima/mobile","dependencies":{"@ima/contracts":"workspace:*","react":"1.0.0"}}',
  'apps/mobile/src/index.ts':
    "import { contract } from '@ima/contracts';\nimport React from 'react';\nexport { contract, React };\n",
  'apps/mobile/src/view.ts': 'export const view = true;\n',
  'packages/contracts/package.json':
    '{"name":"@ima/contracts","exports":{".":{"types":"./src/index.ts","default":"./src/index.ts"}}}',
  'packages/contracts/src/index.ts': 'export const contract = true;\n',
  'packages/contracts/src/value.ts': 'export const value = true;\n',
  'worker/src/core/domain/model.ts': 'export type Model = { readonly id: string };\n',
  'worker/src/core/application/ports/index.ts':
    "import type { Model } from '../../domain/model.js';\nexport type Port = (model: Model) => void;\n",
  'worker/src/core/application/index.ts':
    "import type { Model } from '../domain/model.js';\nimport type { Port } from './ports/index.js';\nexport type Application = (model: Model, port: Port) => void;\nexport type { OwnerStore } from './ports/owner-store.js';\n",
  'worker/src/helpers/util.ts': 'export const helper = true;\n',
  'worker/src/infrastructure/adapters/index.ts': 'export const adapter = true;\n',
  'worker/package.json': '{"name":"@ima/worker","dependencies":{"@ima/contracts":"workspace:*"}}',
  'worker/src/platform/entrypoints/cloudflare/worker.ts':
    "import type { Application } from '@worker/core/application/index.js';\nimport { contract } from '@ima/contracts';\nexport type { Application };\nexport { contract };\n",
  'worker/src/infrastructure/adapters/in/http/router.ts': 'export const http = true;\n',
  'worker/src/infrastructure/adapters/in/tools/index.ts': 'export const tools = true;\n',
  'worker/src/infrastructure/adapters/out/providers/provider.ts': 'export const provider = true;\n',
  'worker/src/platform/composition/factory.ts': 'export const factory = true;\n',
  'worker/src/platform/composition/bootstrap.ts': 'export const bootstrap = true;\n',
  'worker/tooling/eval/stub.ts': 'export const stub = true;\n',
  'worker/src/core/application/ports/owner-store.ts':
    'export type OwnerStore = { read(): void };\n',
  'worker/src/core/application/ports/saved-reference-store.ts':
    'export type StoreResult = { ok: boolean };\n',
  'node_modules/react/package.json': '{"name":"react","main":"index.js","version":"1.0.0"}',
  'node_modules/react/index.js': 'module.exports = {};\n',
  'node_modules/vitest/package.json': '{"name":"vitest","main":"index.js","version":"4.1.11"}',
  'node_modules/vitest/index.js': 'module.exports = {};\n',
};

export const cases = [
  {
    name: 'worker-source-cannot-import-tooling',
    target: 'worker/src/platform/composition/eval.ts',
    source: "import '../../../tooling/eval/stub.js';\n",
    rule: 'worker-src-no-tooling',
  },
  {
    name: 'tooling-may-import-worker-source',
    target: 'worker/tooling/eval/worker.ts',
    source: "import '@worker/platform/composition/factory.js';\n",
  },
  {
    name: 'runtime-cannot-import-input-adapter',
    target: 'worker/src/infrastructure/runtime/turn.ts',
    source: "import '@worker/infrastructure/adapters/in/tools/index.js';\n",
    rule: 'worker-runtime-no-adapters-or-composition',
  },
  {
    name: 'runtime-cannot-import-output-adapter',
    target: 'worker/src/infrastructure/runtime/turn.ts',
    source: "import '@worker/infrastructure/adapters/out/providers/provider.js';\n",
    rule: 'worker-runtime-no-adapters-or-composition',
  },
  {
    name: 'runtime-cannot-import-composition',
    target: 'worker/src/infrastructure/runtime/turn.ts',
    source: "import '@worker/platform/composition/factory.js';\n",
    rule: 'worker-runtime-no-adapters-or-composition',
  },
  {
    name: 'outbound-may-implement-owner-port',
    target: 'worker/src/infrastructure/adapters/out/providers/provider.ts',
    source:
      "import type { OwnerStore } from '@worker/core/application/index.js'; export type Provider = OwnerStore;\n",
  },
  {
    name: 'composition-may-import-adapters',
    target: 'worker/src/platform/composition/factory.ts',
    source:
      "import '@worker/infrastructure/adapters/in/tools/index.js'; import '@worker/infrastructure/adapters/out/providers/provider.js';\n",
  },
  {
    name: 'outbound-cannot-import-inbound',
    target: 'worker/src/infrastructure/adapters/out/providers/provider.ts',
    source: "import '@worker/infrastructure/adapters/in/http/router.js';\n",
    rule: 'worker-outbound-no-inbound',
  },
  {
    name: 'adapter-cannot-import-composition',
    target: 'worker/src/infrastructure/adapters/out/providers/provider.ts',
    source: "import '@worker/platform/composition/factory.js';\n",
    rule: 'worker-adapters-no-composition',
  },
  {
    name: 'adapter-cannot-import-bootstrap',
    target: 'worker/src/infrastructure/adapters/in/http/router.ts',
    source: "import '@worker/platform/composition/bootstrap.js';\n",
    rule: 'worker-adapters-no-composition',
  },
  {
    name: 'tools-cannot-import-provider',
    target: 'worker/src/infrastructure/adapters/in/tools/index.ts',
    source: "export * from '@worker/infrastructure/adapters/out/providers/provider.js';\n",
    rule: 'worker-tools-no-outbound',
  },
  {
    name: 'owner-port-cannot-import-adapter-type',
    target: 'worker/src/core/application/ports/owner-store.ts',
    source:
      "import type { provider } from '@worker/infrastructure/adapters/out/providers/provider.js'; export type OwnerStore = typeof provider;\n",
    rule: 'business-only-inner',
  },
  {
    name: 'owner-contract-cannot-reexport-adapter',
    target: 'worker/src/core/application/ports/saved-reference-store.ts',
    source: "export * from '@worker/infrastructure/adapters/out/providers/provider.js';\n",
    rule: 'business-only-inner',
  },
  {
    name: 'allowed-public-entries-and-business-direction',
    expected: null,
  },
  {
    name: 'mobile-internal-alias-is-allowed',
    source: "export { view } from '@mobile/view.js';\n",
  },
  {
    name: 'contracts-internal-alias-is-allowed',
    source: "export { value as contract } from '@contracts/value.js';\n",
    target: 'packages/contracts/src/index.ts',
  },
  {
    name: 'business-internal-alias-is-allowed',
    source: "export * from '@worker/core/application/index.js';\n",
    target: 'worker/src/core/application/barrel.ts',
  },
  {
    name: 'worker-internal-alias-is-allowed',
    source: "export { http } from '@worker/infrastructure/adapters/in/http/router.js';\n",
    target: 'worker/src/platform/entrypoints/cloudflare/worker.ts',
  },
  {
    name: 'mobile-cannot-bypass-contracts-package-with-alias',
    source: "export * from '@contracts/index.js';\n",
    rule: 'no-cross-workspace-relative-import',
  },
  {
    name: 'business-domain-cannot-import-application-through-alias',
    source: "import '@worker/core/application/index.js';\n",
    target: 'worker/src/core/domain/model.ts',
    rule: 'domain-only-domain',
  },
  {
    name: 'worker-may-import-workerd-virtual-module',
    source: "import { DurableObject } from 'cloudflare:workers';\nexport { DurableObject };\n",
    target: 'worker/src/platform/entrypoints/cloudflare/worker.ts',
  },
  {
    name: 'business-cannot-import-workerd-virtual-module',
    source: "import 'cloudflare:workers';\n",
    target: 'worker/src/core/application/index.ts',
    rule: 'cloudflare-workers-only-worker',
  },
  {
    name: 'worker-tests-may-import-pool-virtual-module',
    source: "import { env } from 'cloudflare:test';\nexport { env };\n",
    target: 'worker/tests/runtime.test.ts',
  },
  {
    name: 'worker-production-cannot-import-pool-virtual-module',
    source: "import 'cloudflare:test';\n",
    target: 'worker/src/platform/entrypoints/cloudflare/worker.ts',
    rule: 'cloudflare-test-only-worker-tests',
  },
  {
    name: 'business-tests-cannot-import-pool-virtual-module',
    source: "import 'cloudflare:test';\n",
    target: 'worker/src/core/application/runtime.test.ts',
    rule: 'cloudflare-test-only-worker-tests',
  },
  {
    name: 'mobile-cannot-import-business',
    source: "import '@worker/core/application/index.js';\n",
    rule: 'mobile-only-contracts',
  },
  {
    name: 'worker-cannot-import-mobile',
    source: "import '../../../../../apps/mobile/src/index.js';\n",
    rule: 'worker-only-contracts',
    target: 'worker/src/platform/entrypoints/cloudflare/worker.ts',
  },
  {
    name: 'business-and-contracts-are-independent',
    source: "import '@worker/core/application/index.js';\n",
    rule: 'contracts-no-app-or-worker',
    target: 'packages/contracts/src/index.ts',
  },
  {
    name: 'business-cannot-import-mobile',
    source: "import '../../../../apps/mobile/src/index.js';\n",
    rule: 'business-only-inner',
    target: 'worker/src/core/application/index.ts',
  },
  {
    name: 'business-cannot-import-worker',
    source: "import '../../platform/entrypoints/cloudflare/worker.js';\n",
    rule: 'business-only-inner',
    target: 'worker/src/core/application/index.ts',
  },
  {
    name: 'contracts-cannot-import-mobile',
    source: "import '../../../apps/mobile/src/index.js';\n",
    rule: 'contracts-no-app-or-worker',
    target: 'packages/contracts/src/index.ts',
  },
  {
    name: 'contracts-cannot-import-worker',
    source: "import '../../../worker/src/platform/entrypoints/cloudflare/worker.js';\n",
    rule: 'contracts-no-app-or-worker',
    target: 'packages/contracts/src/index.ts',
  },
  {
    name: 'relative-cross-workspace-imports-are-forbidden',
    source: "import '../../../packages/contracts/src/index.js';\n",
    rule: 'no-cross-workspace-relative-import',
  },
  {
    name: 'business-cannot-import-parent-worker',
    source: "import '../../platform/entrypoints/cloudflare/worker.js';\n",
    target: 'worker/src/core/application/index.ts',
    rule: 'business-only-inner',
  },
  {
    name: 'business-cannot-import-runtime-sdk',
    source: "import 'wrangler';\n",
    rule: 'business-no-runtime-sdk',
    target: 'worker/src/core/application/index.ts',
    addWrangler: true,
  },
  {
    name: 'production-cannot-import-tests',
    source: "import '../../../tests/shared.js';\n",
    rule: 'not-to-test',
    target: 'apps/mobile/src/index.ts',
    addTest: true,
  },
  {
    name: 'production-cannot-import-test-named-module',
    source: "import './helper.test.js';\n",
    rule: 'not-to-test',
    target: 'apps/mobile/src/index.ts',
    addTestNamedModule: true,
  },
  {
    name: 'unresolved-imports-are-rejected',
    source: "import '@ima/missing';\n",
    rule: 'not-to-unresolvable',
  },
  {
    name: 'undeclared-package-imports-are-rejected',
    source: "import 'undeclared-fixture-package';\n",
    rule: 'no-non-package-json',
    addUndeclared: true,
  },
  {
    name: 'type-import-boundaries-are-enforced',
    source:
      "import type { Application } from '@worker/core/application/index.js';\nexport type Value = Application;\n",
    rule: 'mobile-only-contracts',
  },
  {
    name: 'reexport-boundaries-are-enforced',
    source: "export * from '@worker/core/application/index.js';\n",
    rule: 'mobile-only-contracts',
  },
  {
    name: 'alias-boundaries-are-enforced',
    source: "import '@worker/core/application/index.js';\n",
    rule: 'mobile-only-contracts',
  },
  {
    name: 'business-domain-cannot-import-helper',
    source: "import '../../helpers/util.js';\n",
    rule: 'domain-only-domain',
    target: 'worker/src/core/domain/model.ts',
  },
  {
    name: 'business-application-cannot-import-adapter',
    source: "import '../../infrastructure/adapters/index.js';\n",
    rule: 'business-only-inner',
    target: 'worker/src/core/application/index.ts',
  },
  {
    name: 'mobile-manifest-cannot-declare-business-without-import',
    manifestRule: 'manifest-mobile-only-contracts',
    addManifestDependency: ['apps/mobile/package.json', '@ima/worker'],
  },
  {
    name: 'worker-manifest-cannot-declare-mobile-without-import',
    manifestRule: 'manifest-worker-only-contracts',
    addManifestDependency: ['worker/package.json', '@ima/mobile'],
  },
  {
    name: 'vitest-is-allowed-only-for-test-runner',
    source: "import { expect } from 'vitest';\nexport { expect };\n",
    target: 'packages/contracts/src/runner.test.ts',
  },
  {
    name: 'test-cannot-import-undeclared-package',
    source: "import 'undeclared-fixture-package';\n",
    rule: 'no-non-package-json-tests',
    target: 'packages/contracts/src/undeclared.test.ts',
    addUndeclared: true,
  },
  {
    name: 'worker-runtime-test-may-import-fixture',
    source: "import './fixtures/runtime.js';\n",
    target: 'worker/runtime.test.ts',
    addFixture: true,
  },
  {
    name: 'worker-production-cannot-import-fixture',
    source: "import './fixtures/runtime.js';\n",
    target: 'worker/runtime.ts',
    rule: 'no-fixture-in-production',
    addFixture: true,
  },
  {
    name: 'worker-may-import-business-module-directly',
    target: 'worker/src/platform/entrypoints/cloudflare/worker.ts',
    source: "import type { Model } from '@worker/core/domain/model.js'; export type { Model };\n",
  },
  {
    name: 'business-cannot-import-contracts',
    target: 'worker/src/core/application/index.ts',
    source: "import '@ima/contracts';\n",
    rule: 'business-contracts-independent',
  },
  {
    name: 'port-cannot-import-use-case',
    target: 'worker/src/core/application/ports/owner-store.ts',
    source: "import '@worker/core/application/index.js';\nexport type OwnerStore = object;\n",
    rule: 'ports-only-domain-ports',
  },
  {
    name: 'domain-cannot-import-application-port',
    target: 'worker/src/core/domain/model.ts',
    source: "import '@worker/core/application/ports/owner-store.js';\n",
    rule: 'domain-only-domain',
  },
  {
    name: 'business-cannot-import-parent-worker-relative',
    target: 'worker/src/core/application/index.ts',
    source: "import '../../platform/entrypoints/cloudflare/worker.js';\n",
    rule: 'business-only-inner',
  },
  {
    name: 'business-cannot-import-worker-dependency',
    target: 'worker/src/core/application/index.ts',
    source: "import 'zod';\n",
    rule: 'business-external-dependencies',
    addZod: true,
  },
];
