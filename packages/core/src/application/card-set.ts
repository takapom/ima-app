import * as v from 'valibot';
import { RegistryScopeSchema, type RegistryScope } from '../domain/freshness';
import {
  CardSetError,
  CardSetRecordSchema,
  CardSetRegistrationSchema,
  type CardSetRecord,
  type CardSetRegistration,
} from '../domain/continuity';
import { CardSetIdSchema, type CandidateId, type CardSetId } from '../domain/primitives';
import type { CandidateObservationRegistryPort } from '../ports/registry';
import type { CardSetIdPort } from '../ports/context';
import type { CardSetPort } from '../ports/continuity';

const cardSetKey = (scope: RegistryScope, cardSetId: CardSetId): string =>
  JSON.stringify([scope.ownerScopeRef, scope.threadId, cardSetId]);

const freezeRecord = (record: CardSetRecord): Readonly<CardSetRecord> =>
  Object.freeze({
    ...record,
    scope: Object.freeze({ ...record.scope }),
    entries: Object.freeze(record.entries.map((entry) => Object.freeze({ ...entry }))),
    excludedCandidateIds: Object.freeze([...record.excludedCandidateIds]),
  });

const generatedCardSetId = (value: string, used: ReadonlySet<string>): CardSetId => {
  const parsed = v.safeParse(CardSetIdSchema, value);
  if (!parsed.success) throw new CardSetError('INVALID_ARGUMENT', 'cardSet ID is invalid');
  if (used.has(parsed.output))
    throw new CardSetError('INVALID_ARGUMENT', 'cardSet ID is already in use');
  return parsed.output;
};

/** Owns display order and user state, propagating explicit exclusion to the candidate registry. */
export class CardSetRegistry implements CardSetPort {
  private readonly records = new Map<string, Readonly<CardSetRecord>>();

  constructor(
    private readonly ids: CardSetIdPort,
    private readonly candidates: CandidateObservationRegistryPort,
  ) {}

  createCardSet(input: CardSetRegistration): Readonly<CardSetRecord> {
    const parsed = v.safeParse(CardSetRegistrationSchema, input);
    if (!parsed.success) throw new CardSetError('INVALID_ARGUMENT', 'card set input is invalid');
    const registration = parsed.output;
    for (const candidateId of registration.candidateIds) {
      const candidate = this.candidates.readCandidate(registration.scope, candidateId);
      if (candidate === undefined)
        throw new CardSetError('CANDIDATE_NOT_IN_SET', 'candidate is not registered in this scope');
      if (candidate.excluded)
        throw new CardSetError('EXCLUDED_CANDIDATE', 'excluded candidate cannot enter a card set');
    }

    const cardSetId = generatedCardSetId(this.ids.nextCardSetId(), new Set(this.cardSetIds()));
    const record = freezeRecord({
      cardSetId,
      scope: registration.scope,
      responseId: registration.responseId,
      entries: registration.candidateIds.map((candidateId, displayOrder) => ({
        candidateId,
        displayOrder,
        role: displayOrder === 0 ? 'hero' : 'alt',
      })),
      selectedCandidateId: null,
      excludedCandidateIds: [],
    });
    if (!v.safeParse(CardSetRecordSchema, record).success) {
      throw new CardSetError('INVALID_ARGUMENT', 'card set state is inconsistent');
    }
    this.records.set(cardSetKey(registration.scope, cardSetId), record);
    return record;
  }

  readCardSet(scope: RegistryScope, cardSetId: CardSetId): Readonly<CardSetRecord> | undefined {
    if (!v.safeParse(RegistryScopeSchema, scope).success) return undefined;
    if (!v.safeParse(CardSetIdSchema, cardSetId).success) return undefined;
    return this.records.get(cardSetKey(scope, cardSetId));
  }

