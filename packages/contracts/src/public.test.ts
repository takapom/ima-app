import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { EvidenceRefSchema, parseRetentionMetadata } from '@contracts/public';

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

describe('EvidenceRefSchema', () => {
  const evidence = {
    evidenceId: 'evidence-1',
    attribution: null,
    retention: allowed,
  };

  it('accepts legacy singular attribution and bounded plural attributions', () => {
    expect(v.safeParse(EvidenceRefSchema, evidence).success).toBe(true);
    expect(
      v.safeParse(EvidenceRefSchema, {
        ...evidence,
        attributions: [
          { label: 'Google Maps', sourceLink: 'https://maps.google.com' },
          { label: 'ホットペッパー', sourceLink: 'https://www.hotpepper.jp' },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects an unbounded plural attribution payload', () => {
    expect(
      v.safeParse(EvidenceRefSchema, {
        ...evidence,
        attributions: Array.from({ length: 10 }, (_, index) => ({
          label: `Source ${index + 1}`,
          sourceLink: `https://example.com/source-${index + 1}`,
        })),
      }).success,
    ).toBe(false);
  });

  it('rejects an empty plural field instead of hiding a legacy attribution', () => {
    expect(
      v.safeParse(EvidenceRefSchema, {
        ...evidence,
        attribution: { label: 'Legacy', sourceLink: 'https://example.com/legacy' },
        attributions: [],
      }).success,
    ).toBe(false);
  });
});
