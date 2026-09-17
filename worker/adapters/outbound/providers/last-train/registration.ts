import * as v from 'valibot';
import {
  JOURNEY_VERIFICATION_MAX_AGE_MS,
  IsoTimestampSchema,
  LastTrainInfoSchema,
  ObservationContextSchema,
  ObservationSchema,
  OpaqueIdSchema,
  SourceRefSchema,
  type CandidateObservationRegistryPort,
  type ClockPort,
  type FieldResult,
  type HarnessContext,
  type Issue,
  type IsoTimestamp,
  type LastTrainInfo,
  type ObservationRegistration,
  type ObservationContext,
  type SourceRef,
} from '@ima/core';

export type LastTrainObservationInput = Omit<
  ObservationRegistration,
  'freshUntil' | 'expiresAt' | 'retention'
>;

export type LastTrainObservationPolicy = (input: {
  readonly now: string;
  readonly observation: LastTrainObservationInput;
}) => Pick<ObservationRegistration, 'freshUntil' | 'expiresAt' | 'retention'> | undefined;

export type LastTrainObservationRegistrar = {
  readonly reusable: (
    candidateId: string,
    context: HarnessContext,
  ) => FieldResult<LastTrainInfo> | undefined;
  readonly register: (
    candidateId: string,
    value: LastTrainInfo,
    context: HarnessContext,
    provenance: LastTrainObservationProvenance,
  ) => FieldResult<LastTrainInfo>;
};

export type LastTrainObservationProvenance = {
  readonly source: SourceRef;
  readonly verifiedAt: IsoTimestamp;
};

const issue = (code: Issue['code'], path: string, message: string): Issue => ({
  code,
  path,
  retryable: false,
  retryAfterMs: null,
  message,
  missingFields: [],
});

const error = (value: Issue): FieldResult<LastTrainInfo> => ({ status: 'error', error: value });

const observationContextFor = (
  context: HarnessContext,
  currentOriginRef: string,
): ObservationContext => ({
  ownerScopeRef: context.ownerScopeRef,
  threadId: context.threadId,
  capabilityVersion: context.capabilities.version,
  locationRevision: context.location.revision,
  originRef: currentOriginRef,
  homeStationRef: context.preferences.homeStationRef,
  minimumStayMinutes: context.preferences.minimumStayMinutes,
  timeContext: 'now',
});

const knownFromStored = (stored: unknown): FieldResult<LastTrainInfo> => {
  const parsed = v.safeParse(ObservationSchema(LastTrainInfoSchema), stored);
  return parsed.success
    ? { status: 'known', observations: [parsed.output] }
    : error(issue('SCHEMA_MISMATCH', 'last_train', 'stored last-train observation is invalid'));
};

const boundedTimestamp = (value: string, sourceBound: string): string => {
  const parsed = v.safeParse(IsoTimestampSchema, value);
  if (!parsed.success) return value;
  return Date.parse(parsed.output) <= Date.parse(sourceBound) ? parsed.output : sourceBound;
};

const boundedPolicy = (
  policy: Pick<ObservationRegistration, 'freshUntil' | 'expiresAt' | 'retention'>,
  sourceBound: string,
): Pick<ObservationRegistration, 'freshUntil' | 'expiresAt' | 'retention'> => ({
  freshUntil: boundedTimestamp(policy.freshUntil, sourceBound),
  expiresAt: boundedTimestamp(policy.expiresAt, sourceBound),
  retention: {
    ...policy.retention,
    sessionExpiresAt: boundedTimestamp(policy.retention.sessionExpiresAt, sourceBound),
    freshUntil:
      policy.retention.freshUntil === null
        ? null
        : boundedTimestamp(policy.retention.freshUntil, sourceBound),
    displayUntil:
      policy.retention.displayUntil === null
        ? null
        : boundedTimestamp(policy.retention.displayUntil, sourceBound),
    retentionUntil:
      policy.retention.retentionUntil === null
        ? null
        : boundedTimestamp(policy.retention.retentionUntil, sourceBound),
    deletionScheduledAt:
      policy.retention.deletionScheduledAt === null
        ? null
        : boundedTimestamp(policy.retention.deletionScheduledAt, sourceBound),
  },
});

