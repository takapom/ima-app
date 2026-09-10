import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { ThreadDO } from './runtime-native-worker';
import type {
  ThreadRuntimeTarget,
  ThreadRuntimeTurnInput,
} from '../../src/thread-runtime/admission';

type NativeTestEnv = Cloudflare.Env & {
  readonly THREADS: DurableObjectNamespace<ThreadDO>;
};

const LOG_SENTINELS = [
  'M24_USER_SENTINEL',
  'M24_PROVIDER_PAYLOAD_SENTINEL',
  'M24_KEY_SENTINEL',
] as const;

type ConsoleSpy = {
  readonly mock: { readonly calls: readonly (readonly unknown[])[] };
  mockRestore(): void;
};

const requestFor = (target: ThreadRuntimeTarget): ThreadRuntimeTurnInput => {
  const idempotencyKey = LOG_SENTINELS[2];
  return {
    ...target,
    idempotencyKey,
    input: {
      schemaVersion: 'v1',
      requestId: `request-${target.turnId}`,
      turnId: target.turnId,
      revision: target.revision,
      text: `[runtime-native:unexpected-sdk-error] ${LOG_SENTINELS[0]}`,
      clientNow: '2026-09-10T12:00:00.000Z',
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
        areaText: 'SDKログ監査',
        budget: 'normal',
      },
      savedPlaceRefs: [],
      excludeCandidateIds: [],
      mode: 'search',
      idempotencyKey,
    },
  };
};

const containsSentinel = (
  value: unknown,
  sentinel: string,
  seen = new WeakSet<object>(),
): boolean => {
  if (typeof value === 'string') return value.includes(sentinel);
  if (typeof value !== 'object' || value === null || seen.has(value)) return false;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (String(key).includes(sentinel)) return true;
    try {
      if (containsSentinel(Reflect.get(value, key), sentinel, seen)) return true;
    } catch {
      throw new Error('M24_CONSOLE_ARGUMENT_UNREADABLE');
    }
  }
  return false;
};

const consoleContains = (spies: readonly ConsoleSpy[], sentinel: string): boolean =>
  spies.some((spy) =>
    spy.mock.calls.some((args) => args.some((value) => containsSentinel(value, sentinel))),
  );

describe('M23 native SDK log boundary', () => {
  it('maps a raw provider failure without exposing user, provider, or key sentinels to console', async () => {
    const threadId = `runtime-native-log-${crypto.randomUUID()}`;
    const target: ThreadRuntimeTarget = {
      ownerScopeRef: 'owner-m24-sdk-log',
      threadId,
      turnId: `turn-${crypto.randomUUID()}`,
      revision: 1,
    };
    const stub = (env as NativeTestEnv).THREADS.getByName(threadId);
    const spies: ConsoleSpy[] = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    try {
      await runInDurableObject(stub, (instance) => instance.emitRuntimeNativeConsoleProbe());
      expect(consoleContains(spies, 'M24_CONSOLE_CONTROL')).toBe(true);
      await expect(stub.initialize(target.ownerScopeRef, threadId)).resolves.toMatchObject({
        ok: true,
      });
      const result = await stub.runRuntimeTurn(requestFor(target));
      expect(result).toMatchObject({ status: 'failed', code: 'RUNTIME_FAILED', response: null });
      expect(JSON.stringify(result)).not.toContain(LOG_SENTINELS[0]);
      expect(JSON.stringify(result)).not.toContain(LOG_SENTINELS[1]);
      expect(JSON.stringify(result)).not.toContain(LOG_SENTINELS[2]);
      const report = await stub.getRuntimeNativeReport();
      expect(report?.model.rawProviderErrorDetailSeen).toBe(true);
      for (const sentinel of LOG_SENTINELS) expect(consoleContains(spies, sentinel)).toBe(false);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});
