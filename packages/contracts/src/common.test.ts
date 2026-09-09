import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
  CalendarDateSchema,
  HttpsUrlSchema,
  IsoTimestampSchema,
  OpaqueIdSchema,
  RevisionSchema,
  SchemaVersionSchema,
} from './common';
import {
  AttributionSchema,
  DisplayFieldSchema,
  PublicEvidenceTextSchema,
  RetentionMetadataSchema,
} from './public';

const timestamp = '2026-09-09T12:00:00Z';

const allowedRetention = (overrides: Record<string, unknown> = {}) => ({
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-10T05:00:00+09:00',
  freshUntil: timestamp,
  displayUntil: '2026-09-09T13:00:00Z',
  retentionUntil: '2026-09-10T05:00:00+09:00',
  deletionScheduledAt: '2026-09-10T05:00:00+09:00',
  attribution: { label: 'Example source', sourceLink: null },
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
  ...overrides,
});

const deniedRetention = (overrides: Record<string, unknown> = {}) => ({
  retentionDecision: 'deny',
  retentionMode: 'provider_limited',
  sessionExpiresAt: timestamp,
  freshUntil: '2026-09-09T11:00:00Z',
  displayUntil: timestamp,
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only',
  policyStatus: 'policy_withheld',
  displayPolicyStatus: 'available',
  ...overrides,
});

const evidence = {
  evidenceId: 'obs-1',
  attribution: { label: 'Example source', sourceLink: null },
  retention: allowedRetention(),
};

const DisplayValueSchema = v.strictObject({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(160)),
  area: v.pipe(v.string(), v.minLength(1), v.maxLength(160)),
  address: v.nullable(v.string()),
  category: v.nullable(v.string()),
});

