import type { TurnContext } from '@cloudflare/think';
import type { ToolExecutionContext } from '@ima/core';
import { describe, expect, it } from 'vitest';
import {
  NOW,
  context,
  createComposition,
  searchResult,
  RecordingCommit,
} from './runtime-turn-composition-fixture';

describe('createRuntimeTurnComposition', () => {
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
        openNow: true,
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
        message: { text: '確認しました', evidenceIds: [], basis: 'conversational' },
      }),
      emptyFinal: false,
      partCount: 3,
      bytes: 100,
    });
    const response = await composition.getCommittedResponse();
    expect(response).toMatchObject({
      presentation: 'keep',
      message: { text: '確認しました', evidenceIds: [] },
    });
    expect(commit.requests).toHaveLength(1);
    expect(commit.requests[0]?.record.presentation).toBe('keep');
    composition.dispose();
  });
});
