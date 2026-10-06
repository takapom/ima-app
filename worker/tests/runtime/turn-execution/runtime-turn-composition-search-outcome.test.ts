import type { AssistantResponse } from '@ima/contracts';
import { describe, expect, it } from 'vitest';
import type { CommitRecord } from '@worker/application/ports/commit';
import {
  NOW,
  RecordingCommit,
  createComposition,
  respondWith,
  retention,
  type CompositionPart,
} from './runtime-turn-composition-fixture';

class ConversationCommit extends RecordingCommit {
  readonly durable: AssistantResponse[] = [];

  setCardSetId(): void {}

  clearCardSetId(): void {}

  setConversationResponse(_record: CommitRecord, response: AssistantResponse): void {
    this.durable.push(response);
  }
}

const emptySearch = {
  status: 'ok',
  data: {
    searchId: 'search-empty',
    candidates: [],
    applied: { areaDescription: '渋谷', excludedCount: 0 },
    nextCursor: null,
    coverage: 'provider_results',
  },
  warnings: [],
};

const failedSearch = {
  status: 'error',
  error: { code: 'PROVIDER_UNAVAILABLE', field: null, message: 'search failed' },
};

type Composition = ReturnType<typeof createComposition>['composition'];

/** Streams a search result the way AI SDK does: the tool's own return value as the output. */
const streamSearchResult = async (composition: Composition, output: unknown): Promise<void> => {
  const transform = composition.retention.transform;
  if (Array.isArray(transform)) throw new Error('composition transform must be a single stream');
  const source = new ReadableStream<CompositionPart>({
    start(controller) {
      controller.enqueue({
        type: 'tool-call',
        toolCallId: 'search-call',
        toolName: 'search_places',
        input: {},
        dynamic: true,
      });
      controller.enqueue({
        type: 'tool-result',
        toolCallId: 'search-call',
        toolName: 'search_places',
        input: {},
        output,
        dynamic: true,
      });
      controller.close();
    },
  });
  const reader = source
    .pipeThrough(transform({ tools: {}, stopStream: () => undefined }))
    .getReader();
  while (!(await reader.read()).done);
};

const compose = (commit: ConversationCommit) =>
  createComposition(
    commit,
    1,
    retention,
    () => NOW,
    { digest: () => 'composition-digest' },
    { textRetention: retention.retention },
  ).composition;

describe('search outcome through a turn', () => {
  it('marks the live and the durable answer when the turn searched and found nothing', async () => {
    const commit = new ConversationCommit();
    const composition = compose(commit);
    await streamSearchResult(composition, emptySearch);
    await respondWith(composition, { kind: 'answer', message: '近くで見つかりませんでした' });

    expect(await composition.getCommittedResponse()).toMatchObject({
      kind: 'message',
      searchOutcome: 'no_candidates',
    });
    expect(commit.durable).toHaveLength(1);
    expect(commit.durable[0]).toMatchObject({ kind: 'message', searchOutcome: 'no_candidates' });
    composition.dispose();
  });

  it('leaves it out when the turn did not search', async () => {
    const commit = new ConversationCommit();
    const composition = compose(commit);
    await respondWith(composition, { kind: 'ask', message: 'どのあたりで探しますか？' });

    expect(await composition.getCommittedResponse()).not.toHaveProperty('searchOutcome');
    expect(commit.durable[0]).not.toHaveProperty('searchOutcome');
    composition.dispose();
  });

  it('leaves it out when the search failed instead of reporting nothing found', async () => {
    const commit = new ConversationCommit();
    const composition = compose(commit);
    await streamSearchResult(composition, failedSearch);
    await respondWith(composition, { kind: 'answer', message: '検索できませんでした' });

    expect(await composition.getCommittedResponse()).not.toHaveProperty('searchOutcome');
    expect(commit.durable[0]).not.toHaveProperty('searchOutcome');
    composition.dispose();
  });
});
