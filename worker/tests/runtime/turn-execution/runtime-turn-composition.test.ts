import type { TurnContext } from '@cloudflare/think';
import type { ToolExecutionContext } from '@worker/application/ports/context';
import { describe, expect, it } from 'vitest';
import {
  NOW,
  allowRetention,
  context,
  createComposition,
  modelContext,
  retention,
  searchResult,
  RecordingCommit,
} from './runtime-turn-composition-fixture';
import { denyModelContextFieldPolicy } from '@worker/application/model-context/model-context-policy';
import { observedWindow } from '@worker/composition/runtime-turn-composition-support';

describe('createRuntimeTurnComposition', () => {
  it('keeps model input expiry independent from display and persistence windows', () => {
    const { composition, registry } = createComposition(new RecordingCommit(), 1, allowRetention);
    expect(observedWindow({}, allowRetention, registry)).toEqual({
      localFreshUntil: allowRetention.retention.freshUntil,
      localExpiresAt: allowRetention.retention.deletionScheduledAt,
    });
    composition.dispose();
  });

  it('wires the exact tool set through budgeted read ports and retention transform', async () => {
    const { composition, calls, model } = createComposition();
    expect(Object.keys(composition.turn.tools).sort()).toEqual([
      'get_place_details',
      'search_places',
      'submit_cards',
    ]);
    expect(composition.retention.transform).toBeDefined();
    const turnContext: TurnContext = {
      system: '',
      messages: [],
      tools: composition.turn.tools,
      model,
      continuation: false,
    };
    const config = await composition.turn.hooks.beforeTurn(turnContext);
    if (config === undefined) throw new Error('composition hook returned no config');
    expect(config.experimental_transform).toBe(composition.retention.transform);

    const result = await composition.turn.dependencies.search.search(
      {
        mode: 'search',
        query: 'カフェ',
        area: { kind: 'named_area', name: '渋谷' },
        limit: 1,
        excludeCandidateIds: [],
      },
      context,
      {
        callId: 'composition-call',
        operation: 'search_places',
        threadId: context.threadId,
        turnId: context.turnId,
        revision: context.revision,
      } satisfies ToolExecutionContext,
      { isCancelled: () => false },
    );
    expect(result).toEqual(searchResult);
    expect(calls.search).toHaveLength(1);
    composition.dispose();
  });

  it('encodes only Core-projected context and withholds raw SDK history', async () => {
    const { composition, model } = createComposition();
    const projected = await composition.projectStep(
      {
        steps: [],
        stepNumber: 0,
        model,
        messages: [
          { role: 'user', content: 'SDK_RAW_CANARY secret-coordinate' },
          { role: 'assistant', content: 'old provider text' },
        ],
        experimental_context: undefined,
      },
      NOW,
    );
    const serialized = JSON.stringify(projected.messages);
    expect(serialized).toContain('ORIGINAL_USER_CANARY');
    expect(serialized).toContain('[withheld]');
    expect(serialized).not.toContain('SDK_RAW_CANARY');
    expect(serialized).not.toContain('secret-coordinate');
    expect(projected.experimental_context).toMatchObject({ userText: 'ORIGINAL_USER_CANARY' });
    composition.dispose();
  });

  it('awaits the Core commit started by the accepted final message', async () => {
    const commit = new RecordingCommit();
    const { composition } = createComposition(commit);
    composition.onAccepted({
      terminal: 'message',
      finalText: JSON.stringify({
        kind: 'final_message',
        message: '確認しました',
      }),
      emptyFinal: false,
      partCount: 3,
      bytes: 100,
    });
    const response = await composition.getCommittedResponse();
    expect(response).toMatchObject({
      presentation: 'keep',
      message: '確認しました',
    });
    expect(commit.requests).toHaveLength(1);
    expect(commit.requests[0]?.record.presentation).toBe('keep');
    composition.dispose();
  });

  it.each([
    ['text that is not the envelope', '確認しました', false],
    ['a truncated envelope', '{"kind":"final_message"', false],
    ['an empty terminal', '', true],
  ] as const)(
    'degrades %s to no commit instead of failing the turn',
    async (_name, finalText, emptyFinal) => {
      const commit = new RecordingCommit();
      const { composition } = createComposition(commit);

      expect(() =>
        composition.onAccepted({
          terminal: 'message',
          finalText,
          emptyFinal,
          partCount: 1,
          bytes: 32,
        }),
      ).not.toThrow();

      await expect(composition.getCommittedResponse()).resolves.toBeUndefined();
      expect(commit.requests).toHaveLength(0);
      composition.dispose();
    },
  );

  it('maps the committed response with the receipt identity when public dependencies are injected', async () => {
    const commit = new RecordingCommit('receipt-public-response');
    const { composition } = createComposition(
      commit,
      1,
      retention,
      () => NOW,
      { digest: () => 'composition-digest' },
      { textRetention: retention.retention },
    );
    composition.onAccepted({
      terminal: 'message',
      finalText: JSON.stringify({
        kind: 'final_message',
        message: '公開応答',
      }),
      emptyFinal: false,
      partCount: 2,
      bytes: 64,
    });
    const response = await composition.getCommittedResponse();
    expect(response).toMatchObject({
      kind: 'message',
      presentation: 'keep',
      responseId: 'receipt-public-response',
      revision: 2,
      cardSetId: null,
      message: [{ text: '公開応答' }],
    });
    composition.dispose();
  });

  it('bounds generated text by the quoted history the model was shown', async () => {
    const quoted = {
      ...allowRetention.retention,
      displayUntil: '2026-09-10T00:01:10Z',
      retentionUntil: '2026-09-10T00:01:20Z',
      deletionScheduledAt: '2026-09-10T00:01:20Z',
      freshUntil: '2026-09-10T00:00:30Z',
    };
    const run = async (history: readonly { text: string }[]) => {
      const { composition, model } = createComposition(
        new RecordingCommit(),
        1,
        allowRetention,
        () => NOW,
        { digest: () => 'composition-digest' },
        { textRetention: allowRetention.retention },
        {
          historyRetention: [quoted],
          modelContext: {
            ...modelContext,
            history: history.map(({ text }) => ({
              threadId: context.threadId,
              turnId: 'turn-earlier',
              role: 'assistant' as const,
              text,
            })),
            fieldPolicy: { ...denyModelContextFieldPolicy, history: 'allow' },
          },
        },
      );
      await composition.projectStep(
        { steps: [], stepNumber: 0, model, messages: [], experimental_context: undefined },
        NOW,
      );
      composition.onAccepted({
        terminal: 'message',
        finalText: JSON.stringify({
          kind: 'final_message',
          message: '前の回答を踏まえました',
        }),
        emptyFinal: false,
        partCount: 2,
        bytes: 64,
      });
      const response = await composition.getCommittedResponse();
      composition.dispose();
      return response !== undefined && 'responseId' in response
        ? response.message[0]?.retention
        : undefined;
    };
    expect(await run([{ text: '以前の回答' }])).toMatchObject({
      retentionDecision: 'allow',
      displayUntil: quoted.displayUntil,
      retentionUntil: quoted.retentionUntil,
      // Freshness belonged to the quoted turn; the new text keeps its own.
      freshUntil: allowRetention.retention.freshUntil,
    });
    // History that was not shown does not bound the text.
    expect(await run([])).toMatchObject({ displayUntil: allowRetention.retention.displayUntil });
  });

  it('does not restore a photo resolver after disposal during asynchronous preparation', async () => {
    let entered!: () => void;
    let release!: () => void;
    const preparationEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const preparation = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { composition } = createComposition(
      new RecordingCommit(),
      1,
      retention,
      () => NOW,
      { digest: () => 'composition-digest' },
      {
        textRetention: retention.retention,
        preparePhotoTokens: async () => {
          entered();
          await preparation;
          return () => 'late-photo-token';
        },
      },
    );
    composition.onAccepted({
      terminal: 'message',
      finalText: JSON.stringify({
        kind: 'final_message',
        message: '遅延写真',
      }),
      emptyFinal: false,
      partCount: 2,
      bytes: 64,
    });
    const pending = composition.getCommittedResponse();
    await preparationEntered;
    composition.dispose();
    release();
    await expect(pending).resolves.toBeUndefined();
  });
});
