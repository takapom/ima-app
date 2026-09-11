import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const repositoryRoot = process.cwd();
const configPath = resolve(repositoryRoot, '.dependency-cruiser.cjs');
const dependencyCruiser = resolve(repositoryRoot, 'node_modules/.bin/dependency-cruiser');
const manifestChecker = resolve(repositoryRoot, 'scripts/check-manifest-boundaries.mjs');

const baseFiles = {
  'apps/mobile/package.json': JSON.stringify({
    name: '@ima/mobile',
    dependencies: { '@ima/contracts': 'workspace:*', react: '1.0.0' },
  }),
  'apps/mobile/src/index.ts':
    "import { contract } from '@ima/contracts';\nimport React from 'react';\nexport { contract, React };\n",
  'packages/contracts/package.json': JSON.stringify({
    name: '@ima/contracts',
    exports: { '.': { types: './src/index.ts', default: './src/index.ts' } },
  }),
  'packages/contracts/src/index.ts': 'export const contract = true;\n',
  'packages/core/package.json': JSON.stringify({
    name: '@ima/core',
    exports: { '.': { types: './src/index.ts', default: './src/index.ts' } },
  }),
  'packages/core/src/index.ts': "export * from './application/index.js';\n",
  'packages/core/src/domain/model.ts': 'export type Model = { readonly id: string };\n',
  'packages/core/src/ports/index.ts':
    "import type { Model } from '../domain/model.js';\nexport type Port = (model: Model) => void;\n",
  'packages/core/src/application/index.ts':
    "import type { Model } from '../domain/model.js';\nimport type { Port } from '../ports/index.js';\nexport type Application = (model: Model, port: Port) => void;\n",
  'packages/core/src/helpers/util.ts': 'export const helper = true;\n',
  'packages/core/src/adapters/index.ts': 'export const adapter = true;\n',
  'workers/api/package.json': JSON.stringify({ name: '@ima/api' }),
  'workers/api/src/index.ts': 'export const api = true;\n',
  'node_modules/react/package.json': JSON.stringify({
    name: 'react',
    main: 'index.js',
    version: '1.0.0',
  }),
  'node_modules/react/index.js': 'module.exports = {};\n',
  'node_modules/vitest/package.json': JSON.stringify({
    name: 'vitest',
    main: 'index.js',
    version: '4.1.11',
  }),
  'node_modules/vitest/index.js': 'module.exports = {};\n',
};

const cases = [
  { name: 'allowed-public-entries-and-core-direction', expected: null },
  {
    name: 'worker-may-import-workerd-virtual-module',
    source: "import { DurableObject } from 'cloudflare:workers';\nexport { DurableObject };\n",
    target: 'workers/api/src/index.ts',
  },
  {
    name: 'core-cannot-import-workerd-virtual-module',
    source: "import 'cloudflare:workers';\n",
    target: 'packages/core/src/index.ts',
    rule: 'cloudflare-workers-only-worker',
  },
  {
    name: 'worker-tests-may-import-pool-virtual-module',
    source: "import { env } from 'cloudflare:test';\nexport { env };\n",
    target: 'workers/api/tests/runtime.test.ts',
  },
  {
    name: 'worker-production-cannot-import-pool-virtual-module',
    source: "import 'cloudflare:test';\n",
    target: 'workers/api/src/index.ts',
    rule: 'cloudflare-test-only-worker-tests',
  },
  {
    name: 'core-tests-cannot-import-pool-virtual-module',
    source: "import 'cloudflare:test';\n",
    target: 'packages/core/src/runtime.test.ts',
    rule: 'cloudflare-test-only-worker-tests',
  },
  {
    name: 'mobile-cannot-import-core',
    source: "import '@ima/core';\n",
    rule: 'mobile-only-contracts',
  },
  {
    name: 'api-cannot-import-mobile',
    source: "import '../../../apps/mobile/src/index.js';\n",
    rule: 'api-only-contracts-core',
    target: 'workers/api/src/index.ts',
  },
  {
    name: 'core-and-contracts-are-independent',
    source: "import '@ima/core';\n",
    rule: 'contracts-core-independent',
    target: 'packages/contracts/src/index.ts',
  },
  {
    name: 'core-cannot-import-mobile',
    source: "import '../../../apps/mobile/src/index.js';\n",
    rule: 'core-no-app-or-worker',
    target: 'packages/core/src/index.ts',
  },
  {
    name: 'core-cannot-import-worker',
    source: "import '../../../workers/api/src/index.js';\n",
    rule: 'core-no-app-or-worker',
    target: 'packages/core/src/index.ts',
  },
  {
    name: 'contracts-cannot-import-mobile',
    source: "import '../../../apps/mobile/src/index.js';\n",
    rule: 'contracts-no-app-or-worker',
    target: 'packages/contracts/src/index.ts',
  },
  {
    name: 'contracts-cannot-import-worker',
    source: "import '../../../workers/api/src/index.js';\n",
    rule: 'contracts-no-app-or-worker',
    target: 'packages/contracts/src/index.ts',
  },
  {
    name: 'relative-cross-workspace-imports-are-forbidden',
    source: "import '../../../packages/contracts/src/index.js';\n",
    rule: 'no-cross-workspace-relative-import',
  },
  {
    name: 'core-cannot-import-runtime-sdk',
    source: "import 'wrangler';\n",
    rule: 'core-no-runtime-sdk',
    target: 'packages/core/src/index.ts',
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
    source: "import type { Application } from '@ima/core';\nexport type Value = Application;\n",
    rule: 'mobile-only-contracts',
  },
  {
    name: 'reexport-boundaries-are-enforced',
    source: "export * from '@ima/core';\n",
    rule: 'mobile-only-contracts',
  },
  {
    name: 'alias-boundaries-are-enforced',
    source: "import '@core/index.js';\n",
    rule: 'mobile-only-contracts',
    addAlias: true,
  },
  {
    name: 'core-domain-cannot-import-helper',
    source: "import '../helpers/util.js';\n",
    rule: 'core-domain-only-domain',
    target: 'packages/core/src/domain/model.ts',
  },
  {
    name: 'core-application-cannot-import-adapter',
    source: "import '../adapters/index.js';\n",
    rule: 'core-application-only-inner',
    target: 'packages/core/src/application/index.ts',
  },
  {
    name: 'mobile-manifest-cannot-declare-core-without-import',
    manifestRule: 'manifest-mobile-only-contracts',
    addManifestDependency: ['apps/mobile/package.json', '@ima/core'],
  },
  {
    name: 'api-manifest-cannot-declare-mobile-without-import',
    manifestRule: 'manifest-api-only-contracts-core',
    addManifestDependency: ['workers/api/package.json', '@ima/mobile'],
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
    source: "import '../fixtures/runtime.js';\n",
    target: 'workers/api/src/runtime.test.ts',
    addFixture: true,
  },
  {
    name: 'worker-production-cannot-import-fixture',
    source: "import '../fixtures/runtime.js';\n",
    target: 'workers/api/src/runtime.ts',
    rule: 'no-fixture-in-production',
    addFixture: true,
  },
];

