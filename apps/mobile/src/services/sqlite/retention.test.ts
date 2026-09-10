import { describe, expect, it } from 'vitest';
import type { RetentionMetadata } from '@ima/contracts';
import {
  canPersistOwnerScopedReference,
  minimumDeadline,
  projectRetention,
  retentionDisplayExpired,
  retentionPayloadExpired,
  sessionExpiryAt,
  sessionWindowStartAt,
} from './retention';

const full = (overrides: Partial<RetentionMetadata> = {}): RetentionMetadata => ({
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-08T05:00:00+09:00',
  freshUntil: '2026-09-08T04:25:00+09:00',
  displayUntil: '2026-09-08T05:00:00+09:00',
  retentionUntil: '2026-09-08T05:00:00+09:00',
  deletionScheduledAt: '2026-09-08T05:00:00+09:00',
  attribution: null,
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
  ...overrides,
});

const reference = (): RetentionMetadata => ({
  retentionDecision: 'allow',
  retentionMode: 'identifier_indefinite_owner_scoped',
  sessionExpiresAt: '2026-09-08T05:00:00+09:00',
  freshUntil: null,
  displayUntil: null,
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
});

const unknown: RetentionMetadata = {
  retentionDecision: 'unknown',
  retentionMode: 'session_only',
  sessionExpiresAt: '2026-09-08T05:00:00+09:00',
  freshUntil: null,
  displayUntil: null,
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only',
  policyStatus: 'policy_withheld',
  displayPolicyStatus: 'policy_withheld',
};

describe('M31 retention projection', () => {
  it('keeps the 05:00 JST boundary at before and exactly at cutoff', () => {
    expect(sessionExpiryAt('2026-09-08T04:59:59+09:00')).toBe('2026-09-08T05:00:00+09:00');
    expect(sessionExpiryAt('2026-09-08T05:00:00+09:00')).toBe('2026-09-09T05:00:00+09:00');
    expect(sessionWindowStartAt('2026-09-08T04:59:59+09:00')).toBe('2026-09-07T05:00:00+09:00');
    expect(sessionWindowStartAt('2026-09-08T05:00:00+09:00')).toBe('2026-09-08T05:00:00+09:00');
  });

  it('keeps payload before the retention boundary and turns it reference-only at equality', () => {
    expect(projectRetention(full(), '2026-09-08T04:30:00+09:00')).toEqual({
      restoreMode: 'full',
      canPersistPayload: true,
      needsRefetch: false,
    });
    expect(projectRetention(full(), '2026-09-08T05:00:00+09:00')).toEqual({
      restoreMode: 'reference_only',
      canPersistPayload: false,
      needsRefetch: true,
    });
    expect(
      projectRetention(
        full({
          freshUntil: '2026-09-08T04:20:00+09:00',
          displayUntil: '2026-09-08T04:20:00+09:00',
        }),
        '2026-09-08T04:30:00+09:00',
      ),
    ).toEqual({ restoreMode: 'reference_only', canPersistPayload: false, needsRefetch: true });
    expect(
      projectRetention(full({ displayPolicyStatus: 'expired' }), '2026-09-08T04:30:00+09:00'),
    ).toEqual({ restoreMode: 'reference_only', canPersistPayload: false, needsRefetch: true });
    expect(retentionPayloadExpired(full(), '2026-09-08T05:00:00+09:00')).toBe(true);
    expect(retentionDisplayExpired(full(), '2026-09-08T05:00:00+09:00')).toBe(true);
  });

  it('separates indefinite owner-scoped references from display payload', () => {
    expect(canPersistOwnerScopedReference(reference())).toBe(true);
    expect(projectRetention(reference(), '2026-09-08T06:00:00+09:00')).toEqual({
      restoreMode: 'reference_only',
      canPersistPayload: false,
      needsRefetch: false,
    });
    expect(canPersistOwnerScopedReference(full())).toBe(false);
  });

  it('denies unknown policy and chooses only future boundaries', () => {
    expect(projectRetention(unknown, '2026-09-08T04:30:00+09:00')).toEqual({
      restoreMode: 'unavailable',
      canPersistPayload: false,
      needsRefetch: true,
    });
    expect(
      minimumDeadline(
        ['2026-09-08T04:00:00+09:00', '2026-09-08T05:00:00+09:00', '2026-09-08T06:00:00+09:00'],
        '2026-09-08T04:30:00+09:00',
      ),
    ).toBe('2026-09-08T05:00:00+09:00');
    expect(minimumDeadline(['2026-09-08T04:00:00+09:00'], '2026-09-08T04:30:00+09:00')).toBeNull();
  });
});
