/**
 * Candidate identity is captured at the provider/registry boundary.  Evaluation
 * deliberately joins on provider record identity; display names are not keys.
 */
export type RuntimeCandidateIdentity = {
  readonly provider: string;
  readonly recordRef: string;
  readonly candidateId: string;
};

export type EvaluationCandidateIdentity = {
  readonly provider: string;
  readonly recordRef: string;
  readonly evaluationCandidateId: string;
};

export type CandidateIdentityPair = {
  readonly provider: string;
  readonly recordRef: string;
  readonly runtimeCandidateId: string;
  readonly evaluationCandidateId: string;
};

export type CandidateIdentityMapping = {
  readonly ok: true;
  readonly pairs: readonly CandidateIdentityPair[];
  readonly byRuntimeCandidateId: ReadonlyMap<string, string>;
};

export type CandidateIdentityMappingFailure = {
  readonly ok: false;
  readonly code: 'CANDIDATE_ID_MAPPING_UNAVAILABLE' | 'CANDIDATE_ID_MAPPING_CONFLICT';
};

/**
 * Safe evidence join data captured from the model-visible projection. Values,
 * provider payloads, and display text are intentionally absent.
 */
export type RuntimeEvidenceReference = {
  readonly observationId: string;
  readonly candidateId: string;
  readonly field: string;
  readonly freshUntil?: string | null;
};

export type EvidenceReferenceCapture = {
  observe(value: unknown): void;
  snapshot(): readonly RuntimeEvidenceReference[];
  isUsable(): boolean;
};

