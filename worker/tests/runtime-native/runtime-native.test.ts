import * as v from 'valibot';
import { env } from 'cloudflare:test';
import { AssistantResponseSchema } from '@ima/contracts';
import { describe, expect, it } from 'vitest';
import { OPENAI_PROVIDER_REQUEST_OPTIONS } from '@worker/adapters/outbound/providers/openai/provider-options';
import type { ThreadDO } from './runtime-native-worker';
import { RUNTIME_NATIVE_OWNER } from './runtime-native-ports';
import type { RuntimeNativeScenario } from './runtime-native-provider';
import type {
  ThreadRuntimeTarget,
  ThreadRuntimeTurnInput,
} from '@worker/runtime/threads/admission';

type NativeTestEnv = Cloudflare.Env & {
  THREADS: DurableObjectNamespace<ThreadDO>;
};

const hasNativeBinding = (value: typeof env): value is NativeTestEnv =>
  typeof value === 'object' && value !== null && 'THREADS' in value;

const nativeEnv = (): NativeTestEnv => {
  if (!hasNativeBinding(env)) throw new Error('RUNTIME_NATIVE_THREAD_BINDING_MISSING');
  return env;
};

const requestFor = (
  target: ThreadRuntimeTarget,
  scenario: RuntimeNativeScenario = 'invalid-submit-details-valid',
): ThreadRuntimeTurnInput => ({
  ...target,
  idempotencyKey: `native-${target.turnId}`,
  input: {
    schemaVersion: 'v1',
    requestId: `request-${target.turnId}`,
    turnId: target.turnId,
    revision: target.revision,
    text: `[runtime-native:${scenario}] fixture turn`,
    clientNow: '2026-09-10T12:00:00Z',
    location: {
      status: 'unavailable',
      lat: null,
      lng: null,
      accuracyMeters: null,
      precise: false,
      capturedAt: null,
    },
    prefs: {
      homeStationRef: null,
      maxWalkMinutes: null,
      minimumStayMinutes: null,
      areaText: 'runtime native fixture',
      budget: 'normal',
    },
    savedPlaceRefs: [],
    excludeCandidateIds: [],
    mode: 'search',
    idempotencyKey: `native-${target.turnId}`,
  },
});

const responseFromResult = (value: unknown): unknown => {
  if (typeof value !== 'object' || value === null || !('response' in value)) return undefined;
  return value.response;
};

const statusFromResult = (value: unknown): string | undefined => {
  if (typeof value !== 'object' || value === null || !('status' in value)) return undefined;
  return typeof value.status === 'string' ? value.status : undefined;
};

