import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const fileLineChecker = resolve('scripts/check-file-lines.mjs');
const disableChecker = resolve('scripts/check-lint-disables.mjs');
const temporaryDirectories: string[] = [];

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ima-quality-'));
  temporaryDirectories.push(root);
  return root;
}

function lines(count: number) {
  return `${Array.from({ length: count }, (_, index) => `line-${index}`).join('\n')}\n`;
}

function run(script: string, cwd: string) {
  return spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('file line quality gate', () => {
  it.each([
    ['source.ts', 500, 0],
    ['source.ts', 501, 1],
    ['fixture.json', 501, 1],
    ['README.md', 501, 0],
    ['bun.lock', 501, 0],
    ['repomix-output.xml', 501, 0],
    ['handwritten.xml', 501, 1],
    ['index.html', 501, 1],
    ['mock.html', 501, 1],
    ['.codex/skills/example/scripts/bundle.js', 501, 0],
    ['.codex/config.json', 501, 1],
    ['worker/skills/source.ts', 501, 1],
  ])('%s with %i lines returns status %i', (file, count, status) => {
    const root = temporaryRoot();
    const target = join(root, file);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, lines(count));

    const result = run(fileLineChecker, root);
    expect(result.status).toBe(status);
    if (status === 1) {
      expect(result.stderr).toContain(`${file}: ${count} lines`);
    }
  });

  it('does not follow a dangling local tool symlink', () => {
    const root = temporaryRoot();
    symlinkSync('missing-skill', join(root, 'skill-link'));
    expect(run(fileLineChecker, root).status).toBe(0);
  });
});

describe('eslint disable quality gate', () => {
  it('excludes agent skill scripts without excluding application source', () => {
    const root = temporaryRoot();
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    const skillDirectory = join(root, '.codex/skills/example');
    mkdirSync(skillDirectory, { recursive: true });
    const directive = ['eslint', 'disable'].join('-');
    writeFileSync(join(skillDirectory, 'example.js'), `// ${directive}\n`);
    expect(run(disableChecker, root).status).toBe(0);
    writeFileSync(join(root, 'source.js'), `// ${directive}\n`);
    expect(run(disableChecker, root).status).toBe(1);
  });

  it('scans untracked source files and requires an inline reason', () => {
    const root = temporaryRoot();
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    const directive = ['eslint', 'disable-next-line'].join('-');
    writeFileSync(root + '/allowed.ts', `// ${directive} no-console -- reason: fixture\n`);
    expect(run(disableChecker, root).status).toBe(0);

    writeFileSync(root + '/blocked.ts', `// ${directive} no-console\n`);
    const result = run(disableChecker, root);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('blocked.ts:1:');
  });

  it('rejects all-rule and max-lines disables even with a reason', () => {
    const root = temporaryRoot();
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    const disable = ['eslint', 'disable'].join('-');
    writeFileSync(root + '/all.ts', `/* ${disable} -- reason: broad exception */\n`);
    writeFileSync(root + '/max-lines.ts', `// ${disable} max-lines -- reason: too large\n`);

    const result = run(disableChecker, root);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('disable-all-rules');
    expect(result.stdout + result.stderr).toContain('max-lines-disable');
  });
});