export type CandidateIdentityCapture = {
  observe(value: unknown): void;
  snapshot(): readonly RuntimeCandidateIdentity[];
  isUsable(): boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isIdentity = (value: unknown): value is RuntimeCandidateIdentity =>
  isRecord(value) &&
  typeof value.provider === 'string' &&
  value.provider.length > 0 &&
  typeof value.recordRef === 'string' &&
  value.recordRef.length > 0 &&
  typeof value.candidateId === 'string' &&
  value.candidateId.length > 0;

const isBoundedText = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maxLength;

const isEvidenceReference = (value: unknown): value is RuntimeEvidenceReference =>
  isRecord(value) &&
  isBoundedText(value.observationId, 128) &&
  isBoundedText(value.candidateId, 128) &&
  isBoundedText(value.field, 64) &&
  (!('freshUntil' in value) || value.freshUntil === null || isBoundedText(value.freshUntil, 64));

const identityKey = (provider: string, recordRef: string): string =>
  JSON.stringify([provider, recordRef]);

/** Keeps only the fields needed for evaluation and marks malformed/conflicting observations. */
export const createCandidateIdentityCapture = (): CandidateIdentityCapture => {
  const byIdentity = new Map<string, RuntimeCandidateIdentity>();
  const byCandidate = new Map<string, string>();
  let invalid = false;

  return {
    observe(value: unknown): void {
      if (!isIdentity(value)) {
        invalid = true;
        return;
      }
      const key = identityKey(value.provider, value.recordRef);
      const existing = byIdentity.get(key);
      if (existing !== undefined && existing.candidateId !== value.candidateId) {
        invalid = true;
        return;
      }
      const previousKey = byCandidate.get(value.candidateId);
      if (previousKey !== undefined && previousKey !== key) {
        invalid = true;
        return;
      }
      byIdentity.set(key, {
        provider: value.provider,
        recordRef: value.recordRef,
        candidateId: value.candidateId,
      });
      byCandidate.set(value.candidateId, key);
    },
    snapshot(): readonly RuntimeCandidateIdentity[] {
      return [...byIdentity.values()];
    },
    isUsable(): boolean {
      return !invalid && byIdentity.size > 0;
    },
  };
};

/** Keeps only owner-bound observation identity; malformed observations stay unusable. */
export const createEvidenceReferenceCapture = (): EvidenceReferenceCapture => {
  const byObservation = new Map<string, RuntimeEvidenceReference>();
  let invalid = false;

  return {
    observe(value: unknown): void {
      if (!isEvidenceReference(value)) {
        invalid = true;
        return;
      }
      const existing = byObservation.get(value.observationId);
      if (
        existing !== undefined &&
        (existing.candidateId !== value.candidateId || existing.field !== value.field)
      ) {
        invalid = true;
        return;
      }
      if (
        existing?.freshUntil !== undefined &&
        value.freshUntil !== undefined &&
        existing.freshUntil !== value.freshUntil
      ) {
        invalid = true;
        return;
      }
      byObservation.set(value.observationId, {
        observationId: value.observationId,
        candidateId: value.candidateId,
        field: value.field,
        ...(value.freshUntil === undefined && existing?.freshUntil === undefined
          ? {}
          : { freshUntil: value.freshUntil ?? existing?.freshUntil ?? null }),
      });
    },
    snapshot(): readonly RuntimeEvidenceReference[] {
      return [...byObservation.values()];
    },
    isUsable(): boolean {
      return !invalid && byObservation.size > 0;
    },
  };
};

const validExpectedIdentity = (value: EvaluationCandidateIdentity): boolean =>
  value.provider.length > 0 && value.recordRef.length > 0 && value.evaluationCandidateId.length > 0;

/**
 * Joins the identities observed in one runtime attempt to the fixture dataset.
 * The expected table may be a superset for a limited search; every observed
 * identity must still join exactly, so a display-name coincidence cannot score.
 */
export const resolveCandidateIdentityMapping = (
  runtime: readonly RuntimeCandidateIdentity[],
  expected: readonly EvaluationCandidateIdentity[],
): CandidateIdentityMapping | CandidateIdentityMappingFailure => {
  if (runtime.length === 0 || expected.length === 0) {
    return { ok: false, code: 'CANDIDATE_ID_MAPPING_UNAVAILABLE' };
  }
  const runtimeByIdentity = new Map<string, RuntimeCandidateIdentity>();
  const runtimeIdentityByCandidate = new Map<string, string>();
  for (const identity of runtime) {
    if (!isIdentity(identity)) {
      return { ok: false, code: 'CANDIDATE_ID_MAPPING_CONFLICT' };
    }
    const key = identityKey(identity.provider, identity.recordRef);
    const prior = runtimeByIdentity.get(key);
    if (prior !== undefined && prior.candidateId !== identity.candidateId) {
      return { ok: false, code: 'CANDIDATE_ID_MAPPING_CONFLICT' };
    }
    const priorKey = runtimeIdentityByCandidate.get(identity.candidateId);
    if (priorKey !== undefined && priorKey !== key) {
      return { ok: false, code: 'CANDIDATE_ID_MAPPING_CONFLICT' };
    }
    runtimeByIdentity.set(key, identity);
    runtimeIdentityByCandidate.set(identity.candidateId, key);
  }

  const expectedByIdentity = new Map<string, EvaluationCandidateIdentity>();
  const expectedByCandidate = new Map<string, string>();
  for (const identity of expected) {
    if (!validExpectedIdentity(identity)) {
      return { ok: false, code: 'CANDIDATE_ID_MAPPING_CONFLICT' };
    }
    const key = identityKey(identity.provider, identity.recordRef);
    const prior = expectedByIdentity.get(key);
    if (prior !== undefined && prior.evaluationCandidateId !== identity.evaluationCandidateId) {
      return { ok: false, code: 'CANDIDATE_ID_MAPPING_CONFLICT' };
    }
    const priorKey = expectedByCandidate.get(identity.evaluationCandidateId);
    if (priorKey !== undefined && priorKey !== key) {
      return { ok: false, code: 'CANDIDATE_ID_MAPPING_CONFLICT' };
    }
    expectedByIdentity.set(key, identity);
    expectedByCandidate.set(identity.evaluationCandidateId, key);
  }

  const pairs: CandidateIdentityPair[] = [];
  const byRuntimeCandidateId = new Map<string, string>();
  for (const runtimeIdentity of runtimeByIdentity.values()) {
    const identity = expectedByIdentity.get(
      identityKey(runtimeIdentity.provider, runtimeIdentity.recordRef),
    );
    if (identity === undefined) {
      return { ok: false, code: 'CANDIDATE_ID_MAPPING_UNAVAILABLE' };
    }
    const pair = {
      provider: runtimeIdentity.provider,
      recordRef: runtimeIdentity.recordRef,
      runtimeCandidateId: runtimeIdentity.candidateId,
      evaluationCandidateId: identity.evaluationCandidateId,
    };
    pairs.push(pair);
    byRuntimeCandidateId.set(pair.runtimeCandidateId, pair.evaluationCandidateId);
  }
  return { ok: true, pairs, byRuntimeCandidateId };
};
