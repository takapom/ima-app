import { describe, expect, it } from 'vitest';
import { parseRetentionMetadata } from './public';

const allowed = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-08T05:00:00+09:00',
  freshUntil: '2026-09-08T04:30:00+09:00',
  displayUntil: '2026-09-08T05:00:00+09:00',
  retentionUntil: '2026-09-08T05:00:00+09:00',
  deletionScheduledAt: '2026-09-08T05:00:00+09:00',
  attribution: null,
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};

describe('parseRetentionMetadata', () => {
  it('returns schema output for a valid public retention record', () => {
    expect(parseRetentionMetadata(allowed)).toEqual(allowed);
  });

  it('fails closed for missing or inconsistent fields', () => {
    expect(parseRetentionMetadata({ ...allowed, retentionUntil: null })).toBeNull();
    expect(parseRetentionMetadata({ ...allowed, unknownField: true })).toBeNull();
    expect(parseRetentionMetadata({ ...allowed, freshUntil: 'invalid' })).toBeNull();
  });

  it('preserves unknown decisions for the mobile policy boundary to deny', () => {
    expect(
      parseRetentionMetadata({
        ...allowed,
        retentionDecision: 'unknown',
        retentionMode: 'session_only',
        freshUntil: null,
        displayUntil: null,
        retentionUntil: null,
        deletionScheduledAt: null,
        restoreMode: 'reference_only',
        policyStatus: 'policy_withheld',
        displayPolicyStatus: 'policy_withheld',
      }),
    ).toMatchObject({ retentionDecision: 'unknown', policyStatus: 'policy_withheld' });
  });
});
