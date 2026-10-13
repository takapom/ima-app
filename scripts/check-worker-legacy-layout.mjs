import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Core 移行前の鏡パス。ここに .ts を置くと @worker/* の第二入口になる。 */
const LEGACY_ROOTS = [
  'worker/src/domain',
  'worker/src/application',
  'worker/src/runtime',
  'worker/src/adapters',
  'worker/src/composition',
  'worker/src/entrypoints',
  'worker/src/security',
];

const repositoryRoot = process.cwd();

const collectTypeScriptSources = (directory, collected) => {
  for (const name of readdirSync(directory)) {
    const absolutePath = join(directory, name);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      collectTypeScriptSources(absolutePath, collected);
      continue;
    }
    if (absolutePath.endsWith('.ts') && !absolutePath.endsWith('.d.ts')) {
      collected.push(relative(repositoryRoot, absolutePath));
    }
  }
};

const violations = [];
for (const legacyRoot of LEGACY_ROOTS) {
  const absoluteRoot = join(repositoryRoot, legacyRoot);
  try {
    statSync(absoluteRoot);
  } catch {
    continue;
  }
  const sources = [];
  collectTypeScriptSources(absoluteRoot, sources);
  violations.push(...sources);
}

if (violations.length > 0) {
  console.error(
    [
      'legacy-worker-layout: TypeScript sources must live under worker/src/core/, infrastructure/, platform/, or policy/.',
      ...violations.map((path) => `  ${path}`),
    ].join('\n'),
  );
  process.exit(1);
}
