import { describe, expect, it } from 'vitest';
import { invokePublicToolEnvelope } from '@worker/adapters/in/tools';
import {
  createFactory,
  emptyPortCalls,
  submitInput,
} from '../../support/runtime-turn-factory-fixture';
import { createComposition, captureToolResult } from './runtime-turn-composition-fixture';

describe('submit entry validation', () => {
  it.each([false, true])(
    'only accepts a final message after a failed read is repaired: %s',
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
      const accept = () =>
        composition.onAccepted({
          terminal: 'message',
          finalText: JSON.stringify({
            kind: 'final_message',
            message: { text: '条件を変えて探しますか？', basis: 'conversational', evidenceIds: [] },
            metadata: {},
          }),
          emptyFinal: false,
          partCount: 1,
          bytes: 100,
        });
      if (repaired) expect(accept).not.toThrow();
      else expect(accept).toThrow('FINAL_COMMIT_INVALID');
      composition.dispose();
    },
  );
  it('preserves the metadata issue and spends the existing repair budget before a Port call', async () => {
    const calls = emptyPortCalls();
    const { factory } = createFactory(calls, { onSubmitRejected: () => undefined });
    const envelope = {
      input: submitInput,
      metadata: {
        turnConstraints: {
          changes: [{ minimumStayMinutes: 20, sourceTurnId: 'missing-turn', quote: '最低20分' }],
        },
      },
    };
    for (const remainingRepairs of [2, 1, 0]) {
      const result = await invokePublicToolEnvelope(
        'submit_cards',
        envelope,
        factory.dependencies,
        { toolCallId: `invalid-${remainingRepairs}` },
      );
      expect(result).toMatchObject({
        status: 'invalid',
        repairable: remainingRepairs > 0,
        remainingRepairs,
        issues: [
          {
            path: 'metadata.turnConstraints',
          },
        ],
      });
      if (result.status !== 'invalid') throw new Error('invalid metadata was accepted');
      expect(result.issues[0]?.message).toContain('SOURCE_TURN_NOT_FOUND');
    }
    expect(calls.submits).toHaveLength(0);
    expect(factory.hasUnresolvedSubmitFailure()).toBe(true);
    const result = await invokePublicToolEnvelope(
      'submit_cards',
      { input: submitInput, metadata: {} },
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
      'submit_cards',
      { input: submitInput, unknown: true },
      factory.dependencies,
      { toolCallId: 'bad-envelope' },
    );
    expect(factory.hasUnresolvedSubmitFailure()).toBe(true);
    const result = await invokePublicToolEnvelope(
      'submit_cards',
      { input: submitInput, metadata: {} },
      factory.dependencies,
      { toolCallId: 'corrected' },
    );
    expect(result.status).toBe('committed');
    expect(factory.hasUnresolvedSubmitFailure()).toBe(false);
    expect(calls.submits).toHaveLength(1);
  });

  it('does not replace an unresolved submit error with a successful conversation response', async () => {
    const { composition } = createComposition();
    await invokePublicToolEnvelope(
      'submit_cards',
      { invalid: true },
      composition.turn.dependencies,
      { toolCallId: 'invalid' },
    );
    expect(() =>
      composition.onAccepted({
        terminal: 'message',
        finalText: JSON.stringify({
          kind: 'final_message',
          message: { text: '候補を確認しました。', basis: 'conversational', evidenceIds: [] },
          metadata: {},
        }),
        emptyFinal: false,
        partCount: 1,
        bytes: 100,
      }),
    ).toThrow('FINAL_COMMIT_INVALID');
    expect(await composition.getCommittedResponse()).toBeUndefined();
    composition.dispose();
  });
});
