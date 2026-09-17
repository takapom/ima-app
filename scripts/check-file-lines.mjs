import { readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, relative, resolve } from 'node:path';

// Local tool state, never source: agent memory and generated code-graph databases.
const ignoredDirectories = new Set([
  '.claude',
  '.code-review-graph',
  '.git',
  '.expo',
  '.grok',
  '.serena',
  '.wrangler',
  'coverage',
  'dist',
  'node_modules',
]);
const ignoredExtensions = new Set(['.md']);
const ignoredFiles = new Set([
  'bun.lock',
  'worker/worker-configuration.d.ts',
  'repomix-output.xml',
]);

export function countFileLines(source) {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

export function findFileLineViolations(root = process.cwd()) {
  const violations = [];

  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (ignoredDirectories.has(entry.name)) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const relativePath = relative(root, path);
      if (ignoredFiles.has(relativePath)) {
        continue;
      }
      const extension = entry.name.slice(entry.name.lastIndexOf('.'));
      if (ignoredExtensions.has(extension)) {
        continue;
      }
      const count = countFileLines(readFileSync(path, 'utf8'));
      if (count > 500) {
        violations.push({ count, path: relativePath });
      }
    }
  }

  walk(root);
  return violations;
}

export function main(root = process.cwd()) {
  const violations = findFileLineViolations(root);
  for (const violation of violations) {
    console.error(`${violation.path}: ${violation.count} lines (max 500)`);
  }
  return violations.length === 0 ? 0 : 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  process.exitCode = main();
}
