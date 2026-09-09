import { env, evictDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ThreadDO } from '../../../src/thread-do';

const OWNER_A = 'A'.repeat(42) + 'E';
const OWNER_B = 'B'.repeat(42) + 'E';

type TestEnv = Cloudflare.Env & { THREADS: DurableObjectNamespace<ThreadDO> };

function hasThreadBinding(value: typeof env): value is TestEnv {
  return typeof value === 'object' && value !== null && 'THREADS' in value;
}

function testEnv(value: typeof env): TestEnv {
  if (!hasThreadBinding(value)) throw new Error('M05_THREAD_BINDING_MISSING');
  return value;
}

async function initialize(stub: DurableObjectStub<ThreadDO>, owner: string, threadId: string) {
  const result = await stub.initialize(owner, threadId);
  if (!result.ok) throw new Error(`initialization failed: ${result.code}`);
}

describe('ThreadDO atomic owner and lifecycle boundaries', () => {
  it('binds one owner when concurrent initialization races', async () => {
    const threadId = `concurrent-init-${crypto.randomUUID()}`;
    const stub = testEnv(env).THREADS.getByName(threadId);
    const outcomes = await Promise.all([
      stub.initialize(OWNER_A, threadId),
      stub.initialize(OWNER_B, threadId),
    ]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    const deniedInitialization = outcomes.find((outcome) => !outcome.ok);
    if (deniedInitialization === undefined || deniedInitialization.ok) {
      throw new Error('owner initialization race did not reject the loser');
    }
    expect(deniedInitialization.code).toBe('FORBIDDEN');

    const ownerReads = await Promise.all([stub.read(OWNER_A), stub.read(OWNER_B)]);
    expect(ownerReads.filter((result) => result.ok)).toHaveLength(1);
    const denied = ownerReads.find((result) => !result.ok);
    if (denied === undefined || denied.ok) throw new Error('owner race did not reject the loser');
    expect(denied.code).toBe('FORBIDDEN');
  });

  it('serializes same-revision lifecycle operations as one success and one conflict', async () => {
    const threadId = `concurrent-lifecycle-${crypto.randomUUID()}`;
    const stub = testEnv(env).THREADS.getByName(threadId);
    await initialize(stub, OWNER_A, threadId);

    const outcomes = await Promise.all([
      stub.applyLifecycle(OWNER_A, 'resumed', 'turn-a', 1, 'lifecycle-a'),
      stub.applyLifecycle(OWNER_A, 'cancelled', 'turn-b', 1, 'lifecycle-b'),
    ]);
    expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
    const conflict = outcomes.find((result) => !result.ok);
    if (conflict === undefined || conflict.ok) throw new Error('lifecycle race did not conflict');
    expect(conflict.code).toBe('REVISION_CONFLICT');

    const current = await stub.read(OWNER_A);
    if (!current.ok) throw new Error('owner lost after lifecycle race');
    expect(current.snapshot.revision).toBe(2);
  });

  it('keeps a deleted thread tombstoned after eviction and prevents rebinding', async () => {
    const threadId = `deleted-eviction-${crypto.randomUUID()}`;
    const namespace = testEnv(env).THREADS;
    const stub = namespace.getByName(threadId);
    await initialize(stub, OWNER_A, threadId);
    expect(await stub.deleteThread(OWNER_A, 'delete-turn', 1, 'delete-key')).toEqual({ ok: true });

    await evictDurableObject(stub);
    const afterEviction = namespace.getByName(threadId);
    expect(await afterEviction.initialize(OWNER_B, threadId)).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });

    const ownerA = await afterEviction.read(OWNER_A);
    const ownerB = await afterEviction.read(OWNER_B);
    expect(ownerA).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(ownerB).toEqual({ ok: false, code: 'NOT_FOUND' });
  });
});
