import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { OpaqueIdSchema } from '@ima/contracts';
import { createThreadId } from '@worker/runtime/threads/thread-id';

describe('create thread idempotency identity', () => {
  it('derives a stable opaque ID from owner and key', async () => {
    const first = await createThreadId('owner-a', 'create-key');
    const retry = await createThreadId('owner-a', 'create-key');

    expect(first).toBe(retry);
    expect(v.safeParse(OpaqueIdSchema, first).success).toBe(true);
  });

  it('keeps owners and keys in separate idempotency namespaces', async () => {
    const ownerA = await createThreadId('owner-a', 'create-key');
    const ownerB = await createThreadId('owner-b', 'create-key');
    const otherKey = await createThreadId('owner-a', 'other-key');

    expect(new Set([ownerA, ownerB, otherKey]).size).toBe(3);
  });
});
