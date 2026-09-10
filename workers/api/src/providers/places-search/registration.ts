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
};

/**
 * Host helper for the real Core registry. It deliberately does not provide the
 * registry object to the transport or adapter.
 */
export const createPlacesSearchRegistration = (
  options: PlacesSearchRegistrationOptions,
): PlacesSearchRegistration => ({
  registerCandidate: (input) => options.registry.registerCandidate(input),
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
