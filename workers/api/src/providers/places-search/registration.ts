import type {
  CandidateObservationRegistryPort,
  CandidateRecord,
  CandidateRegistration,
  ClockPort,
  ObservationRegistration,
  ReadonlyStoredObservation,
} from '@ima/core';

/**
 * The adapter receives callbacks instead of a registry object. The Host owns the
 * registry lifetime, policy decision, and ID allocation behind these callbacks.
 */
export type PlacesSearchObservationInput = Omit<
  ObservationRegistration,
  'freshUntil' | 'expiresAt' | 'retention'
>;

export type PlacesSearchObservationPolicy = (input: {
  readonly now: string;
  readonly observation: PlacesSearchObservationInput;
}) => Pick<ObservationRegistration, 'freshUntil' | 'expiresAt' | 'retention'> | undefined;

export type PlacesSearchRegistration = {
  readonly registerCandidate: (
    input: CandidateRegistration,
  ) => Readonly<CandidateRecord> | undefined;
  readonly registerObservation: (
    input: PlacesSearchObservationInput,
  ) => ReadonlyStoredObservation | undefined;
};

export type PlacesSearchRegistrationOptions = {
  readonly registry: CandidateObservationRegistryPort;
  readonly clock: ClockPort;
  /** Returning undefined withholds provider payload under the active policy. */
  readonly observationPolicy: PlacesSearchObservationPolicy;
  /** Host-only identity hook; display fields are not required by the observer. */
  readonly observeCandidate?: (
    record: Pick<CandidateRecord, 'provider' | 'recordRef' | 'candidateId'>,
  ) => void;
};

/**
 * Host helper for the real Core registry. It deliberately does not provide the
 * registry object to the transport or adapter.
 */
export const createPlacesSearchRegistration = (
  options: PlacesSearchRegistrationOptions,
): PlacesSearchRegistration => ({
  registerCandidate: (input) => {
    const record = options.registry.registerCandidate(input);
    try {
      options.observeCandidate?.({
        provider: record.provider,
        recordRef: record.recordRef,
        candidateId: record.candidateId,
      });
    } catch {
      // Identity observation is diagnostic and must not change a successful registration.
    }
    return record;
  },
  registerObservation: (input) => {
    const policy = options.observationPolicy({
      now: options.clock.now(),
      observation: input,
    });
    if (policy === undefined) {
      throw new Error('places search observation policy is unavailable');
    }
    return options.registry.registerObservation({
      ...input,
      ...policy,
    });
  },
});
