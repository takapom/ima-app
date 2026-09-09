import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { parseSearchResponse, type SearchResponse } from '../packages/contracts/src';
import { applySearchResponseJson } from '../apps/mobile/src/services/assistant-response';
import { createAssistantResponseState } from '../apps/mobile/src/state/assistant-response';

const threadId = 'thread-http-mobile';

async function runHttp(
  scenario: string,
  id: string,
  parameters: Record<string, string> = {},
): Promise<{ response: Response; body: unknown }> {
  const query = new URLSearchParams({
    case: scenario,
    id,
    threadId,
    turnId: 'turn-http-mobile',
    revision: '1',
    ...parameters,
  });
  const response = await SELF.fetch(`https://ima.test/v1/runtime-gate/http?${query}`);
  const body: unknown = await response.json();
  return { response, body };
}

function searchResponse(value: unknown): SearchResponse {
  const parsed = parseSearchResponse(value);
  if (!parsed.success) throw new Error(parsed.issues.join('; '));
  return parsed.data;
}

it('routes SDK cards through Worker HTTP and mobile state for one, two, and three cards', async () => {
  for (const [scenario, cardCount] of [
    ['cards-1', 1],
    ['cards-2', 2],
    ['cards-3', 3],
  ] as const) {
    const http = await runHttp(scenario, `cards-${cardCount}`);
    expect(http.response.status).toBe(200);
    const body = searchResponse(http.body);
    expect(body.response.kind).toBe('cards');
    if (body.response.kind !== 'cards') throw new Error('expected cards response');
    expect(body.response.cards.alts).toHaveLength(cardCount - 1);
    expect(body.response.schemaVersion).toBe('v1');
    expect(body.response.revision).toBe(1);
    expect(body.response.cards.hero.facts.identity.status).toBe('known');
    if (body.response.cards.hero.facts.identity.status !== 'known') {
      throw new Error('expected identity evidence');
    }
    expect(body.response.cards.hero.facts.identity.evidence[0]?.evidenceId).toBe('obs-identity-1');
    expect(body.response.cards.hero.facts.identity.evidence[0]?.evidenceId).not.toBe(
      'obs-opening-hours-1',
    );
    const cards = [body.response.cards.hero, ...body.response.cards.alts];
    expect(cards.map((card) => card.candidateId)).toEqual(
      Array.from({ length: cardCount }, (_, index) => `candidate-${index + 1}`),
    );
    cards.forEach((card) => {
      if (card.facts.identity.status !== 'known') throw new Error('expected identity evidence');
      expect(card.facts.identity.value.name).toBe(`Fixture ${card.candidateId}`);
      expect(card.facts.identity.evidence).toHaveLength(1);
      expect(card.facts.identity.evidence[0]?.evidenceId).toBe(
        `obs-identity-${card.candidateId.slice(-1)}`,
      );
    });

    const applied = applySearchResponseJson(createAssistantResponseState(threadId), body);
    expect(applied.accepted).toBe(true);
    expect(applied.state.cards?.alts).toHaveLength(cardCount - 1);
    expect(applied.state.revision).toBe(1);
  }
});

it('routes an accepted SDK final message without manufacturing cards', async () => {
  const http = await runHttp('message', 'message-only');
  expect(http.response.status).toBe(200);
  const body = searchResponse(http.body);
  expect(body.response.kind).toBe('message');
  if (body.response.kind !== 'message') throw new Error('expected message response');
  expect(body.response.cardSetId).toBeNull();
  expect(body.response.message[0]?.evidenceIds).toEqual(['obs-identity-1']);

  const applied = applySearchResponseJson(createAssistantResponseState(threadId), body);
  expect(applied.accepted).toBe(true);
  expect(applied.state.cards).toBeNull();
  expect(applied.state.messages).toHaveLength(1);
});

it('keeps cards when the SDK submits before an empty final step', async () => {
  const http = await runHttp('empty-final', 'empty-final');
  expect(http.response.status).toBe(200);
  const body = searchResponse(http.body);
  expect(body.response.kind).toBe('cards');
  if (body.response.kind !== 'cards') throw new Error('expected cards response');
  expect(body.response.cards.alts).toHaveLength(0);
  expect(applySearchResponseJson(createAssistantResponseState(threadId), body).accepted).toBe(true);
});

it('rejects old schema, stale revision, and replayed response in mobile state', async () => {
  const http = await runHttp('cards-1', 'mobile-replay');
  expect(http.response.status).toBe(200);
  const first = searchResponse(http.body);
  const state = createAssistantResponseState(threadId);
  const newer = {
    ...first,
    response: { ...first.response, responseId: 'newer-http-response', revision: 2 },
  } satisfies SearchResponse;
  const applied = applySearchResponseJson(state, newer);
  expect(applied.accepted).toBe(true);

  const stale = {
    ...first,
    response: { ...first.response, responseId: 'old-http-response', revision: 1 },
  } satisfies SearchResponse;
  const staleResult = applySearchResponseJson(applied.state, stale);
  expect(staleResult.accepted).toBe(true);
  expect(staleResult.state).toBe(applied.state);

  const replayResult = applySearchResponseJson(applied.state, newer);
  expect(replayResult.state).toBe(applied.state);

  const wrongSchema: unknown = {
    ...newer,
    response: { ...newer.response, schemaVersion: 'v0' },
  };
  const rejected = applySearchResponseJson(applied.state, wrongSchema);
  expect(rejected.accepted).toBe(false);
  expect(rejected.state).toBe(applied.state);
});