function writeFixture(root, files) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
  }
}

function linkWorkspace(root, name, relativePath) {
  const linkPath = join(root, 'node_modules', ...name.split('/'));
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(relativePath, linkPath, 'dir');
}

function runFixture(testCase) {
  const root = mkdtempSync(join(tmpdir(), 'ima-dependency-fixture-'));
  try {
    cpSync(configPath, join(root, '.dependency-cruiser.cjs'));
    cpSync(join(repositoryRoot, 'tsconfig.base.json'), join(root, 'tsconfig.base.json'));
    mkdirSync(join(root, 'scripts'), { recursive: true });
    cpSync(manifestChecker, join(root, 'scripts/check-manifest-boundaries.mjs'));
    writeFixture(root, baseFiles);
    linkWorkspace(root, '@ima/contracts', '../../packages/contracts');
    linkWorkspace(root, '@ima/core', '../../packages/core');
    const sourcePath = testCase.target ?? 'apps/mobile/src/index.ts';
    if (testCase.source !== undefined) {
      writeFixture(root, { [sourcePath]: testCase.source });
    }
    if (testCase.addWrangler) {
      writeFixture(root, {
        'node_modules/wrangler/package.json': JSON.stringify({
          name: 'wrangler',
          main: 'index.js',
          version: '1.0.0',
        }),
        'node_modules/wrangler/index.js': 'module.exports = {};\n',
        'packages/core/package.json': JSON.stringify({
          name: '@ima/core',
          dependencies: { wrangler: '1.0.0' },
        }),
      });
    }
    if (testCase.addTest) {
      writeFixture(root, { 'tests/shared.js': 'export const shared = true;\n' });
    }
    if (testCase.addTestNamedModule) {
      writeFixture(root, { 'apps/mobile/src/helper.test.ts': 'export const testHelper = true;\n' });
    }
    if (testCase.addUndeclared) {
      writeFixture(root, {
        'node_modules/undeclared-fixture-package/package.json': JSON.stringify({
          name: 'undeclared-fixture-package',
          main: 'index.js',
          version: '1.0.0',
        }),
        'node_modules/undeclared-fixture-package/index.js': 'module.exports = {};\n',
      });
    }
    if (testCase.addFixture) {
      writeFixture(root, {
        'workers/api/fixtures/runtime.js': 'export const fixture = true;\n',
      });
    }
    if (testCase.addAlias) {
      writeFixture(root, {
        'tsconfig.base.json': JSON.stringify({
          compilerOptions: { baseUrl: '.', paths: { '@core/*': ['packages/core/src/*'] } },
        }),
      });
    }
    if (testCase.addManifestDependency) {
      const [manifestPath, dependencyName] = testCase.addManifestDependency;
      const manifest = JSON.parse(readFileSync(join(root, manifestPath), 'utf8'));
      manifest.dependencies = { ...manifest.dependencies, [dependencyName]: 'workspace:*' };
      writeFileSync(join(root, manifestPath), JSON.stringify(manifest));
    }
    const result = spawnSync(
      process.execPath,
      [dependencyCruiser, '--validate', '.dependency-cruiser.cjs', 'apps', 'packages', 'workers'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
    const manifestResult = spawnSync(process.execPath, ['scripts/check-manifest-boundaries.mjs'], {
      cwd: root,
      encoding: 'utf8',
    });
    const output = `${result.stdout}\n${result.stderr}`;
    const manifestOutput = `${manifestResult.stdout}\n${manifestResult.stderr}`;
    if (testCase.rule === undefined && result.status !== 0) {
      throw new Error(`${testCase.name}: expected graph success, got\n${output}`);
    }
    if (testCase.rule !== undefined && (result.status === 0 || !output.includes(testCase.rule))) {
      throw new Error(`${testCase.name}: expected ${testCase.rule}, got\n${output}`);
    }
    if (testCase.manifestRule === undefined && manifestResult.status !== 0) {
      throw new Error(`${testCase.name}: expected manifest success, got\n${manifestOutput}`);
    }
    if (
      testCase.manifestRule !== undefined &&
      (manifestResult.status !== 1 || !manifestOutput.includes(testCase.manifestRule))
    ) {
      throw new Error(
        `${testCase.name}: expected ${testCase.manifestRule}, got\n${manifestOutput}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const testCase of cases) {
  runFixture(testCase);
}

console.log(`dependency-cruiser fixtures: ${cases.length} cases passed`);
