import { describe, expect, it } from 'vitest';
import type { DetailField } from '@ima/core';
import {
  defaultRuntimeModelProjectionPolicy,
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
});
