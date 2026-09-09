import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as typescript from 'typescript';

export function parseSourceFileList(output) {
  return (
    output
      .split('\0')
      .filter(Boolean)
      .filter((file) => existsSync(file))
      // Wrangler owns the generated declaration, including its blanket lint directive.
      .filter((file) => file !== 'workers/api/tests/runtime-gate/runtime-env.d.ts')
      .filter((file) => file !== 'scripts/check-lint-disables.mjs')
  );
}

export function findUndocumentedDisables(files, readFile = (file) => readFileSync(file, 'utf8')) {
  const undocumented = [];
  for (const file of files) {
    const source = readFile(file);
    const scanner = typescript.createScanner(
      typescript.ScriptTarget.Latest,
      false,
      typescript.LanguageVariant.JSX,
      source,
    );
    let token = scanner.scan();
    while (token !== typescript.SyntaxKind.EndOfFileToken) {
      if (
        token !== typescript.SyntaxKind.SingleLineCommentTrivia &&
        token !== typescript.SyntaxKind.MultiLineCommentTrivia
      ) {
        token = scanner.scan();
        continue;
      }
      const line = source.slice(0, scanner.getTokenPos()).split('\n').length;
      const comment = scanner.getTokenText();
      const directive =
        comment.match(/^\/\/\s*eslint-disable(?:-(?:next-line|line))?\b([\s\S]*)$/) ??
        comment.match(/^\/\*\s*eslint-disable(?:-(?:next-line|line))?\b([\s\S]*?)\*\/$/);
      if (!directive) {
        token = scanner.scan();
        continue;
      }
      const body = directive[1].trim();
      const reasonSeparator = body.indexOf('--');
      const rules = (reasonSeparator === -1 ? body : body.slice(0, reasonSeparator))
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean);
      const reason = reasonSeparator === -1 ? '' : body.slice(reasonSeparator + 2).trim();
      if (rules.length === 0) {
        undocumented.push(`${file}:${line}:disable-all-rules`);
      } else if (rules.includes('max-lines')) {
        undocumented.push(`${file}:${line}:max-lines-disable`);
      } else if (!/\breason:\s*\S/.test(reason)) {
        undocumented.push(`${file}:${line}:missing-or-empty-reason`);
      }
      token = scanner.scan();
    }
  }
  return undocumented;
}

const files = parseSourceFileList(
  execFileSync(
    'git',
    [
      'ls-files',
      '-co',
      '--exclude-standard',
      '-z',
      '--',
      '*.ts',
      '*.tsx',
      '*.js',
      '*.mjs',
      '*.cjs',
    ],
    { encoding: 'utf8' },
  ),
);
if (files.length === 0) {
  process.exit(0);
}

const undocumented = findUndocumentedDisables(files);

if (undocumented.length > 0) {
  console.error('Every eslint-disable must include an inline reason:');
  console.error(undocumented.join('\n'));
  process.exit(1);
}
