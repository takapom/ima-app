import { env } from 'cloudflare:workers';
import { evictDurableObject, SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';
import {
  parseSearchResponse,
  parseThreadSnapshot,
  type SearchResponse,
} from '../packages/contracts/src';
import { applySearchResponseJson } from '../apps/mobile/src/services/assistant-response';
import { createAssistantResponseState } from '../apps/mobile/src/state/assistant-response';
import type { ThinkRuntimeGateAgent } from '../workers/api/tests/think-runtime/think-runtime-agent';

const threadId = 'thread-think-http-mobile';
type JsonObject = Record<string, unknown>;
type ThinkRuntimeTestEnv = Cloudflare.Env & {
  THINK_RUNTIME: DurableObjectNamespace<ThinkRuntimeGateAgent>;
};

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasThinkRuntime(value: unknown): value is ThinkRuntimeTestEnv {
  return isJsonObject(value) && 'THINK_RUNTIME' in value;
}

function objectValue(value: unknown, key: string): JsonObject {
  if (!isJsonObject(value) || !isJsonObject(value[key])) {
    throw new Error(`missing object field: ${key}`);
  }
  return value[key];
}

function numberValue(value: unknown, key: string): number {
  if (!isJsonObject(value) || typeof value[key] !== 'number') {
    throw new Error(`missing number field: ${key}`);
  }
  return value[key];
}

function booleanValue(value: unknown, key: string): boolean {
  if (!isJsonObject(value) || typeof value[key] !== 'boolean') {
    throw new Error(`missing boolean field: ${key}`);
  }
  return value[key];
}

function textOf(value: unknown): string {
  return JSON.stringify(value);
}

async function requestThinkHttp(
  path: '/http' | '/replay',
  scenario: string,
  id: string,
  parameters: Record<string, string> = {},
): Promise<{ response: Response; body: unknown }> {
  const query = new URLSearchParams({
    case: scenario,
    id,
    threadId,
    turnId: 'turn-think-http-mobile',
    revision: '1',
    idempotencyKey: `key-${id}`,
    content: 'same payload',
    ...parameters,
  });
  const response = await SELF.fetch(`https://ima.test/v1/think-runtime${path}?${query}`);
  return { response, body: await response.json() };
}

async function requestThinkRawReplay(
  id: string,
  parameters: Record<string, string>,
): Promise<{ response: Response; body: unknown }> {
  if (!hasThinkRuntime(env)) throw new Error('THINK_RUNTIME_BINDING_MISSING');
  const query = new URLSearchParams(parameters);
  const response = await env.THINK_RUNTIME.getByName(id).fetch(`https://ima.test/replay?${query}`);
  return { response, body: await response.json() };
}

function searchResponse(value: unknown): SearchResponse {
  const parsed = parseSearchResponse(value);
  if (!parsed.success) throw new Error(parsed.issues.join('; '));
  return parsed.data;
}

it('routes Think cards through the same public DTO and mobile state for one, two, and three cards', async () => {
  for (const [scenario, count] of [
    ['cards-1', 1],
    ['cards-2', 2],
    ['cards-3', 3],
  ] as const) {
    const result = await requestThinkHttp('/http', scenario, `think-cards-${count}`);
    expect(result.response.status).toBe(200);
    const body = searchResponse(result.body);
    expect(body.response.kind).toBe('cards');
    if (body.response.kind !== 'cards') throw new Error('expected cards response');
    const cards = [body.response.cards.hero, ...body.response.cards.alts];
    expect(cards).toHaveLength(count);
    expect(cards.map((card) => card.candidateId)).toEqual(
      Array.from({ length: count }, (_, index) => `candidate-${index + 1}`),
    );
    expect(body.response.cards.hero.facts.identity).toMatchObject({
      status: 'known',
      evidence: [{ evidenceId: 'obs-identity-1' }],
    });
    expect(body.response.cards.hero.facts.identity).not.toMatchObject({
      evidence: [{ evidenceId: 'obs-opening-hours-1' }],
    });
    expect(applySearchResponseJson(createAssistantResponseState(threadId), body).accepted).toBe(
      true,
    );
  }
});

it('keeps Think message and submitted cards across an empty final, then rejects replay regressions in mobile state', async () => {
  const message = await requestThinkHttp('/http', 'message', 'think-message');
  expect(message.response.status).toBe(200);
  const messageBody = searchResponse(message.body);
  expect(messageBody.response.kind).toBe('message');
  if (messageBody.response.kind !== 'message') throw new Error('expected message response');
  expect(messageBody.response.cardSetId).toBeNull();
  expect(
    applySearchResponseJson(createAssistantResponseState(threadId), messageBody).accepted,
  ).toBe(true);

  const empty = await requestThinkHttp('/http', 'empty-final', 'think-empty');
  expect(empty.response.status).toBe(200);
  const emptyBody = searchResponse(empty.body);
  expect(emptyBody.response.kind).toBe('cards');
  if (emptyBody.response.kind !== 'cards') throw new Error('expected cards response');
  expect(emptyBody.response.cards.alts).toHaveLength(0);

  const replayId = 'think-replay';
  const first = await requestThinkHttp('/http', 'cards-1', replayId, { revision: '2' });
  expect(first.response.status).toBe(200);
  const firstBody = searchResponse(first.body);
  const state = applySearchResponseJson(createAssistantResponseState(threadId), firstBody);
  expect(state.accepted).toBe(true);
  const replayState = applySearchResponseJson(state.state, firstBody);
  expect(replayState.state).toBe(state.state);

  const replay = await requestThinkHttp('/replay', 'cards-1', replayId, { revision: '2' });
  expect(replay.response.status).toBe(200);
  const snapshot = parseThreadSnapshot(replay.body);
  if (!snapshot.success) throw new Error(snapshot.issues.join('; '));
  expect(snapshot.data.revision).toBe(2);
  const reference = snapshot.data.responses[0];
  if (reference === undefined) throw new Error('expected replay reference');
  expect(reference.responseId).toBe(firstBody.response.responseId);
  expect(reference.revision).toBe(firstBody.response.revision);
  expect(reference.restoreMode).toBe('reference_only');
  expect('message' in reference).toBe(false);
  expect('cards' in reference).toBe(false);

  const stale = await requestThinkHttp('/replay', 'cards-1', replayId, { revision: '1' });
  expect(stale.response.status).toBe(422);
});

it('replays only reference metadata through Think HTTP before and after DO eviction', async () => {
  const id = `think-replay-http-${crypto.randomUUID()}`;
  const content = `provider quote ${crypto.randomUUID()}`;
  const parameters = {
    id,
    turnId: 'turn-think-replay-http',
    revision: '2',
    idempotencyKey: 'key-think-replay-http',
    content,
  };
  const first = await requestThinkHttp('/http', 'cards-1', id, parameters);
  expect(first.response.status).toBe(200);
  const firstBody = searchResponse(first.body);
  const firstResponseId = firstBody.response.responseId;

  const warmRaw = await requestThinkRawReplay(id, parameters);
  expect(warmRaw.response.status).toBe(200);
  expect(numberValue(objectValue(warmRaw.body, 'model'), 'calls')).toBe(0);
  expect(booleanValue(warmRaw.body, 'nativeSdkStarted')).toBe(false);
  expect(objectValue(warmRaw.body, 'replay')).toMatchObject({
    outcome: 'replayed',
    sameCommit: true,
  });
  expect(textOf(warmRaw.body)).not.toContain(content);

  const warm = await requestThinkHttp('/replay', 'cards-1', id, parameters);
  expect(warm.response.status).toBe(200);
  const warmSnapshot = parseThreadSnapshot(warm.body);
  expect(warmSnapshot.success).toBe(true);
  if (!warmSnapshot.success) throw new Error('expected replay snapshot');
  expect(warmSnapshot.data.responses).toHaveLength(1);
  const warmRecord = warmSnapshot.data.responses[0];
  if (warmRecord === undefined) throw new Error('expected replay reference');
  expect(warmRecord).toMatchObject({
    turnId: parameters.turnId,
    responseId: firstResponseId,
    revision: 2,
    kind: 'cards',
    presentation: 'replace',
    cardSetId: `cards-${firstResponseId}`,
    restoreMode: 'reference_only',
  });
  expect('message' in warmRecord).toBe(false);
  expect('cards' in warmRecord).toBe(false);
  expect(textOf(warm.body)).not.toContain(content);

  const conflictContent = `${content}-different`;
  const conflict = await requestThinkHttp('/replay', 'cards-1', id, {
    ...parameters,
    content: conflictContent,
  });
  expect(conflict.response.status).toBe(422);
  expect(textOf(conflict.body)).not.toContain(conflictContent);

  if (!hasThinkRuntime(env)) throw new Error('THINK_RUNTIME_BINDING_MISSING');
  await evictDurableObject(env.THINK_RUNTIME.getByName(id));

  const coldRaw = await requestThinkRawReplay(id, parameters);
  expect(coldRaw.response.status).toBe(200);
  expect(numberValue(objectValue(coldRaw.body, 'model'), 'calls')).toBe(0);
  expect(booleanValue(coldRaw.body, 'nativeSdkStarted')).toBe(false);
  expect(textOf(coldRaw.body)).not.toContain(content);

  const cold = await requestThinkHttp('/replay', 'cards-1', id, parameters);
  expect(cold.response.status).toBe(200);
  const coldSnapshot = parseThreadSnapshot(cold.body);
  expect(coldSnapshot.success).toBe(true);
  if (!coldSnapshot.success) throw new Error('expected replay snapshot after eviction');
  expect(coldSnapshot.data.revision).toBe(warmSnapshot.data.revision);
  expect(coldSnapshot.data.responses).toEqual(warmSnapshot.data.responses);
  expect(textOf(cold.body)).not.toContain(content);
});
