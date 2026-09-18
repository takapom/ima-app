import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Gate order matches the pre-commit and CI sequence: cheap checks fail first.
export const allGates = [
  'format',
  'docs',
  'lint',
  'architecture',
  'typecheck',
  'test:unit',
  'test:app-integrity',
  'test:worker-http',
  'test:runtime',
];

const code = ['format', 'lint', 'typecheck'];
const worker = ['test:app-integrity', 'test:worker-http', 'test:runtime'];

// A path selects only the gates it can affect. Mobile carries no worker or core
// dependency, and documents compile nothing, so both skip the worker pools.
const rules = [
  [/^(?:README|AGENTS|CLAUDE)\.md$/, ['format', 'docs']],
  [/^docs\/[^/]+\.md$/, ['format', 'docs']],
  [/^\.agents\/skills\/[^/]+\/SKILL\.md$/, ['format', 'docs']],
  [/^apps\/mobile\//, [...code, 'architecture', 'test:unit']],
  [/^packages\/contracts\//, [...code, 'architecture', 'test:unit', ...worker]],
  [/^worker\//, [...code, 'architecture', 'test:unit', ...worker]],
  [/^tests\//, [...code, 'test:unit', 'test:worker-http']],
  [/^scripts\//, [...code, 'docs', 'test:unit']],
];

export function selectGates(files) {
  const selected = new Set();
  for (const file of files) {
    const rule = rules.find(([pattern]) => pattern.test(file));
    // An unrecognised path is treated as a root or shared change: run everything.
    if (!rule) {
      return [...allGates];
    }
    for (const gate of rule[1]) {
      selected.add(gate);
    }
  }
  return allGates.filter((gate) => selected.has(gate));
}

export function stagedFiles(root = process.cwd()) {
  const result = spawnSync('git', ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`git diff --cached failed: ${result.stderr?.trim() ?? ''}`);
  }
  return result.stdout.split('\0').filter(Boolean);
}

export function main(argv = process.argv.slice(2), root = process.cwd()) {
  // Explicit paths keep the selection inspectable without staging a change.
  const given = argv.filter((argument) => !argument.startsWith('--'));
  const files = given.length > 0 ? given : stagedFiles(root);
  const gates = argv.includes('--all') ? [...allGates] : selectGates(files);

  if (argv.includes('--list')) {
    console.log(gates.join('\n'));
    return 0;
  }
  if (gates.length === 0) {
    console.log('No staged change requires a quality gate.');
    return 0;
  }

  console.log(`Selected gates: ${gates.join(', ')}`);
  for (const gate of gates) {
    const result = spawnSync('bun', ['run', gate], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) {
      console.error(`Gate failed: ${gate}`);
      return result.status ?? 1;
    }
  }
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  process.exitCode = main();
}
