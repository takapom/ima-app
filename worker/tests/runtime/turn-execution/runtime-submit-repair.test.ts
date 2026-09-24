import { describe, expect, it } from 'vitest';
import { invokePublicToolEnvelope } from '@worker/adapters/in/tools';
import {
  createFactory,
  emptyPortCalls,
  submitInput,
} from '../../support/runtime-turn-factory-fixture';
import {
  createComposition,
  captureToolResult,
  respondWith,
} from './runtime-turn-composition-fixture';

describe('submit entry validation', () => {
  it.each([false, true])(
    'only accepts an answer after a failed read is repaired: %s',
    async (repaired) => {
      const { composition } = createComposition();
      await captureToolResult(composition, {
        status: 'error',
        error: { code: 'UPSTREAM_UNAVAILABLE' },
      });
      if (repaired)
        await captureToolResult(composition, {
          status: 'ok',
          data: { candidates: [] },
          warnings: [],
        });
      const result = await respondWith(composition, {
        kind: 'ask',
        message: '条件を変えて探しますか？',
      });
      if (repaired) expect(result).toMatchObject({ status: 'committed', kind: 'ask' });
      else {
        expect(result).toMatchObject({
          status: 'invalid',
          repairable: false,
          issues: [{ code: 'CONSTRAINT_VIOLATION', path: 'kind' }],
        });
        await expect(composition.getCommittedResponse()).resolves.toBeUndefined();
      }
      composition.dispose();
    },
  );
  it('rejects the removed metadata field and spends the existing repair budget before a Port call', async () => {
    const calls = emptyPortCalls();
    const { factory } = createFactory(calls, { onSubmitRejected: () => undefined });
    const envelope = { input: submitInput, metadata: {} };
    for (const remainingRepairs of [2, 1, 0]) {
      const result = await invokePublicToolEnvelope('respond', envelope, factory.dependencies, {
        toolCallId: `invalid-${remainingRepairs}`,
      });
      expect(result).toMatchObject({
        status: 'invalid',
        repairable: remainingRepairs > 0,
        remainingRepairs,
        issues: [{ code: 'INVALID_ARGUMENT' }],
      });
      if (result.status !== 'invalid') throw new Error('invalid metadata was accepted');
      expect(result.issues[0]?.message).toContain('envelope is invalid');
    }
    expect(calls.submits).toHaveLength(0);
    expect(factory.hasUnresolvedSubmitFailure()).toBe(true);
    const result = await invokePublicToolEnvelope(
      'respond',
      { input: submitInput },
      factory.dependencies,
      { toolCallId: 'too-late' },
    );
    expect(result).toMatchObject({
      status: 'invalid',
      repairable: false,
      issues: [{ code: 'BUDGET_EXCEEDED' }],
    });
    expect(calls.submits).toHaveLength(0);
  });

  it('allows corrected arguments to commit once after an invalid envelope', async () => {
    const calls = emptyPortCalls();
    const { factory } = createFactory(calls, { onSubmitRejected: () => undefined });
    await invokePublicToolEnvelope(
      'respond',
      { input: submitInput, unknown: true },
      factory.dependencies,
      { toolCallId: 'bad-envelope' },
    );
    expect(factory.hasUnresolvedSubmitFailure()).toBe(true);
    const result = await invokePublicToolEnvelope(
      'respond',
      { input: submitInput },
      factory.dependencies,
      { toolCallId: 'corrected' },
    );
    expect(result.status).toBe('committed');
    expect(factory.hasUnresolvedSubmitFailure()).toBe(false);
    expect(calls.submits).toHaveLength(1);
  });

  it('does not replace an unresolved submit error with a successful conversation response', async () => {
    const { composition } = createComposition();
    await invokePublicToolEnvelope('respond', { invalid: true }, composition.turn.dependencies, {
      toolCallId: 'invalid',
    });
    await expect(
      respondWith(composition, { kind: 'answer', message: '候補を確認しました。' }, 'answer'),
    ).resolves.toMatchObject({ status: 'invalid', repairable: false });
    expect(await composition.getCommittedResponse()).toBeUndefined();
    composition.dispose();
  });
});
