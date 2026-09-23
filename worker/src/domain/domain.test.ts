import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { AnyFieldResultSchema, FieldResultSchema, ResultSchema } from '@worker/domain/result';
import {
  AnyObservationSchema,
  EvidenceTextWithPolicySchema,
  ObservationSchema,
} from '@worker/domain/evidence/evidence';
import {
  CandidateIdSchema,
  CalendarDateSchema,
  HttpsUrlSchema,
  IsoTimestampSchema,
  RevisionSchema,
} from '@worker/domain/primitives';
import { IssueSchema } from '@worker/domain/issue';
import { LastTrainInfoSchema } from '@worker/domain/places/place-values';
import { ModelActionMetadataSchema } from '@worker/domain/constraints/constraints';
import { RetentionMetadataSchema } from '@worker/domain/evidence/retention';

const timestamp = '2026-09-09T12:00:00Z';
const allowRetention = (overrides: Record<string, unknown> = {}) => ({
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-10T05:00:00+09:00',
  freshUntil: timestamp,
  displayUntil: '2026-09-09T13:00:00Z',
  retentionUntil: '2026-09-10T05:00:00+09:00',
  deletionScheduledAt: '2026-09-10T05:00:00+09:00',
  attribution: { label: 'Example source', sourceLink: 'https://example.com/source' },
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
  ...overrides,
});
const denyRetention = (overrides: Record<string, unknown> = {}) => ({
  retentionDecision: 'unknown',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-09T13:00:00Z',
  freshUntil: timestamp,
  displayUntil: '2026-09-09T13:00:00Z',
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: { label: 'Example source', sourceLink: 'https://example.com/source' },
  restoreMode: 'reference_only',
  policyStatus: 'policy_withheld',
  displayPolicyStatus: 'available',
  ...overrides,
});
const evidence = {
  evidenceId: 'obs-1',
  observationId: 'obs-1',
  candidateId: 'candidate-1',
  field: 'identity',
  attribution: { label: 'Example source', sourceLink: 'https://example.com/source' },
  retention: denyRetention(),
};

