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

import { baseFiles, cases } from './architecture-fixtures.mjs';

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
        'worker/package.json': JSON.stringify({
          name: '@ima/worker',
          dependencies: { '@ima/contracts': 'workspace:*', wrangler: '1.0.0' },
        }),
      });
    }
    if (testCase.addZod) {
      writeFixture(root, {
        'node_modules/zod/package.json': JSON.stringify({
          name: 'zod',
          main: 'index.js',
          version: '1.0.0',
        }),
        'node_modules/zod/index.js': 'module.exports = {};\n',
        'worker/package.json': JSON.stringify({
          name: '@ima/worker',
          dependencies: { '@ima/contracts': 'workspace:*', zod: '1.0.0' },
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
        'worker/fixtures/runtime.js': 'export const fixture = true;\n',
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
      [dependencyCruiser, '--validate', '.dependency-cruiser.cjs', 'apps', 'packages', 'worker'],
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
