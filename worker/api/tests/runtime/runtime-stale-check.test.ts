import { describe, expect, it } from 'vitest';
import { isRuntimeTargetStale } from '@api/thread-runtime/stale-check';

const target = {
  ownerScopeRef: 'owner-stale-check',
  threadId: 'thread-stale-check',
  turnId: 'turn-stale-check',
  revision: 1,
} as const;

const binding = { revision: 2, active: true } as const;

describe('runtime self-finalization stale check', () => {
  it('accepts only a completed row with the matching commit revision', () => {
    expect(
      isRuntimeTargetStale(target, binding, {
        status: 'completed',
        response_revision: 2,
      }),
    ).toBe(false);
    expect(
      isRuntimeTargetStale(target, binding, {
        status: 'completed',
        response_revision: 3,
      }),
    ).toBe(true);
    expect(
      isRuntimeTargetStale(target, binding, {
        status: 'running',
        response_revision: 2,
      }),
    ).toBe(true);
  });

  it('keeps ordinary revision changes and inactive bindings stale', () => {
    expect(
      isRuntimeTargetStale(
        target,
        { revision: 3, active: true },
        { status: 'completed', response_revision: 3 },
      ),
    ).toBe(true);
    expect(
      isRuntimeTargetStale(
        target,
        { revision: 2, active: false },
        { status: 'completed', response_revision: 2 },
      ),
    ).toBe(true);
    expect(isRuntimeTargetStale(target, undefined, undefined)).toBe(true);
  });
});
