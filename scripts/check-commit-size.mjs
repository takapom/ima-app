#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MAX_LINES = 2000n;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function git(args, cwd, { allowFailure = false, input } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'buffer',
    input,
  });
  if (result.error) throw new Error(`git ${args.join(' ')}: ${result.error.message}`);
  const stdout = result.stdout?.toString('utf8') ?? '';
  const stderr = result.stderr?.toString('utf8').trim() ?? '';
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
  return { ...result, stdout, stderr };
}

function repositoryRoot() {
  return git(['rev-parse', '--show-toplevel'], process.cwd()).stdout.trim();
}

function resolveCommit(ref, cwd) {
  const result = git(
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`],
    cwd,
    { allowFailure: true },
  );
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`commit does not exist: ${ref}`);
  }
  return result.stdout.trim();
}

function ensureCompleteHistory(cwd) {
  const result = git(['rev-parse', '--is-shallow-repository'], cwd);
  if (result.stdout.trim() === 'true') {
    throw new Error('history mode requires a complete non-shallow repository');
  }
}

function parentsOf(commit, cwd) {
  const result = git(['rev-list', '--parents', '-n', '1', commit], cwd);
  const fields = result.stdout.trim().split(/\s+/).filter(Boolean);
  if (fields[0] !== commit) throw new Error(`could not inspect commit: ${commit}`);
  const parents = fields.slice(1);
  for (const parent of parents) {
    const exists = git(['cat-file', '-e', `${parent}^{commit}`], cwd, { allowFailure: true });
    if (exists.status !== 0) {
      throw new Error(`missing parent ${parent} of commit ${commit}`);
    }
  }
  return parents;
}

function parseNumstat(output) {
  const records = [];
  for (const token of output.split('\0')) {
    if (!token) continue;
    const firstTab = token.indexOf('\t');
    const secondTab = firstTab < 0 ? -1 : token.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) {
      throw new Error('malformed git --numstat -z output');
    }
    const added = token.slice(0, firstTab);
    const deleted = token.slice(firstTab + 1, secondTab);
    const path = token.slice(secondTab + 1);
    if (!path) throw new Error('git --numstat -z returned an empty path');
    if (added === '-' || deleted === '-') {
      records.push({ binary: true, path });
      continue;
    }
    if (!/^\d+$/.test(added) || !/^\d+$/.test(deleted)) {
      throw new Error(`malformed line counts for ${JSON.stringify(path)}`);
    }
    records.push({ added: BigInt(added), deleted: BigInt(deleted), path });
  }
  return records;
}

function diffFor(base, commit, cwd) {
  const result = git(['diff', '--numstat', '-z', '--no-renames', base, commit, '--'], cwd);
  return parseNumstat(result.stdout);
}

function stagedDiff(cwd) {
  const result = git(['diff', '--cached', '--numstat', '-z', '--no-renames', '--'], cwd);
  return parseNumstat(result.stdout);
}

function summarize(records) {
  let added = 0n;
  let deleted = 0n;
  const binaries = [];
  for (const record of records) {
    if (record.binary) binaries.push(record.path);
    else {
      added += record.added;
      deleted += record.deleted;
    }
  }
  return { added, deleted, total: added + deleted, binaries };
}

function formatSummary(label, summary) {
  return `${label}: additions=${summary.added} deletions=${summary.deleted} total=${summary.total}`;
}

function checkSummary(label, summary, failures) {
  if (summary.binaries.length > 0) {
    for (const path of summary.binaries) {
      failures.push(
        `${label}: binary path ${JSON.stringify(path)} has unknown line bytes; review required`,
      );
    }
  }
  if (summary.total > MAX_LINES) {
    failures.push(`${formatSummary(label, summary)} exceeds limit ${MAX_LINES}`);
  }
}

function printResult(lines, failures) {
  for (const line of lines) console.log(line);
  if (failures.length > 0) {
    console.error('commit-size: FAILED');
    for (const failure of failures) console.error(`- ${failure}`);
    return 1;
  }
  console.log(`commit-size: OK (per-commit limit ${MAX_LINES})`);
  return 0;
}

function parseArgs(argv) {
  const options = { mode: null, root: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      options.root = true;
      continue;
    }
    if (arg === '--staged') {
      if (options.mode) throw new Error('choose exactly one mode');
      options.mode = { kind: 'staged' };
      continue;
    }
    if (arg === '--commit') {
      if (options.mode) throw new Error('choose exactly one mode');
      const ref = argv[++index];
      if (!ref || ref.startsWith('--')) throw new Error('--commit requires SHA');
      options.mode = { kind: 'commit', ref };
      continue;
    }
    if (arg === '--range') {
      if (options.mode) throw new Error('choose exactly one mode');
      const base = argv[++index];
      const head = argv[++index];
      if (!base || !head || base.startsWith('--') || head.startsWith('--')) {
        throw new Error('--range requires BASE and HEAD');
      }
      options.mode = { kind: 'range', base, head };
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.help && !options.mode) throw new Error('one mode is required');
  if (options.root && options.mode?.kind === 'staged') {
    throw new Error('--root is valid only with --commit or --range');
  }
  if (options.help && options.mode) throw new Error('--help cannot be combined with a mode');
  return options;
}

function help() {
  console.log(`Usage:
  node scripts/check-commit-size.mjs --staged
  node scripts/check-commit-size.mjs --commit SHA [--root]
  node scripts/check-commit-size.mjs --range BASE HEAD [--root]

Checks every changed path, including docs, lockfiles, and generated files.
The 2,000-line limit is applied independently to each commit in a range;
additions and deletions are summed within that commit. Binary numstat records
have no line count and fail closed with a path requiring review. --root permits
a root commit to be compared with the empty tree; it may also be used when a
range includes a root commit. History modes reject shallow repositories.`);
}

function inspectCommit(commit, cwd, allowRoot) {
  const parents = parentsOf(commit, cwd);
  if (parents.length === 0 && !allowRoot) {
    throw new Error(
      `root commit ${commit} has no parent; pass --root to compare with the empty tree`,
    );
  }
  return {
    commit,
    summary: summarize(diffFor(parents[0] ?? EMPTY_TREE, commit, cwd)),
  };
}

function inspectRange(baseRef, headRef, cwd, allowRoot) {
  const head = resolveCommit(headRef, cwd);
  let base;
  let commits;
  if (allowRoot && baseRef === EMPTY_TREE) {
    base = EMPTY_TREE;
    commits = git(['rev-list', '--reverse', '--topo-order', head], cwd)
      .stdout.trim()
      .split(/\s+/)
      .filter(Boolean);
  } else {
    base = resolveCommit(baseRef, cwd);
    const ancestor = git(['merge-base', '--is-ancestor', base, head], cwd, { allowFailure: true });
    if (ancestor.status !== 0) throw new Error(`range base is not an ancestor of head: ${baseRef}`);
    commits = git(['rev-list', '--reverse', '--topo-order', `${base}..${head}`], cwd)
      .stdout.trim()
      .split(/\s+/)
      .filter(Boolean);
  }
  return { base, head, commits, allowRoot };
}

function run(options) {
  if (options.help) {
    help();
    return 0;
  }
  const cwd = repositoryRoot();
  if (options.mode.kind === 'staged') {
    const summary = summarize(stagedDiff(cwd));
    const failures = [];
    checkSummary('staged', summary, failures);
    return printResult([formatSummary('staged', summary)], failures);
  }

  ensureCompleteHistory(cwd);
  const lines = [];
  const failures = [];
  if (options.mode.kind === 'commit') {
    const commit = resolveCommit(options.mode.ref, cwd);
    const inspected = inspectCommit(commit, cwd, options.root);
    lines.push(formatSummary(`commit ${commit}`, inspected.summary));
    checkSummary(`commit ${commit}`, inspected.summary, failures);
    return printResult(lines, failures);
  }

  const range = inspectRange(options.mode.base, options.mode.head, cwd, options.root);
  for (const commit of range.commits) {
    try {
      const inspected = inspectCommit(commit, cwd, range.allowRoot);
      lines.push(formatSummary(`commit ${commit}`, inspected.summary));
      checkSummary(`commit ${commit}`, inspected.summary, failures);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (range.commits.length === 0)
    lines.push(`range ${range.base}..${range.head}: 0 commits; valid`);
  return printResult(lines, failures);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`commit-size: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
