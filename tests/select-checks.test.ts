import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const selector = resolve('scripts/select-checks.mjs');

const allGates = [
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

function select(files: string[]) {
  const result = spawnSync(process.execPath, [selector, '--list', ...files], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  return result.stdout.split('\n').filter(Boolean);
}

describe('quality gate selection', () => {
  it('selects only format and docs for document changes', () => {
    expect(select(['docs/architecture.md', 'AGENTS.md'])).toEqual(['format', 'docs']);
  });

  it('skips the worker pools for mobile-only changes', () => {
    const selected = select(['apps/mobile/src/journey/components/candidates/card.tsx']);
    expect(selected).toContain('test:unit');
    expect(selected).not.toContain('test:runtime');
    expect(selected).not.toContain('test:worker-http');
    expect(selected).not.toContain('test:app-integrity');
  });

  it('runs the worker pools for shared contracts and both backend workspaces', () => {
    for (const file of [
      'packages/contracts/src/turn.ts',
      'worker/src/domain/places/place.ts',
      'worker/src/entrypoints/cloudflare/worker.ts',
    ]) {
      expect(select([file])).toEqual(allGates.filter((gate) => gate !== 'docs'));
    }
  });

  it('selects every gate for an unrecognised or shared root path', () => {
    for (const file of ['package.json', 'tsconfig.base.json', 'eslint.config.mjs', 'bun.lock']) {
      expect(select([file])).toEqual(allGates);
    }
  });

  it('unions the gates of every changed path', () => {
    expect(select(['docs/product.md', 'apps/mobile/src/app.tsx'])).toEqual([
      'format',
      'docs',
      'lint',
      'architecture',
      'typecheck',
      'test:unit',
    ]);
  });

  it('runs every gate when --all overrides the changed paths', () => {
    const result = spawnSync(process.execPath, [selector, '--list', '--all', 'docs/product.md'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.split('\n').filter(Boolean)).toEqual(allGates);
  });
});
