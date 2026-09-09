import { expect, it } from 'vitest';
import { plusMinutes, policyOf, retentionFor, sessionExpiry } from './retention-runtime-policy';

it('accepts known policies and defaults invalid input to unknown', () => {
  expect(policyOf('unknown')).toBe('unknown');
  expect(policyOf('disconnect')).toBe('disconnect');
  expect(policyOf('invalid')).toBe('unknown');
  expect(policyOf(null)).toBe('unknown');
});

it('uses the next 05:00 JST boundary at and after the cutoff', () => {
  expect(sessionExpiry('2026-09-08T04:59:59+09:00')).toBe('2026-09-08T05:00:00+09:00');
  expect(sessionExpiry('2026-09-08T05:00:00+09:00')).toBe('2026-09-09T05:00:00+09:00');
  expect(plusMinutes('2026-09-08T04:59:00+09:00', 2)).toBe('2026-09-07T20:01:00.000Z');
});

it('clamps provider retention to the earlier session expiry', () => {
  const retention = retentionFor('allow', '2026-09-08T04:55:00+09:00', '2026-09-08T05:30:00+09:00');

  expect(retention.sessionExpiresAt).toBe('2026-09-08T05:00:00+09:00');
  expect(retention.retentionUntil).toBe('2026-09-08T05:00:00+09:00');
  expect(retention.displayUntil).toBe('2026-09-08T05:00:00+09:00');
  expect(retention.freshUntil).toBe('2026-09-07T20:00:00.000Z');
});

it('does not create provider retention for unknown policy', () => {
  const retention = retentionFor('unknown', '2026-09-08T12:00:00+09:00', null);

  expect(retention).toMatchObject({
    retentionDecision: 'unknown',
    retentionMode: 'session_only',
    freshUntil: null,
    retentionUntil: null,
    deletionScheduledAt: null,
    restoreMode: 'reference_only',
    policyStatus: 'policy_withheld',
    displayPolicyStatus: 'policy_withheld',
  });
});
