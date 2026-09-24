import type { CandidateObservationRegistryPort } from '@worker/application/ports/registry';
import type { RegistryScope } from '@worker/domain/evidence/freshness';
import {
  capRetention,
  narrowRetention,
  type RetentionMetadata,
} from '@worker/domain/evidence/retention';

/**
 * What the model was shown while generating one response. It bounds how long the generated text
 * may be displayed and kept; it does not claim that the text is supported by, or used, any of it.
 * The bound is folded as inputs arrive, so no count limit can drop a stricter input.
 */
export type RuntimePresentedInputs = {
  /** A provider observation whose content reached the model; the registry supplies its policy. */
  readonly observation: (observationId: string) => void;
  /** Content that reached the model with its own retention, e.g. context evidence or history. */
  readonly retention: (retention: RetentionMetadata) => void;
  /** Quoted content that carries only an expiry, e.g. an earlier conversation's message. */
  readonly deadline: (at: string) => void;
  /** Content whose origin cannot be established; the text then is never stored. */
  readonly unresolved: () => void;
  /** `base` is the app and conversation policy for the turn; the result is never looser. */
  readonly textRetention: (base: RetentionMetadata) => RetentionMetadata;
};

/** Displayable for the session, but never stored: the origin of some input is unknown. */
const unknownOrigin = (sessionExpiresAt: string): RetentionMetadata => ({
  retentionDecision: 'unknown',
  retentionMode: 'session_only',
  sessionExpiresAt,
  freshUntil: null,
  displayUntil: null,
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only',
  policyStatus: 'policy_withheld',
  displayPolicyStatus: 'available',
});

export const createRuntimePresentedInputs = (input: {
  readonly registry: Pick<CandidateObservationRegistryPort, 'readObservation'>;
  readonly scope: RegistryScope;
}): RuntimePresentedInputs => {
  const observations = new Set<string>();
  let narrowed: RetentionMetadata | undefined;
  let deadline: string | undefined;
  let unresolved = false;
  const retention = (next: RetentionMetadata) => {
    narrowed = narrowed === undefined ? next : narrowRetention(narrowed, [next]);
  };
  return {
    observation: (observationId) => {
      if (observations.has(observationId)) return;
      observations.add(observationId);
      const stored = input.registry.readObservation(input.scope, observationId);
      if (
        stored === undefined ||
        stored.context.ownerScopeRef !== input.scope.ownerScopeRef ||
        stored.context.threadId !== input.scope.threadId
      ) {
        unresolved = true;
        return;
      }
      retention(stored.retention);
    },
    retention,
    deadline: (at) => {
      if (Number.isNaN(Date.parse(at))) {
        unresolved = true;
        return;
      }
      if (deadline === undefined || Date.parse(at) < Date.parse(deadline)) deadline = at;
    },
    unresolved: () => {
      unresolved = true;
    },
    textRetention: (base) => {
      let result = narrowRetention(base, narrowed === undefined ? [] : [narrowed]);
      if (deadline !== undefined) result = capRetention(result, deadline);
      return unresolved
        ? narrowRetention(result, [unknownOrigin(result.sessionExpiresAt)])
        : result;
    },
  };
};
