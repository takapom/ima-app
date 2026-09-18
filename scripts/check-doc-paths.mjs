import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Documents live at fixed entry points so planning, progress, and audit records
// stay in GitHub Issues instead of returning as tracked files.
const allowedPaths = new Set(['AGENTS.md', 'CLAUDE.md', 'README.md']);
const allowedPatterns = [/^docs\/[a-z0-9-]+\.md$/, /^\.agents\/skills\/[a-z0-9-]+\/SKILL\.md$/];
const maxDocumentLines = 150;

export function isAllowedDocumentPath(path) {
  return allowedPaths.has(path) || allowedPatterns.some((pattern) => pattern.test(path));
}

export function countDocumentLines(source) {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

export function findDocumentViolations(files, root = process.cwd()) {
  const violations = [];
  for (const file of files) {
    if (!isAllowedDocumentPath(file)) {
      violations.push(`${file}: document path is not an approved entry point`);
      continue;
    }
    const count = countDocumentLines(readFileSync(join(root, file), 'utf8'));
    if (count > maxDocumentLines) {
      violations.push(`${file}: ${count} lines (max ${maxDocumentLines})`);
    }
  }
  return violations;
}

export function trackedDocuments(root = process.cwd()) {
  const output = execFileSync(
    'git',
    ['ls-files', '-co', '--exclude-standard', '-z', '--', '*.md'],
    { cwd: root, encoding: 'utf8' },
  );
  return output.split('\0').filter((file) => file !== '' && existsSync(join(root, file)));
}

export function main(root = process.cwd()) {
  const violations = findDocumentViolations(trackedDocuments(root), root);
  if (violations.length > 0) {
    console.error('Documents must stay at approved entry points and within the line budget:');
    console.error(violations.join('\n'));
    console.error(
      'Plans, progress, and verification evidence belong in GitHub Issues, not tracked files.',
    );
  }
  return violations.length === 0 ? 0 : 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  process.exitCode = main();
}