describe('core domain contracts', () => {
  it('bounds IDs and revisions without importing the public contracts package', () => {
    expect(v.safeParse(CandidateIdSchema, 'candidate-1').success).toBe(true);
    expect(v.safeParse(CandidateIdSchema, 'provider/raw').success).toBe(false);
    expect(v.safeParse(RevisionSchema, Number.MAX_SAFE_INTEGER).success).toBe(true);
    expect(v.safeParse(RevisionSchema, Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
  });

  it('validates leap dates, years below 100, offsets, and safe external URLs', () => {
    expect(v.safeParse(CalendarDateSchema, '0001-02-28').success).toBe(true);
    expect(v.safeParse(CalendarDateSchema, '1900-02-29').success).toBe(false);
    expect(v.safeParse(CalendarDateSchema, '2000-02-29').success).toBe(true);
    expect(v.safeParse(IsoTimestampSchema, '0001-02-28T23:59:59+00:00').success).toBe(true);
    expect(v.safeParse(IsoTimestampSchema, '2026-09-09T12:00:00+14:01').success).toBe(false);
    expect(v.safeParse(HttpsUrlSchema, 'https://example.com/path').success).toBe(true);
    expect(v.safeParse(HttpsUrlSchema, 'not-a-url').success).toBe(false);
    expect(v.safeParse(HttpsUrlSchema, 'javascript:alert(1)').success).toBe(false);
    expect(v.safeParse(HttpsUrlSchema, 'data:text/plain,unsafe').success).toBe(false);
  });

  it('keeps retention storage and transient display independent', () => {
    expect(v.safeParse(RetentionMetadataSchema, allowRetention()).success).toBe(true);
    expect(
      v.safeParse(RetentionMetadataSchema, allowRetention({ deletionScheduledAt: null })).success,
    ).toBe(false);
    expect(v.safeParse(RetentionMetadataSchema, denyRetention()).success).toBe(true);
    expect(
      v.safeParse(RetentionMetadataSchema, denyRetention({ retentionUntil: timestamp })).success,
    ).toBe(false);
    expect(
      v.safeParse(RetentionMetadataSchema, allowRetention({ policyStatus: 'disabled_m35' }))
        .success,
    ).toBe(false);
    expect(
      v.safeParse(RetentionMetadataSchema, {
        ...allowRetention(),
        retentionMode: 'identifier_indefinite_owner_scoped',
        freshUntil: null,
        displayUntil: null,
        retentionUntil: null,
        deletionScheduledAt: null,
        restoreMode: 'reference_only',
      }).success,
    ).toBe(true);
  });

  it('distinguishes known, unavailable, and failed fields and result status', () => {
    const observation = {
      observationId: 'obs-1',
      candidateId: 'candidate-1',
      field: 'identity',
      value: 'Melt',
      basis: 'provider_reported',
      fetchedAt: timestamp,
      sourceUpdatedAt: null,
      expiresAt: '2026-09-09T13:00:00Z',
      contextKey: 'thread-1:identity',
      sources: [
        {
          provider: 'fixture',
          recordRef: 'record-1',
          attribution: 'Example source',
          publicUrl: 'https://example.com/source',
        },
      ],
      retention: allowRetention(),
    };
    expect(v.safeParse(ObservationSchema(v.string()), observation).success).toBe(true);
    expect(
      v.safeParse(ObservationSchema(v.string()), {
        ...observation,
        expiresAt: '2026-09-09T11:59:59Z',
      }).success,
    ).toBe(false);
    expect(v.safeParse(AnyObservationSchema, observation).success).toBe(true);
    expect(
      v.safeParse(FieldResultSchema(v.string()), {
        status: 'known',
        observations: [observation],
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(FieldResultSchema(v.string()), {
        status: 'known',
        observations: [observation, observation],
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(AnyFieldResultSchema, { status: 'unsupported', reason: '能力未提供' }).success,
    ).toBe(true);
    expect(
      v.safeParse(AnyFieldResultSchema, {
        status: 'error',
        error: {
          code: 'TIMEOUT',
          path: 'identity',
          retryable: true,
          retryAfterMs: 100,
          message: 'upstream timeout',
          missingFields: [],
        },
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(ResultSchema(v.array(v.string())), {
        status: 'partial',
        data: ['Melt'],
        warnings: [],
      }).success,
    ).toBe(true);
    expect(v.safeParse(IssueSchema, { code: 'UNKNOWN_CODE' }).success).toBe(false);
  });

  it('inherits the strictest source evidence policy for generated text', () => {
    const textSchema = EvidenceTextWithPolicySchema(300);
    expect(
      v.safeParse(textSchema, {
        text: '一時表示の候補',
        evidenceIds: ['obs-1'],
        evidence: [evidence],
        basis: 'grounded',
        retention: denyRetention(),
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(textSchema, {
        text: '保存可能と誤って延長',
        evidenceIds: ['obs-1'],
        evidence: [evidence],
        basis: 'grounded',
        retention: allowRetention(),
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(textSchema, {
        text: '表示期限を延長',
        evidenceIds: ['obs-1'],
        evidence: [evidence],
        basis: 'grounded',
        retention: denyRetention({ displayUntil: '2026-09-09T13:30:00Z' }),
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(textSchema, {
        text: 'セッション期限を延長',
        evidenceIds: ['obs-1'],
        evidence: [evidence],
        basis: 'grounded',
        retention: denyRetention({ sessionExpiresAt: '2026-09-10T13:00:00Z' }),
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(textSchema, {
        text: '重複根拠',
        evidenceIds: ['obs-1', 'obs-1'],
        evidence: [evidence],
        basis: 'grounded',
        retention: denyRetention(),
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(textSchema, {
        text: '根拠なし',
        evidenceIds: [],
        evidence: [],
        basis: 'conversational',
        retention: denyRetention(),
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(textSchema, {
        text: '未参照根拠',
        evidenceIds: ['obs-1'],
        evidence: [
          { ...evidence, evidenceId: 'obs-1' },
          { ...evidence, evidenceId: 'obs-2' },
        ],
        basis: 'grounded',
        retention: denyRetention(),
      }).success,
    ).toBe(false);
  });

  it('rejects an unusable last-train result that cannot satisfy minimum stay', () => {
    const lastTrain = {
      serviceDate: '2026-09-09',
      fromStationRef: 'station-a',
      homeStationRef: 'station-home',
      journeyRef: 'journey-1',
      lastDepartureAt: timestamp,
      arrivesHomeAt: '2026-09-09T13:00:00Z',
      transfers: [],
      placeToStationSeconds: 300,
      arrivePlaceAt: timestamp,
      leaveBy: '2026-09-09T12:30:00Z',
      availableStaySeconds: 1_199,
      minimumStayMinutes: 20,
      usable: true,
    };
    expect(v.safeParse(LastTrainInfoSchema, lastTrain).success).toBe(false);
    expect(v.safeParse(LastTrainInfoSchema, { ...lastTrain, usable: false }).success).toBe(true);
    expect(
      v.safeParse(LastTrainInfoSchema, {
        ...lastTrain,
        availableStaySeconds: -1,
        usable: false,
      }).success,
    ).toBe(true);
  });

  it('accepts only empty model action metadata now that turn constraints are removed', () => {
    expect(v.safeParse(ModelActionMetadataSchema, {}).success).toBe(true);
    expect(
      v.safeParse(ModelActionMetadataSchema, {
        turnConstraints: {
          changes: [{ minimumStayMinutes: 20, sourceTurnId: 'turn-1', quote: '20分' }],
        },
      }).success,
    ).toBe(false);
  });
});
