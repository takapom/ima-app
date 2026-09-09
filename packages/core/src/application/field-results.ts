import * as v from 'valibot';
import {
  RegistryScopeSchema,
  type ObservationContext,
  type RegistryScope,
} from '../domain/freshness';
import {
  AnyStoredFieldResultSchema,
  type CandidateFieldResultRecord,
  type StoredFieldResult,
} from '../domain/continuity';
import { RegistryError, type ReadonlyStoredObservation } from '../domain/registry';
import { CandidateIdSchema, DetailFieldSchema, type CandidateId } from '../domain/primitives';
import type { CandidateObservationRegistryPort } from '../ports/registry';
import type { CandidateFieldResultPort } from '../ports/continuity';

const resultKey = (scope: RegistryScope, candidateId: CandidateId, field: string): string =>
  JSON.stringify([scope.ownerScopeRef, scope.threadId, candidateId, field]);

const freezeResult = (result: StoredFieldResult): StoredFieldResult => {
  if (result.status === 'known') {
    return Object.freeze({
      status: 'known',
      observations: Object.freeze([...result.observations]),
    });
  }
  if (result.status === 'error') {
    return Object.freeze({
      status: 'error',
      error: Object.freeze({
        ...result.error,
        missingFields: Object.freeze([...result.error.missingFields]),
      }),
    });
  }
  return Object.freeze({ ...result });
};

/** Keeps field-level partial outcomes without collapsing them into missing values. */
export class CandidateFieldResultRegistry implements CandidateFieldResultPort {
  private readonly records = new Map<string, Readonly<CandidateFieldResultRecord>>();

  constructor(private readonly candidates: CandidateObservationRegistryPort) {}

  registerFieldResult(
    scope: RegistryScope,
    candidateId: CandidateId,
    field: string,
    result: unknown,
  ): Readonly<CandidateFieldResultRecord> {
    if (!v.safeParse(RegistryScopeSchema, scope).success) {
      throw new RegistryError('INVALID_ARGUMENT', 'field result scope is invalid');
    }
    if (!v.safeParse(CandidateIdSchema, candidateId).success) {
      throw new RegistryError('INVALID_ARGUMENT', 'field result candidate ID is invalid');
    }
    const parsedField = v.safeParse(DetailFieldSchema, field);
    if (!parsedField.success) {
      throw new RegistryError('INVALID_ARGUMENT', 'field result field is invalid');
    }
    if (this.candidates.readCandidate(scope, candidateId) === undefined) {
      throw new RegistryError('UNKNOWN_CANDIDATE', 'field result candidate is not in this scope');
    }
    const parsedResult = v.safeParse(AnyStoredFieldResultSchema, result);
    if (!parsedResult.success) {
      throw new RegistryError('INVALID_ARGUMENT', 'field result payload is invalid');
    }

    const normalized = this.normalizeKnownObservations(
      scope,
      candidateId,
      parsedField.output,
      parsedResult.output,
    );
    if (normalized.status === 'known') {
      const restored = this.candidates.restoreObservationReuse(
        scope,
        candidateId,
        parsedField.output,
        normalized.observations.map((observation) => observation.observationId),
      );
      if (!restored) {
        throw new RegistryError(
          'INVALID_OBSERVATION',
          'known field result must contain a new observation after invalidation',
        );
      }
    } else {
      this.candidates.invalidateObservationReuse(scope, candidateId, parsedField.output);
    }
    const record: CandidateFieldResultRecord = {
      scope: Object.freeze({ ...scope }),
      candidateId,
      field: parsedField.output,
      result: freezeResult(normalized),
    };
    const stored = Object.freeze(record);
    this.records.set(resultKey(scope, candidateId, parsedField.output), stored);
    return stored;
  }

  readFieldResult(
    scope: RegistryScope,
    candidateId: CandidateId,
    field: string,
  ): Readonly<CandidateFieldResultRecord> | undefined {
    if (!v.safeParse(RegistryScopeSchema, scope).success) return undefined;
    if (!v.safeParse(CandidateIdSchema, candidateId).success) return undefined;
    const parsedField = v.safeParse(DetailFieldSchema, field);
    if (!parsedField.success) return undefined;
    if (this.candidates.readCandidate(scope, candidateId) === undefined) return undefined;
    return this.records.get(resultKey(scope, candidateId, parsedField.output));
  }

  listFieldResults(
    scope: RegistryScope,
    candidateId: CandidateId,
  ): readonly Readonly<CandidateFieldResultRecord>[] {
    if (this.candidates.readCandidate(scope, candidateId) === undefined) return [];
    return [...this.records.values()].filter(
      (record) =>
        record.scope.ownerScopeRef === scope.ownerScopeRef &&
        record.scope.threadId === scope.threadId &&
        record.candidateId === candidateId,
    );
  }

  /** Gates observation reuse on the latest field outcome; unavailable/error never fall back. */
  findReusableObservation(
    scope: RegistryScope,
    candidateId: CandidateId,
    field: string,
    context: ObservationContext,
  ): ReadonlyStoredObservation | undefined {
    const record = this.readFieldResult(scope, candidateId, field);
    if (record?.result.status !== 'known') return undefined;
    const reuse = this.candidates.evaluateObservationReuse({
      scope,
      candidateId,
      field: record.field,
      context,
    });
    if (reuse.status !== 'reusable') return undefined;
    return record.result.observations.some(
      (observation) => observation.observationId === reuse.observation.observationId,
    )
      ? reuse.observation
      : undefined;
  }

  private normalizeKnownObservations(
    scope: RegistryScope,
    candidateId: CandidateId,
    field: string,
    result: v.InferOutput<typeof AnyStoredFieldResultSchema>,
  ): StoredFieldResult {
    if (result.status !== 'known') {
      if (result.status === 'error') {
        return {
          status: 'error',
          error: { ...result.error, missingFields: [...result.error.missingFields] },
        };
      }
      return { status: result.status, reason: result.reason };
    }
    const observations = result.observations.map((observation) => {
      if (observation.candidateId !== candidateId || observation.field !== field) {
        throw new RegistryError(
          'INVALID_OBSERVATION',
          'field result observation does not match its candidate and field',
        );
      }
      const stored = this.candidates.readObservation(scope, observation.observationId);
      if (stored === undefined) {
        throw new RegistryError(
          'INVALID_OBSERVATION',
          'field result observation is not registered',
        );
      }
      if (stored.candidateId !== candidateId || stored.field !== field) {
        throw new RegistryError(
          'INVALID_OBSERVATION',
          'registered observation does not match its candidate and field',
        );
      }
      return stored;
    });
    return { status: 'known', observations };
  }
}
