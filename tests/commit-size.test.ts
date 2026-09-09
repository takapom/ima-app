import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';

const checker = resolve('scripts/check-commit-size.mjs');
const temporaryDirectories: string[] = [];

function git(repo: string, args: string[], input?: string) {
  const result = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    input,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function repo() {
  const directory = mkdtempSync(join(tmpdir(), 'ima-commit-size-'));
  temporaryDirectories.push(directory);
  git(directory, ['init', '--quiet']);
  git(directory, ['config', 'user.name', 'commit-size-test']);
  git(directory, ['config', 'user.email', 'commit-size-test@example.invalid']);
  return directory;
}

function content(lines: number) {
  return `${Array.from({ length: lines }, (_, index) => `line-${index}`).join('\n')}\n`;
}

function commit(repoDirectory: string, message: string) {
  git(repoDirectory, ['add', '--all']);
  git(repoDirectory, ['commit', '--quiet', '-m', message]);
  return git(repoDirectory, ['rev-parse', 'HEAD']);
}

function emptyCommit(repoDirectory: string, message = 'empty') {
  git(repoDirectory, ['commit', '--quiet', '--allow-empty', '-m', message]);
  return git(repoDirectory, ['rev-parse', 'HEAD']);
}

function commitFile(repoDirectory: string, file: string, lines: number, message = 'change') {
  const target = join(repoDirectory, file);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content(lines));
  return commit(repoDirectory, message);
}

function check(repoDirectory: string, args: string[]) {
  return spawnSync(process.execPath, [checker, ...args], {
    cwd: repoDirectory,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('check-commit-size', () => {
  it.each([
    [1999, 0],
    [2000, 0],
    [2001, 1],
  ])('checks a root commit with exactly %i changed lines', (lines, expectedStatus) => {
    const directory = repo();
    const commitSha = commitFile(directory, 'docs/change.md', lines, `root-${lines}`);
    const result = check(directory, ['--commit', commitSha, '--root']);
    expect(result.status).toBe(expectedStatus);
    expect(`${result.stdout}${result.stderr}`).toContain(`total=${lines}`);
  });

  it('checks each range commit independently instead of aggregating the range', () => {
    const directory = repo();
    const base = emptyCommit(directory, 'base');
    const first = commitFile(directory, 'docs/first.md', 1999, 'first');
    const head = commitFile(directory, 'docs/second.md', 1999, 'second');
    const result = check(directory, ['--range', base, head]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`commit ${first}`);
    expect(result.stdout).toContain(`commit ${head}`);
    expect(result.stdout).not.toContain('total=3998');
  });

  it('fails an oversized commit even when a later commit reverts it', () => {
    const directory = repo();
    const base = emptyCommit(directory, 'base');
    const oversized = commitFile(directory, 'generated/output.txt', 2001, 'oversized');
    git(directory, ['revert', '--quiet', '--no-edit', oversized]);
    const head = git(directory, ['rev-parse', 'HEAD']);
    const result = check(directory, ['--range', base, head]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(oversized);
    expect(result.stderr).toContain('exceeds limit 2000');
  });

  it('supports root empty-tree comparison and accepts a zero-change commit', () => {
    const directory = repo();
    const root = emptyCommit(directory, 'root-empty');
    const withoutRoot = check(directory, ['--commit', root]);
    expect(withoutRoot.status).toBe(1);
    expect(withoutRoot.stderr).toContain('pass --root');

    const withRoot = check(directory, ['--commit', root, '--root']);
    expect(withRoot.status).toBe(0);
    expect(withRoot.stdout).toContain('additions=0 deletions=0 total=0');

    const emptyTree = git(directory, ['hash-object', '-t', 'tree', '--stdin'], '');
    const rootRange = check(directory, ['--range', emptyTree, root, '--root']);
    expect(rootRange.status).toBe(0);
    expect(rootRange.stdout).toContain(`commit ${root}`);
  });

  it('fails missing commits and a non-ancestor range instead of treating them as empty', () => {
    const directory = repo();
    const head = emptyCommit(directory, 'head');
    const missing = '1111111111111111111111111111111111111111';
    expect(check(directory, ['--commit', missing]).status).toBe(1);
    expect(check(directory, ['--range', missing, head]).status).toBe(1);

    const emptyTree = git(directory, ['mktree'], '');
    const otherHead = git(directory, ['commit-tree', emptyTree, '-m', 'other-root']);
    expect(check(directory, ['--range', otherHead, head]).status).toBe(1);
    expect(check(directory, ['--range', otherHead, head]).stderr).toContain(
      'range base is not an ancestor',
    );
  });

  it('handles newline filenames and renames through numstat -z', () => {
    const directory = repo();
    const name = 'docs/line\nbreak.md';
    const first = commitFile(directory, name, 3, 'newline-name');
    expect(check(directory, ['--commit', first, '--root']).status).toBe(0);
    const renamed = 'docs/renamed\nfile.md';
    git(directory, ['mv', name, renamed]);
    const second = commit(directory, 'rename-newline-name');
    expect(check(directory, ['--commit', second]).status).toBe(0);
  });

  it('counts docs and lockfiles without path exclusions', () => {
    const directory = repo();
    const base = emptyCommit(directory, 'base');
    const docs = join(directory, 'docs', 'change.md');
    const lock = join(directory, 'package-lock.json');
    mkdirSync(join(docs, '..'), { recursive: true });
    writeFileSync(docs, content(1000));
    writeFileSync(lock, content(1001));
    const head = commit(directory, 'docs-and-lock');
    const result = check(directory, ['--range', base, head]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('total=2001');
  });

  it('checks only staged content in staged mode', () => {
    const directory = repo();
    const target = join(directory, 'docs', 'staged.md');
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content(2000));
    git(directory, ['add', target]);
    writeFileSync(target, `${content(2000)}unstaged\n`);
    const stagedOnly = check(directory, ['--staged']);
    expect(stagedOnly.status).toBe(0);
    expect(stagedOnly.stdout).toContain('total=2000');

    git(directory, ['add', target]);
    const tooLarge = check(directory, ['--staged']);
    expect(tooLarge.status).toBe(1);
    expect(tooLarge.stderr).toContain('total=2001');
  });

  it('fails closed for binary numstat records and names the path', () => {
    const directory = repo();
    const target = join(directory, 'generated', 'image.bin');
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, Uint8Array.from([0, 1, 2, 3, 255]));
    const commitSha = commit(directory, 'binary');
    const result = check(directory, ['--commit', commitSha, '--root']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('generated/image.bin');
    expect(result.stderr).toContain('unknown line bytes');
  });

  it('rejects shallow history before checking a commit', () => {
    const source = repo();
    commitFile(source, 'history.txt', 1, 'history');
    const clone = mkdtempSync(join(tmpdir(), 'ima-commit-size-shallow-'));
    temporaryDirectories.push(clone);
    execFileSync('git', ['clone', '--quiet', '--depth=1', `file://${source}`, clone]);
    const result = check(clone, ['--commit', 'HEAD']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('non-shallow');
  });
});
