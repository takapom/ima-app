import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const pathChecker = resolve('scripts/check-doc-paths.mjs');
const linkChecker = resolve('scripts/check-doc-links.mjs');
const temporaryDirectories: string[] = [];

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ima-docs-'));
  temporaryDirectories.push(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  return root;
}

function write(root: string, file: string, contents: string) {
  const target = join(root, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function run(script: string, cwd: string) {
  return spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('document path gate', () => {
  it.each([
    ['README.md', 0],
    ['AGENTS.md', 0],
    ['.codex/AGENTS.md', 0],
    ['.codex/skills/example/SKILL.md', 0],
    ['.codex/skills/example/references/example.md', 0],
    ['.codex/skills/example/progress.md', 1],
    ['.codex/progress.md', 1],
    ['docs/architecture.md', 0],
    ['.agents/skills/ima-issue-delivery/SKILL.md', 0],
    ['docs/design/m28-hot-pepper.md', 1],
    ['docs/planning/backlog.md', 1],
    ['PROGRESS.md', 1],
    ['docs/nested/deep/note.md', 1],
  ])('%s returns status %i', (file, status) => {
    const root = temporaryRoot();
    write(root, file, '# title\n');

    const result = run(pathChecker, root);
    expect(result.status).toBe(status);
    if (status === 1) {
      expect(result.stderr).toContain('not an approved entry point');
    }
  });

  it('rejects an approved document that exceeds the line budget', () => {
    const root = temporaryRoot();
    write(root, 'docs/product.md', `${Array.from({ length: 151 }, () => 'line').join('\n')}\n`);

    const result = run(pathChecker, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/product.md: 151 lines (max 150)');
  });

  it('allows long skill references while still validating their links', () => {
    const root = temporaryRoot();
    const file = '.codex/skills/example/references/example.md';
    write(root, file, `${'reference\n'.repeat(151)}[missing](missing.md)\n`);
    expect(run(pathChecker, root).status).toBe(0);
    const result = run(linkChecker, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing target missing.md');
  });
});

describe('document link gate', () => {
  it('accepts links that resolve to a file and a heading', () => {
    const root = temporaryRoot();
    write(root, 'docs/architecture.md', '# 構成\n\n## 品質検査\n');
    write(root, 'README.md', '[a](docs/architecture.md)\n[b](docs/architecture.md#品質検査)\n');

    expect(run(linkChecker, root).status).toBe(0);
  });

  it('reports a missing file and a missing heading', () => {
    const root = temporaryRoot();
    write(root, 'docs/product.md', '# 製品\n');
    write(root, 'README.md', '[a](docs/gone.md)\n[b](docs/product.md#no-such)\n');

    const result = run(linkChecker, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('README.md:1: missing target docs/gone.md');
    expect(result.stderr).toContain('README.md:2: missing heading #no-such in docs/product.md');
  });

  it('ignores external links and paths inside code fences', () => {
    const root = temporaryRoot();
    write(
      root,
      'README.md',
      '[x](https://example.com/gone.md)\n\n```sh\n[y](gone.md)\n```\n\n`[z](gone.md)`\n',
    );

    expect(run(linkChecker, root).status).toBe(0);
  });
});
