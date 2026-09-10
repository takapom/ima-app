import type { DetailField, ModelContextFieldDecision, ModelContextFieldPolicy } from '@ima/core';

export type RuntimePolicyMode = 'fixture' | 'live';
export type RuntimeFieldUse = 'llm_input' | 'display' | 'persistence';
export type RuntimePolicyDecision = 'allow' | 'deny' | 'unknown';
export type RuntimePolicyActivation = 'fixture_only' | 'disabled_until_m35' | 'live_verified';
export type RuntimeFieldStatus = 'known' | 'unknown' | 'unsupported' | 'error';
export type RuntimePolicyStatus =
  | 'available'
  | 'policy_withheld'
  | 'disabled_m35'
  | 'disabled_capability'
  | 'attribution_missing'
  | 'expired';

/** One provider field's decision for one use. The three uses never inherit each other. */
export type RuntimePolicyRecord = {
  readonly decision: RuntimePolicyDecision;
  readonly activation: RuntimePolicyActivation;
  readonly fieldStatus: RuntimeFieldStatus;
  readonly policyStatus: RuntimePolicyStatus;
};

export type RuntimeFieldUsePolicy = {
  readonly llm_input: RuntimePolicyRecord;
  readonly display: RuntimePolicyRecord;
  readonly persistence: RuntimePolicyRecord;
};

/** Host input for model projection; evidence remains field-specific. */
export type RuntimeModelProjectionPolicyInput = {
  readonly evidence: Readonly<Record<DetailField, RuntimeFieldUsePolicy>>;
  readonly history: RuntimeFieldUsePolicy;
  readonly cardSet: RuntimeFieldUsePolicy;
  readonly displayName: RuntimeFieldUsePolicy;
};

/** Shared by response/photo adapters so display and persistence do not reuse LLM decisions. */
export const runtimePolicyAllows = (
  policy: RuntimeFieldUsePolicy,
  use: RuntimeFieldUse,
  mode: RuntimePolicyMode,
): boolean => {
  const record = policy[use];
  if (record.decision !== 'allow' || record.fieldStatus !== 'known') return false;
  if (record.policyStatus !== 'available') return false;
  if (record.activation === 'disabled_until_m35') return false;
  if (record.activation === 'fixture_only') return mode === 'fixture';
  return record.activation === 'live_verified';
};

const modelDecision = (
  policy: RuntimeFieldUsePolicy,
  mode: RuntimePolicyMode,
): ModelContextFieldDecision => (runtimePolicyAllows(policy, 'llm_input', mode) ? 'allow' : 'deny');

/** Converts an evaluated Worker snapshot to the Core model-input contract. */
export const toModelContextFieldPolicy = (
  input: RuntimeModelProjectionPolicyInput,
  mode: RuntimePolicyMode,
): ModelContextFieldPolicy => ({
  evidence: {
    identity: modelDecision(input.evidence.identity, mode),
    opening_hours: modelDecision(input.evidence.opening_hours, mode),
    price: modelDecision(input.evidence.price, mode),
    photos: modelDecision(input.evidence.photos, mode),
    contact: modelDecision(input.evidence.contact, mode),
    facilities: modelDecision(input.evidence.facilities, mode),
    walking_route: modelDecision(input.evidence.walking_route, mode),
    last_train: modelDecision(input.evidence.last_train, mode),
  },
  history: modelDecision(input.history, mode),
  cardSet: modelDecision(input.cardSet, mode),
  displayName: modelDecision(input.displayName, mode),
});

const disabledRecord = (): RuntimePolicyRecord => ({
  decision: 'unknown',
  activation: 'disabled_until_m35',
  fieldStatus: 'unknown',
  policyStatus: 'disabled_m35',
});

const disabledUses = (): RuntimeFieldUsePolicy => ({
  llm_input: disabledRecord(),
  display: disabledRecord(),
  persistence: disabledRecord(),
});

/** Production default. No provider field reaches a model or display until a host snapshot allows it. */
export const defaultRuntimeModelProjectionPolicy: RuntimeModelProjectionPolicyInput = {
  evidence: {
    identity: disabledUses(),
    opening_hours: disabledUses(),
    price: disabledUses(),
    photos: disabledUses(),
    contact: disabledUses(),
    facilities: disabledUses(),
    walking_route: disabledUses(),
    last_train: disabledUses(),
  },
  history: disabledUses(),
  cardSet: disabledUses(),
  displayName: disabledUses(),
};

export const defaultRuntimeModelContextPolicy = toModelContextFieldPolicy(
  defaultRuntimeModelProjectionPolicy,
  'live',
);