describe('public contract primitives', () => {
  it('validates leap dates, years below 100, offsets, and rejects impossible dates', () => {
    expect(v.safeParse(IsoTimestampSchema, '2024-02-29T12:00:00Z').success).toBe(true);
    expect(v.safeParse(IsoTimestampSchema, '0096-02-29T12:00:00+09:00').success).toBe(true);
    expect(v.safeParse(IsoTimestampSchema, '0099-02-28T23:59:59-05:30').success).toBe(true);
    expect(v.safeParse(IsoTimestampSchema, '2023-02-29T12:00:00Z').success).toBe(false);
    expect(v.safeParse(IsoTimestampSchema, '2026-02-31T12:00:00Z').success).toBe(false);
    expect(v.safeParse(IsoTimestampSchema, '2026-09-09T12:00:00+15:00').success).toBe(false);
    expect(v.safeParse(CalendarDateSchema, '0096-02-29').success).toBe(true);
    expect(v.safeParse(CalendarDateSchema, '2023-02-29').success).toBe(false);
  });

  it('keeps schema version, IDs, and revisions bounded', () => {
    expect(v.safeParse(SchemaVersionSchema, 'v1').success).toBe(true);
    expect(v.safeParse(SchemaVersionSchema, 'v2').success).toBe(false);
    expect(v.safeParse(RevisionSchema, Number.MAX_SAFE_INTEGER).success).toBe(true);
    expect(v.safeParse(RevisionSchema, Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
    expect(v.safeParse(RevisionSchema, 0).success).toBe(false);
    expect(v.safeParse(OpaqueIdSchema, 'candidate_01').success).toBe(true);
    expect(v.safeParse(OpaqueIdSchema, '').success).toBe(false);
    expect(v.safeParse(OpaqueIdSchema, 'contains space').success).toBe(false);
    expect(v.safeParse(OpaqueIdSchema, 'a'.repeat(129)).success).toBe(false);
  });

  it('accepts only HTTPS attribution links', () => {
    expect(v.safeParse(HttpsUrlSchema, 'https://example.com/source').success).toBe(true);
    expect(v.safeParse(HttpsUrlSchema, 'http://example.com/source').success).toBe(false);
    expect(v.safeParse(HttpsUrlSchema, 'javascript:alert(1)').success).toBe(false);
    expect(v.safeParse(HttpsUrlSchema, 'data:text/plain,secret').success).toBe(false);
    expect(() => v.safeParse(HttpsUrlSchema, 'not-a-url')).not.toThrow();
    expect(v.safeParse(HttpsUrlSchema, 'not-a-url').success).toBe(false);
    expect(v.safeParse(HttpsUrlSchema, '').success).toBe(false);
    expect(
      v.safeParse(AttributionSchema, { label: 'Source', sourceLink: 'https://example.com' })
        .success,
    ).toBe(true);
  });

  it('enforces retention windows and explicit saved-reference exception', () => {
    expect(v.safeParse(RetentionMetadataSchema, allowedRetention()).success).toBe(true);
    expect(
      v.safeParse(RetentionMetadataSchema, allowedRetention({ retentionMode: 'session_only' }))
        .success,
    ).toBe(true);
    expect(
      v.safeParse(
        RetentionMetadataSchema,
        allowedRetention({ retentionUntil: '2026-09-10T06:00:00+09:00' }),
      ).success,
    ).toBe(false);
    expect(
      v.safeParse(
        RetentionMetadataSchema,
        allowedRetention({ displayUntil: '2026-09-11T05:00:00+09:00' }),
      ).success,
    ).toBe(false);
    expect(
      v.safeParse(RetentionMetadataSchema, allowedRetention({ policyStatus: 'disabled_m35' }))
        .success,
    ).toBe(false);
    expect(
      v.safeParse(RetentionMetadataSchema, allowedRetention({ retentionMode: 'none' })).success,
    ).toBe(false);
    expect(
      v.safeParse(RetentionMetadataSchema, allowedRetention({ deletionScheduledAt: null })).success,
    ).toBe(false);

    expect(
      v.safeParse(
        RetentionMetadataSchema,
        allowedRetention({
          retentionMode: 'identifier_indefinite_owner_scoped',
          freshUntil: null,
          displayUntil: null,
          retentionUntil: null,
          deletionScheduledAt: null,
          restoreMode: 'reference_only',
        }),
      ).success,
    ).toBe(true);
    expect(
      v.safeParse(
        RetentionMetadataSchema,
        allowedRetention({
          retentionMode: 'identifier_indefinite_owner_scoped',
          retentionUntil: null,
          freshUntil: null,
          displayUntil: null,
          deletionScheduledAt: null,
          displayPolicyStatus: 'available',
        }),
      ).success,
    ).toBe(false);
    expect(v.safeParse(RetentionMetadataSchema, deniedRetention()).success).toBe(true);
    expect(
      v.safeParse(RetentionMetadataSchema, deniedRetention({ retentionDecision: 'unknown' }))
        .success,
    ).toBe(true);
    expect(
      v.safeParse(RetentionMetadataSchema, deniedRetention({ restoreMode: 'full' })).success,
    ).toBe(false);
    expect(
      v.safeParse(RetentionMetadataSchema, deniedRetention({ retentionUntil: timestamp })).success,
    ).toBe(false);
  });

  it('requires explicit evidence and retention on generated text', () => {
    const textSchema = PublicEvidenceTextSchema(300);
    expect(
      v.safeParse(textSchema, {
        text: '候補です',
        evidenceIds: ['obs-1'],
        evidence: [evidence],
        basis: 'grounded',
        retention: allowedRetention(),
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(textSchema, {
        text: 'source allow, target deny',
        evidenceIds: ['obs-1'],
        evidence: [evidence],
        basis: 'grounded',
        retention: deniedRetention(),
      }).success,
    ).toBe(true);
    const unknownSource = {
      ...evidence,
      retention: deniedRetention({ retentionDecision: 'unknown' }),
    };
    expect(
      v.safeParse(textSchema, {
        text: 'provider由来',
        evidenceIds: ['obs-1'],
        evidence: [unknownSource],
        basis: 'grounded',
        retention: allowedRetention(),
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(textSchema, {
        text: 'provider由来の一時表示',
        evidenceIds: ['obs-1'],
        evidence: [unknownSource],
        basis: 'grounded',
        retention: deniedRetention({ retentionDecision: 'unknown' }),
      }).success,
    ).toBe(true);
    const unknownSourceWithLongerTarget = {
      ...evidence,
      retention: deniedRetention(),
    };
    expect(
      v.safeParse(textSchema, {
        text: '表示期限を延長',
        evidenceIds: ['obs-1'],
        evidence: [unknownSourceWithLongerTarget],
        basis: 'grounded',
        retention: deniedRetention({
          sessionExpiresAt: '2026-09-10T05:00:00+09:00',
          displayUntil: '2026-09-09T14:00:00Z',
        }),
      }).success,
    ).toBe(false);
    const hiddenSource = {
      ...evidence,
      retention: deniedRetention({ displayPolicyStatus: 'disabled_m35' }),
    };
    expect(
      v.safeParse(textSchema, {
        text: '表示禁止source',
        evidenceIds: ['obs-1'],
        evidence: [hiddenSource],
        basis: 'grounded',
        retention: deniedRetention({ displayPolicyStatus: 'available' }),
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(textSchema, {
        text: '根拠なし',
        evidenceIds: [],
        evidence: [],
        basis: 'conversational',
        retention: deniedRetention(),
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(textSchema, {
        text: '根拠なし',
        evidenceIds: ['obs-1'],
        evidence: [],
        basis: 'grounded',
        retention: allowedRetention(),
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(textSchema, {
        text: '保持情報なし',
        evidenceIds: ['obs-1'],
        evidence: [evidence],
        basis: 'grounded',
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(textSchema, {
        text: '未参照の根拠メタデータ',
        evidenceIds: ['obs-1'],
        evidence: [evidence, { ...evidence, evidenceId: 'obs-2' }],
        basis: 'grounded',
        retention: allowedRetention(),
      }).success,
    ).toBe(false);
  });

  it('keeps display fields explicit and rejects provider internals', () => {
    const displayField = DisplayFieldSchema(DisplayValueSchema);
    expect(
      v.safeParse(displayField, {
        status: 'known',
        value: {
          name: 'Melt',
          area: '恵比寿',
          address: null,
          category: 'cafe',
        },
        evidence: [evidence],
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(displayField, { status: 'not_applicable', reason: '電車移動なし' }).success,
    ).toBe(true);
    expect(
      v.safeParse(displayField, {
        status: 'known',
        value: {
          name: 'Melt',
          area: '恵比寿',
          address: null,
          category: 'cafe',
          providerRecordRef: 'must-not-cross-boundary',
        },
        evidence: [evidence],
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(displayField, {
        status: 'known',
        value: {
          name: 'Melt',
          area: '恵比寿',
          address: null,
          category: 'cafe',
        },
        evidence: [evidence, evidence],
      }).success,
    ).toBe(false);
  });
});
