import { describe, expect, it } from 'vitest';
import type { JSONValue } from 'ai';
import type { DetailField } from '@ima/core';
import {
  defaultRuntimeModelContextPolicy,
  defaultRuntimeModelProjectionPolicy,
  projectRuntimeToolResultForModel,
  runtimePolicyAllows,
  toModelContextFieldPolicy,
  type RuntimeFieldUsePolicy,
  type RuntimePolicyRecord,
  type RuntimeModelProjectionPolicyInput,
} from '../../src/runtime/runtime-field-policy';

const record = (overrides: Partial<RuntimePolicyRecord> = {}): RuntimePolicyRecord => ({
  decision: 'allow',
  activation: 'fixture_only',
  fieldStatus: 'known',
  policyStatus: 'available',
  ...overrides,
});

const uses = (overrides: Partial<RuntimeFieldUsePolicy> = {}): RuntimeFieldUsePolicy => ({
  llm_input: record(),
  display: record(),
  persistence: record(),
  ...overrides,
});

const allFields = (policy: RuntimeFieldUsePolicy): Record<DetailField, RuntimeFieldUsePolicy> => ({
  identity: policy,
  opening_hours: policy,
  price: policy,
  photos: policy,
  contact: policy,
  facilities: policy,
  walking_route: policy,
  last_train: policy,
});

describe('runtime field policy', () => {
  it('requires a known, available policy and the matching activation profile', () => {
    const policy = uses({
      llm_input: record({ activation: 'fixture_only' }),
      display: record({ activation: 'live_verified' }),
      persistence: record({ decision: 'unknown' }),
    });

    expect(runtimePolicyAllows(policy, 'llm_input', 'fixture')).toBe(true);
    expect(runtimePolicyAllows(policy, 'llm_input', 'live')).toBe(false);
    expect(runtimePolicyAllows(policy, 'display', 'live')).toBe(true);
    expect(runtimePolicyAllows(policy, 'persistence', 'fixture')).toBe(false);
    expect(
      runtimePolicyAllows(
        uses({ llm_input: record({ fieldStatus: 'unknown' }) }),
        'llm_input',
        'fixture',
      ),
    ).toBe(false);
    expect(
      runtimePolicyAllows(
        uses({ llm_input: record({ activation: 'disabled_until_m35' }) }),
        'llm_input',
        'fixture',
      ),
    ).toBe(false);
  });

  it('maps each evaluated field independently and keeps production default denied', () => {
    const input: RuntimeModelProjectionPolicyInput = {
      evidence: {
        ...allFields(uses({ llm_input: record({ decision: 'unknown' }) })),
        identity: uses({ llm_input: record() }),
      },
      history: uses({ llm_input: record() }),
      cardSet: uses({ llm_input: record({ activation: 'disabled_until_m35' }) }),
      displayName: uses({ llm_input: record({ decision: 'deny' }) }),
    };
    const projected = toModelContextFieldPolicy(input, 'fixture');

    expect(projected.evidence.identity).toBe('allow');
    expect(projected.evidence.opening_hours).toBe('deny');
    expect(projected.history).toBe('allow');
    expect(projected.cardSet).toBe('deny');
    expect(projected.displayName).toBe('deny');
    expect(
      runtimePolicyAllows(defaultRuntimeModelProjectionPolicy.evidence.identity, 'display', 'live'),
    ).toBe(false);
  });

  it('preserves Core location errors while sanitizing their details', () => {
    const projected = projectRuntimeToolResultForModel(
      {
        status: 'error',
        error: {
          code: 'LOCATION_REQUIRED',
          path: 'location',
          retryable: false,
          retryAfterMs: null,
          message: 'coordinates must not reach the model',
          missingFields: ['location'],
        },
      } as const,
      defaultRuntimeModelContextPolicy,
    );
    expect(projected).toEqual({
      status: 'error',
      error: {
        code: 'LOCATION_REQUIRED',
        path: null,
        retryable: false,
        retryAfterMs: null,
        message: 'tool result is unavailable',
        missingFields: [],
      },
    });

    const unknown = projectRuntimeToolResultForModel(
      {
        status: 'error',
        error: {
          code: 'PROVIDER_SECRET_LEAK',
          path: 'provider',
          retryable: false,
          retryAfterMs: null,
          message: 'private detail',
          missingFields: [],
        },
      } as const,
      defaultRuntimeModelContextPolicy,
    );
    expect(unknown).toMatchObject({ status: 'error', error: { code: 'UPSTREAM_UNAVAILABLE' } });
  });

  it('projects search and details results by field and drops unrecognized payloads', () => {
    const observation = (id: string, field: DetailField, value: JSONValue) => ({
      observationId: id,
      candidateId: 'candidate-policy',
      field,
      value,
      basis: 'provider_reported' as const,
      fetchedAt: '2026-09-10T00:00:00.000Z',
      sourceUpdatedAt: null,
      expiresAt: '2026-09-10T02:00:00.000Z',
      freshUntil: '2026-09-10T01:00:00.000Z',
      sources: [{ provider: 'google_places', attribution: null, publicUrl: null }],
    });
    const identityValue = {
      name: 'Cafe',
      area: '渋谷',
      address: null,
      category: 'cafe',
      businessStatus: 'operational' as const,
      sourceUrl: null,
    };
    const priceValue = { level: 2, range: null, rawLabel: 'secret-price' };
    const input: RuntimeModelProjectionPolicyInput = {
      evidence: {
        ...allFields(uses()),
        price: uses({ llm_input: record({ decision: 'deny' }) }),
      },
      history: uses(),
      cardSet: uses(),
      displayName: uses(),
    };
    const policy = toModelContextFieldPolicy(input, 'fixture');
    const projected = projectRuntimeToolResultForModel(
      {
        status: 'ok',
        data: {
          searchId: 'search-policy',
          candidates: [
            {
              candidateId: 'candidate-policy',
              displayName: 'provider display canary',
              identity: {
                status: 'known',
                observations: [observation('observation-identity', 'identity', identityValue)],
              },
              openingHours: { status: 'unknown', reason: 'provider canary' },
              price: {
                status: 'known',
                observations: [observation('observation-price', 'price', priceValue)],
              },
            },
          ],
          applied: { areaDescription: '検索結果の地域', openNow: true, excludedCount: 0 },
          nextCursor: null,
          coverage: 'provider_results',
        },
        warnings: [{ code: 'UPSTREAM_UNAVAILABLE', message: 'warning canary' }],
      },
      policy,
    );

    expect(JSON.stringify(projected)).toContain('Cafe');
    expect(JSON.stringify(projected)).not.toContain('secret-price');
    expect(JSON.stringify(projected)).not.toContain('provider display canary');
    expect(JSON.stringify(projected)).not.toContain('provider canary');
    expect(JSON.stringify(projected)).not.toContain('warning canary');
    expect(projected).toMatchObject({
      data: {
        candidates: [
          {
            identity: { status: 'known' },
            price: { status: 'withheld' },
          },
        ],
      },
    });

    const mixed = {
      status: 'ok',
      data: {
        items: [
          {
            candidateId: 'candidate-policy',
            fields: {
              identity: {
                status: 'known',
                observations: [
                  observation('observation-mixed-1', 'identity', identityValue),
                  observation('observation-mixed-2', 'price', {
                    level: 2,
                    range: null,
                    rawLabel: 'mixed-secret',
                  }),
                ],
              },
            },
          },
        ],
      },
      warnings: [],
    };
    expect(JSON.stringify(projectRuntimeToolResultForModel(mixed, policy))).not.toContain(
      'mixed-secret',
    );
  });
});
