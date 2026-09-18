import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Fenced and inline code carry example paths that are not repository links.
function stripCode(source) {
  return source
    .replaceAll(/^```[\s\S]*?^```/gm, '')
    .replaceAll(/^~~~[\s\S]*?^~~~/gm, '')
    .replaceAll(/`[^`\n]*`/g, '');
}

// GitHub slugs: lowercase, drop punctuation, spaces to hyphens, suffix repeats.
export function headingSlugs(source) {
  const counts = new Map();
  const slugs = [];
  for (const match of stripCode(source).matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm)) {
    const base = match[1]
      .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .trim()
      .toLowerCase()
      .replaceAll(/[^\p{L}\p{N}\s_-]/gu, '')
      .replaceAll(/\s+/g, '-');
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    slugs.push(seen === 0 ? base : `${base}-${seen}`);
  }
  return slugs;
}

export function findDocLinkViolations(files, root = process.cwd()) {
  const violations = [];
  for (const file of files) {
    const source = readFileSync(join(root, file), 'utf8');
    const body = stripCode(source);
    for (const match of body.matchAll(/\[(?:[^\]]*)\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) {
        continue;
      }
      const line = body.slice(0, match.index).split('\n').length;
      const separator = target.indexOf('#');
      const path = separator === -1 ? target : target.slice(0, separator);
      const anchor = separator === -1 ? '' : target.slice(separator + 1);
      const absolute = path === '' ? join(root, file) : resolve(dirname(join(root, file)), path);

      if (!existsSync(absolute)) {
        violations.push(`${file}:${line}: missing target ${target}`);
        continue;
      }
      if (anchor === '' || !absolute.endsWith('.md')) {
        continue;
      }
      const slug = decodeURIComponent(anchor).toLowerCase();
      if (!headingSlugs(readFileSync(absolute, 'utf8')).includes(slug)) {
        violations.push(
          `${file}:${line}: missing heading #${anchor} in ${relative(root, absolute)}`,
        );
      }
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
  const violations = findDocLinkViolations(trackedDocuments(root), root);
  if (violations.length > 0) {
    console.error('Document links must resolve to an existing file and heading:');
    console.error(violations.join('\n'));
  }
  return violations.length === 0 ? 0 : 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  process.exitCode = main();
}