  selectCard(
    scope: RegistryScope,
    cardSetId: CardSetId,
    candidateId: CandidateId,
  ): Readonly<CardSetRecord> {
    const record = this.requireCardSet(scope, cardSetId);
    this.requireEntry(record, candidateId);
    const candidate = this.candidates.readCandidate(scope, candidateId);
    if (candidate === undefined)
      throw new CardSetError('CANDIDATE_NOT_IN_SET', 'candidate is not registered in this scope');
    if (candidate.excluded || record.excludedCandidateIds.includes(candidateId)) {
      throw new CardSetError('EXCLUDED_CANDIDATE', 'excluded candidate cannot be selected');
    }
    if (record.selectedCandidateId === candidateId) return record;
    return this.replace(record, { selectedCandidateId: candidateId });
  }

  excludeCard(
    scope: RegistryScope,
    cardSetId: CardSetId,
    candidateId: CandidateId,
  ): Readonly<CardSetRecord> {
    const record = this.requireCardSet(scope, cardSetId);
    this.requireEntry(record, candidateId);
    const candidate = this.candidates.readCandidate(scope, candidateId);
    if (candidate === undefined)
      throw new CardSetError('CANDIDATE_NOT_IN_SET', 'candidate is not registered in this scope');
    if (record.excludedCandidateIds.includes(candidateId)) {
      if (!candidate.excluded) this.candidates.excludeCandidate(scope, candidateId);
      return record;
    }
    return this.replace(
      record,
      {
        excludedCandidateIds: [...record.excludedCandidateIds, candidateId],
        selectedCandidateId:
          record.selectedCandidateId === candidateId ? null : record.selectedCandidateId,
      },
      candidateId,
    );
  }

  private replace(
    record: Readonly<CardSetRecord>,
    changes:
      Pick<CardSetRecord, 'selectedCandidateId' | 'excludedCandidateIds'> | Partial<CardSetRecord>,
    excludedCandidateId?: CandidateId,
  ): Readonly<CardSetRecord> {
    const updated = freezeRecord({ ...record, ...changes });
    if (!v.safeParse(CardSetRecordSchema, updated).success) {
      throw new CardSetError('INVALID_ARGUMENT', 'card set state is inconsistent');
    }
    if (excludedCandidateId !== undefined) {
      const candidate = this.candidates.readCandidate(record.scope, excludedCandidateId);
      if (candidate === undefined) {
        throw new CardSetError('CANDIDATE_NOT_IN_SET', 'candidate is not registered in this scope');
      }
      if (!candidate.excluded) this.candidates.excludeCandidate(record.scope, excludedCandidateId);
    }
    this.records.set(cardSetKey(record.scope, record.cardSetId), updated);
    return updated;
  }

  private requireCardSet(scope: RegistryScope, cardSetId: CardSetId): Readonly<CardSetRecord> {
    if (!v.safeParse(RegistryScopeSchema, scope).success) {
      throw new CardSetError('INVALID_ARGUMENT', 'card set scope is invalid');
    }
    const record = this.records.get(cardSetKey(scope, cardSetId));
    if (record !== undefined) return record;
    const sameId = [...this.records.values()].find((item) => item.cardSetId === cardSetId);
    if (sameId === undefined)
      throw new CardSetError('UNKNOWN_CARD_SET', 'card set is not registered');
    if (sameId.scope.ownerScopeRef !== scope.ownerScopeRef) {
      throw new CardSetError('OWNER_SCOPE_MISMATCH', 'card set owner scope does not match');
    }
    throw new CardSetError('THREAD_SCOPE_MISMATCH', 'card set thread does not match');
  }

  private requireEntry(record: Readonly<CardSetRecord>, candidateId: CandidateId): void {
    if (!record.entries.some((entry) => entry.candidateId === candidateId)) {
      throw new CardSetError('CANDIDATE_NOT_IN_SET', 'candidate is not part of this card set');
    }
  }

  private cardSetIds(): readonly CardSetId[] {
    return [...this.records.values()].map((record) => record.cardSetId);
  }
}