export const createLastTrainObservationRegistrar = (options: {
  readonly registry: CandidateObservationRegistryPort;
  readonly clock: ClockPort;
  readonly currentOriginRef: string;
  readonly observationPolicy: LastTrainObservationPolicy;
}): LastTrainObservationRegistrar => {
  const reusable = (
    candidateId: string,
    context: HarnessContext,
  ): FieldResult<LastTrainInfo> | undefined => {
    const parsedContext = v.safeParse(
      ObservationContextSchema,
      observationContextFor(context, options.currentOriginRef),
    );
    if (!parsedContext.success) {
      return error(issue('MISSING_CONTEXT', 'last_train', 'observation context is unavailable'));
    }
    try {
      const result = options.registry.evaluateObservationReuse({
        scope: { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
        candidateId,
        field: 'last_train',
        context: parsedContext.output,
      });
      return result.status === 'reusable' ? knownFromStored(result.observation) : undefined;
    } catch {
      return error(issue('MISSING_CONTEXT', 'last_train', 'observation registry is unavailable'));
    }
  };

  const register = (
    candidateId: string,
    value: LastTrainInfo,
    context: HarnessContext,
    provenance: LastTrainObservationProvenance,
  ): FieldResult<LastTrainInfo> => {
    const now = options.clock.now();
    const parsedNow = v.safeParse(IsoTimestampSchema, now);
    if (!parsedNow.success)
      return error(issue('MISSING_CONTEXT', 'last_train', 'clock is invalid'));
    const parsedProvenanceTime = v.safeParse(IsoTimestampSchema, provenance.verifiedAt);
    if (
      !parsedProvenanceTime.success ||
      Date.parse(parsedProvenanceTime.output) > Date.parse(parsedNow.output) ||
      !v.safeParse(SourceRefSchema, provenance.source).success
    ) {
      return error(issue('MISSING_CONTEXT', 'last_train', 'journey source is unavailable'));
    }
    if (!v.safeParse(OpaqueIdSchema, options.currentOriginRef).success) {
      return error(issue('MISSING_CONTEXT', 'last_train', 'current origin is unavailable'));
    }
    const parsedValue = v.safeParse(LastTrainInfoSchema, value);
    if (!parsedValue.success) {
      return error(issue('SCHEMA_MISMATCH', 'last_train', 'computed last-train value is invalid'));
    }
    const observationContext = observationContextFor(context, options.currentOriginRef);
    if (!v.safeParse(ObservationContextSchema, observationContext).success) {
      return error(issue('MISSING_CONTEXT', 'last_train', 'observation context is unavailable'));
    }
    const observation: LastTrainObservationInput = {
      scope: { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
      candidateId,
      field: 'last_train',
      value: parsedValue.output,
      basis: 'computed',
      sourceUpdatedAt: parsedProvenanceTime.output,
      context: observationContext,
      sources: [provenance.source],
    };
    let policy;
    try {
      policy = options.observationPolicy({ now: parsedNow.output, observation });
      if (policy === undefined) {
        return error(issue('MISSING_CONTEXT', 'last_train', 'retention policy is unavailable'));
      }
      const verificationBound =
        Date.parse(parsedProvenanceTime.output) + JOURNEY_VERIFICATION_MAX_AGE_MS;
      const departureBound = Date.parse(parsedValue.output.lastDepartureAt);
      const sourceBound = new Date(Math.min(verificationBound, departureBound)).toISOString();
      const bounded = boundedPolicy(policy, sourceBound);
      const stored = options.registry.registerObservation({ ...observation, ...bounded });
      const restored = options.registry.restoreObservationReuse(
        { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
        candidateId,
        'last_train',
        [stored.observationId],
      );
      if (!restored) {
        return error(issue('MISSING_CONTEXT', 'last_train', 'observation reuse is unavailable'));
      }
      return knownFromStored(stored);
    } catch {
      return error(issue('MISSING_CONTEXT', 'last_train', 'observation registration failed'));
    }
  };

  return { reusable, register };
};
