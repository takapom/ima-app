import type { EvaluationScenario, ScenarioId } from './types';

export type EvaluationExecutionProfile =
  | {
      readonly status: 'fixture_ready';
      readonly kind:
        'card_context' | 'same_do_continuity' | 'condition_context' | 'failure_response';
      readonly requiresApiKey: false;
    }
  | {
      readonly status: 'live_only';
      readonly kind: 'new_search' | 'prompt_injection';
      readonly requiresApiKey: true;
    }
  | {
      readonly status: 'unavailable';
      readonly reason:
        | 'CARD_SET_STATE_NOT_SEEDED'
        | 'CONDITION_STATE_NOT_SEEDED'
        | 'DETAILS_STATE_NOT_SEEDED'
        | 'EXPIRED_EVIDENCE_NOT_SEEDED'
        | 'FAILURE_PROFILE_NOT_CONFIGURED'
        | 'PROMPT_INJECTION_PROFILE_NOT_CONFIGURED'
        | 'LOCATION_POLICY_NOT_WIRED'
        | 'SAVED_REFERENCE_RESOLVER_NOT_WIRED';
      readonly requiresApiKey: false;
    };

const profiles: Record<ScenarioId, EvaluationExecutionProfile> = {
  'new-search': { status: 'live_only', kind: 'new_search', requiresApiKey: true },
  'condition-change': {
    status: 'fixture_ready',
    kind: 'condition_context',
    requiresApiKey: false,
  },
  reason: { status: 'fixture_ready', kind: 'card_context', requiresApiKey: false },
  compare: {
    status: 'fixture_ready',
    kind: 'card_context',
    requiresApiKey: false,
  },
  'specific-place': { status: 'fixture_ready', kind: 'card_context', requiresApiKey: false },
  'decide-action': {
    status: 'fixture_ready',
    kind: 'card_context',
    requiresApiKey: false,
  },
  'clarify-ambiguity': {
    status: 'fixture_ready',
    kind: 'card_context',
    requiresApiKey: false,
  },
  'candidate-failure': {
    status: 'fixture_ready',
    kind: 'failure_response',
    requiresApiKey: false,
  },
  'mixed-intent': {
    status: 'fixture_ready',
    kind: 'condition_context',
    requiresApiKey: false,
  },
  'prompt-injection': {
    status: 'unavailable',
    reason: 'PROMPT_INJECTION_PROFILE_NOT_CONFIGURED',
    requiresApiKey: false,
  },
  continuity: {
    status: 'fixture_ready',
    kind: 'same_do_continuity',
    requiresApiKey: false,
  },
  repair: {
    status: 'unavailable',
    reason: 'EXPIRED_EVIDENCE_NOT_SEEDED',
    requiresApiKey: false,
  },
  'gps-refusal': {
    status: 'unavailable',
    reason: 'LOCATION_POLICY_NOT_WIRED',
    requiresApiKey: false,
  },
  'saved-place-reference': {
    status: 'unavailable',
    reason: 'SAVED_REFERENCE_RESOLVER_NOT_WIRED',
    requiresApiKey: false,
  },
};

/** Returns the intentionally small execution contract for a dataset scenario. */
export const executionProfileFor = (
  scenario: Pick<EvaluationScenario, 'id'>,
): EvaluationExecutionProfile => profiles[scenario.id];
