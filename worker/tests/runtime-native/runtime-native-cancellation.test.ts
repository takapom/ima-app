import * as v from 'valibot';
import { env } from 'cloudflare:test';
import { AssistantResponseSchema } from '@ima/contracts';
import { describe, expect, it } from 'vitest';
import type { ThreadDO } from './runtime-native-worker';
import type { RuntimeNativeScenario } from './runtime-native-provider';
import { RUNTIME_NATIVE_OWNER } from './runtime-native-ports';
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
  scenario: RuntimeNativeScenario,
): ThreadRuntimeTurnInput => ({
  ...target,
  idempotencyKey: `native-cancel-${target.turnId}`,
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
    idempotencyKey: `native-cancel-${target.turnId}`,
  },
});

const statusFrom = (value: unknown): string | undefined => {
  if (typeof value !== 'object' || value === null || !('status' in value)) return undefined;
  return typeof value.status === 'string' ? value.status : undefined;
};

const responseFrom = (value: unknown): unknown => {
  if (typeof value !== 'object' || value === null || !('response' in value)) return undefined;
  return value.response;
};

type RuntimeNativeExecutionReport = NonNullable<
  Awaited<ReturnType<ThreadDO['getRuntimeNativeReport']>>
>;

const waitForModelStart = async (
  stub: DurableObjectStub<ThreadDO>,
): Promise<RuntimeNativeExecutionReport> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const report = await stub.getRuntimeNativeReport();
    if (report !== null && report.model.waitingStarted === true) return report;
    await Promise.resolve();
  }
  throw new Error('RUNTIME_NATIVE_MODEL_DID_NOT_START');
};

const targetFor = (prefix: string, revision = 1): ThreadRuntimeTarget => ({
  ownerScopeRef: RUNTIME_NATIVE_OWNER,
  threadId: `runtime-native-${prefix}-${crypto.randomUUID()}`,
  turnId: `turn-${crypto.randomUUID()}`,
  revision,
});

describe('native Think runtime cancellation and stale turns', () => {
  it('aborts a waiting model through cancelRuntimeTurn without response or side effects', async () => {
    const target = targetFor('cancel');
    const stub = nativeEnv().THREADS.getByName(target.threadId);
    await expect(stub.initialize(target.ownerScopeRef, target.threadId)).resolves.toMatchObject({
      ok: true,
    });

    const running: Promise<unknown> = Promise.resolve(
      stub.runRuntimeTurn(requestFor(target, 'waiting-for-cancellation')),
    );
    const started = await waitForModelStart(stub);
    expect(started.model.calls).toBe(1);
    expect(started.model.abortObserved).toBe(false);

    await expect(stub.cancelRuntimeTurn(target)).resolves.toMatchObject({ status: 'accepted' });
    const result = await running;
    expect(statusFrom(result)).toBe('cancelled');
    expect(responseFrom(result)).toBeNull();

    const report = await stub.getRuntimeNativeReport();
    expect(report).not.toBeNull();
    if (report === null) return;
    expect(report.model.waitingStarted).toBe(true);
    expect(report.model.abortObserved).toBe(true);
    expect(report.model.calls).toBe(1);
    expect(report.model.requests).toHaveLength(1);
    expect(report.operations).toEqual([]);
    expect(report.commitWrites).toBe(0);
    await expect(stub.replayRuntimeTurn(target)).resolves.toMatchObject({
      status: 'unavailable',
    });
  });

  it('invalidates an old lifecycle turn before a newer revision can become current', async () => {
    const oldTarget = targetFor('old-turn');
    const stub = nativeEnv().THREADS.getByName(oldTarget.threadId);
    await expect(
      stub.initialize(oldTarget.ownerScopeRef, oldTarget.threadId),
    ).resolves.toMatchObject({
      ok: true,
    });

    const oldRun: Promise<unknown> = Promise.resolve(
      stub.runRuntimeTurn(requestFor(oldTarget, 'waiting-for-cancellation')),
    );
    const oldStarted = await waitForModelStart(stub);
    expect(oldStarted.model.calls).toBe(1);

    await expect(
      stub.applyLifecycle(
        oldTarget.ownerScopeRef,
        'resumed',
        oldTarget.turnId,
        oldTarget.revision,
        `native-resume-${crypto.randomUUID()}`,
      ),
    ).resolves.toMatchObject({
      ok: true,
      snapshot: { revision: 2, active: true, state: 'resumed' },
    });

    const afterLifecycle = await stub.getRuntimeNativeReport();
    expect(afterLifecycle).not.toBeNull();
    if (afterLifecycle === null) return;
    expect(afterLifecycle.model.abortObserved).toBe(true);
    expect(afterLifecycle.operations).toEqual([]);
    expect(afterLifecycle.commitWrites).toBe(0);

    const newTarget: ThreadRuntimeTarget = {
      ...oldTarget,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 2,
    };
    const newRun: Promise<unknown> = Promise.resolve(
      stub.runRuntimeTurn(requestFor(newTarget, 'invalid-submit-details-valid')),
    );
    const [oldResult, newResult] = await Promise.all([oldRun, newRun]);
    expect(['cancelled', 'stale']).toContain(statusFrom(oldResult));
    expect(responseFrom(oldResult)).toBeNull();

    expect(statusFrom(newResult)).toBe('completed');
    const parsed = v.safeParse(AssistantResponseSchema, responseFrom(newResult));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.output.threadId).toBe(newTarget.threadId);
    expect(parsed.output.turnId).toBe(newTarget.turnId);
    expect(parsed.output.revision).toBe(3);

    await expect(stub.read(oldTarget.ownerScopeRef)).resolves.toMatchObject({
      ok: true,
      snapshot: { revision: 3, active: true },
    });
    await expect(stub.replayRuntimeTurn(oldTarget)).resolves.toMatchObject({
      status: 'unavailable',
    });
    await expect(stub.replayRuntimeTurn(newTarget)).resolves.toMatchObject({
      status: 'reference_only',
      response: { turnId: newTarget.turnId, revision: 3, restoreMode: 'reference_only' },
    });

    const report = await stub.getRuntimeNativeReport();
    expect(report).not.toBeNull();
    if (report === null) return;
    expect(report.scenario).toBe('invalid-submit-details-valid');
    expect(report.model.calls).toBe(3);
    expect(report.commitWrites).toBe(1);
  });
});