describe('native Think runtime fixture', () => {
  it('runs invalid submit, details repair, and valid submit through the production ThreadDO', async () => {
    const threadId = `runtime-native-${crypto.randomUUID()}`;
    const target: ThreadRuntimeTarget = {
      ownerScopeRef: RUNTIME_NATIVE_OWNER,
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    const stub = nativeEnv().THREADS.getByName(threadId);

    await expect(stub.initialize(target.ownerScopeRef, target.threadId)).resolves.toMatchObject({
      ok: true,
    });
    const result: unknown = await Promise.resolve(stub.runRuntimeTurn(requestFor(target)));
    expect(statusFromResult(result)).toBe('completed');
    const parsed = v.safeParse(AssistantResponseSchema, responseFromResult(result));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.output.kind).toBe('cards');
    expect(parsed.output.threadId).toBe(threadId);
    expect(parsed.output.turnId).toBe(target.turnId);
    expect(parsed.output.revision).toBe(2);
    expect(JSON.stringify(parsed.output)).not.toContain('runtime-native-candidate-1');

    const report = await stub.getRuntimeNativeReport();
    expect(report).not.toBeNull();
    if (report === null) return;
    expect(report.scenario).toBe('invalid-submit-details-valid');
    expect(report.model.calls).toBe(3);
    expect(report.model.requests).toHaveLength(3);
    expect(report.model.providerOptionsSeen).toEqual([
      OPENAI_PROVIDER_REQUEST_OPTIONS,
      OPENAI_PROVIDER_REQUEST_OPTIONS,
      OPENAI_PROVIDER_REQUEST_OPTIONS,
    ]);
    expect(report.model.requests.map((request) => request.toolNames)).toEqual([
      ['get_place_details', 'search_places', 'submit_cards'],
      ['get_place_details', 'search_places', 'submit_cards'],
      ['get_place_details', 'search_places', 'submit_cards'],
    ]);
    expect(report.operations).toEqual(['get_place_details']);
    expect(report.commitWrites).toBe(1);

    await expect(stub.replayRuntimeTurn(target)).resolves.toMatchObject({
      status: 'reference_only',
      response: {
        turnId: target.turnId,
        revision: 2,
        cardSetId: 'runtime-native-card-set',
        restoreMode: 'reference_only',
      },
    });
  });

  it('returns the committed cards when the SDK emits an empty final response', async () => {
    const threadId = `runtime-native-empty-${crypto.randomUUID()}`;
    const target: ThreadRuntimeTarget = {
      ownerScopeRef: RUNTIME_NATIVE_OWNER,
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    const stub = nativeEnv().THREADS.getByName(threadId);

    await expect(stub.initialize(target.ownerScopeRef, target.threadId)).resolves.toMatchObject({
      ok: true,
    });
    const result: unknown = await Promise.resolve(
      stub.runRuntimeTurn(requestFor(target, 'empty-final-after-submit')),
    );
    expect(statusFromResult(result)).toBe('completed');
    const parsed = v.safeParse(AssistantResponseSchema, responseFromResult(result));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.output.kind).toBe('cards');
    expect(parsed.output.revision).toBe(2);

    const report = await stub.getRuntimeNativeReport();
    expect(report).not.toBeNull();
    if (report === null) return;
    expect(report.model.calls).toBe(1);
    expect(report.commitWrites).toBe(1);
  });

  it('rejects a mixed read and submit batch before either Port has a side effect', async () => {
    const threadId = `runtime-native-mixed-${crypto.randomUUID()}`;
    const target: ThreadRuntimeTarget = {
      ownerScopeRef: RUNTIME_NATIVE_OWNER,
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    const stub = nativeEnv().THREADS.getByName(threadId);

    await expect(stub.initialize(target.ownerScopeRef, target.threadId)).resolves.toMatchObject({
      ok: true,
    });
    await expect(stub.runRuntimeTurn(requestFor(target, 'mixed-batch'))).resolves.toMatchObject({
      status: 'failed',
      code: 'RUNTIME_FAILED',
      response: null,
    });
    const report = await stub.getRuntimeNativeReport();
    expect(report).not.toBeNull();
    if (report === null) return;
    expect(report.model.calls).toBe(1);
    expect(report.operations).toEqual([]);
    expect(report.commitWrites).toBe(0);
  });

  it('returns a typed provider failure without a commit', async () => {
    const threadId = `runtime-native-error-${crypto.randomUUID()}`;
    const target: ThreadRuntimeTarget = {
      ownerScopeRef: RUNTIME_NATIVE_OWNER,
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    const stub = nativeEnv().THREADS.getByName(threadId);

    await expect(stub.initialize(target.ownerScopeRef, target.threadId)).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      stub.runRuntimeTurn(requestFor(target, 'unexpected-sdk-error')),
    ).resolves.toMatchObject({
      status: 'failed',
      code: 'RUNTIME_FAILED',
      response: null,
    });
    const report = await stub.getRuntimeNativeReport();
    expect(report).not.toBeNull();
    if (report === null) return;
    expect(report.model.calls).toBe(1);
    expect(report.operations).toEqual([]);
    expect(report.commitWrites).toBe(0);
  });
});
