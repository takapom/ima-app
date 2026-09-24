import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
  capRetention,
  narrowRetention,
  RetentionMetadataSchema,
  type RetentionMetadata,
} from '@worker/domain/evidence/retention';

const app: RetentionMetadata = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-10T04:00:00.000Z',
  freshUntil: '2026-09-10T01:00:00.000Z',
  displayUntil: '2026-09-10T04:00:00.000Z',
  retentionUntil: '2026-09-10T04:00:00.000Z',
  deletionScheduledAt: '2026-09-10T04:00:00.000Z',
  attribution: { label: 'App credit', sourceLink: null },
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};

const shorter: RetentionMetadata = {
  ...app,
  sessionExpiresAt: '2026-09-10T03:00:00.000Z',
  freshUntil: '2026-09-10T00:30:00.000Z',
  displayUntil: '2026-09-10T02:00:00.000Z',
  retentionUntil: '2026-09-10T02:30:00.000Z',
  deletionScheduledAt: '2026-09-10T02:30:00.000Z',
  attribution: { label: 'Provider credit', sourceLink: 'https://example.com/' },
};

const denied: RetentionMetadata = {
  ...app,
  retentionDecision: 'deny',
  retentionMode: 'session_only',
  freshUntil: null,
  displayUntil: null,
  retentionUntil: null,
  deletionScheduledAt: null,
  restoreMode: 'reference_only',
  policyStatus: 'policy_withheld',
  displayPolicyStatus: 'policy_withheld',
};

const valid = (retention: RetentionMetadata) =>
  v.safeParse(RetentionMetadataSchema, retention).success;

describe('narrowRetention', () => {
  it('keeps the base unchanged without inputs', () => {
    expect(narrowRetention(app, [])).toEqual(app);
  });

  it('ends every window at the earliest input deadline and keeps the base credit', () => {
    const narrowed = narrowRetention(app, [shorter]);
    expect(narrowed).toMatchObject({
      retentionDecision: 'allow',
      sessionExpiresAt: shorter.sessionExpiresAt,
      freshUntil: shorter.freshUntil,
      displayUntil: shorter.displayUntil,
      retentionUntil: shorter.retentionUntil,
      deletionScheduledAt: shorter.deletionScheduledAt,
      attribution: app.attribution,
    });
    expect(valid(narrowed)).toBe(true);
    // The order of inputs does not matter.
    expect(narrowRetention(shorter, [app])).toMatchObject({
      sessionExpiresAt: shorter.sessionExpiresAt,
      retentionUntil: shorter.retentionUntil,
    });
  });

  it('never stores or displays the text when one input forbids it', () => {
    const narrowed = narrowRetention(app, [shorter, denied]);
    expect(narrowed).toMatchObject({
      retentionDecision: 'deny',
      retentionUntil: null,
      deletionScheduledAt: null,
      policyStatus: 'policy_withheld',
      displayPolicyStatus: 'policy_withheld',
    });
    expect(narrowed.restoreMode).not.toBe('full');
    // A denied input without deadlines does not erase the other inputs' deadlines.
    expect(narrowed.displayUntil).toBe(shorter.displayUntil);
    expect(narrowed.sessionExpiresAt).toBe(shorter.sessionExpiresAt);
    expect(valid(narrowed)).toBe(true);
  });

  it('keeps a text displayable but unstored when only storage is unknown', () => {
    const unknownStorage: RetentionMetadata = {
      ...denied,
      retentionDecision: 'unknown',
      displayPolicyStatus: 'available',
    };
    expect(narrowRetention(app, [unknownStorage])).toMatchObject({
      retentionDecision: 'unknown',
      retentionUntil: null,
      displayPolicyStatus: 'available',
    });
  });

  it('does not store text derived from an indefinite identifier', () => {
    const indefinite: RetentionMetadata = {
      ...app,
      retentionMode: 'identifier_indefinite_owner_scoped',
      freshUntil: null,
      displayUntil: null,
      retentionUntil: null,
      deletionScheduledAt: null,
      restoreMode: 'reference_only',
    };
    expect(valid(indefinite)).toBe(true);
    expect(narrowRetention(app, [indefinite]).retentionDecision).not.toBe('allow');
  });

  it('keeps a stored reference when an input restores only by reference', () => {
    expect(narrowRetention(app, [{ ...shorter, restoreMode: 'reference_only' }]).restoreMode).toBe(
      'reference_only',
    );
  });
});

describe('capRetention', () => {
  it('ends every window no later than the deadline', () => {
    const capped = capRetention(app, '2026-09-10T00:45:00.000Z');
    expect(capped).toMatchObject({
      sessionExpiresAt: '2026-09-10T00:45:00.000Z',
      freshUntil: '2026-09-10T00:45:00.000Z',
      displayUntil: '2026-09-10T00:45:00.000Z',
      retentionUntil: '2026-09-10T00:45:00.000Z',
      deletionScheduledAt: '2026-09-10T00:45:00.000Z',
    });
    expect(valid(capped)).toBe(true);
    expect(capRetention(app, '2026-09-11T00:00:00.000Z')).toEqual(app);
  });
});
