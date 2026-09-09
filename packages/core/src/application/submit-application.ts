import * as v from 'valibot';
import { RegistryScopeSchema, type RegistryScope } from '../domain/freshness';
import { NonNegativeSafeIntegerSchema, OpaqueIdSchema, TurnIdSchema } from '../domain/primitives';
import type { CandidateObservationRegistryPort } from '../ports/registry';
import type { IdPort } from '../ports/context';
import {
  CommitPortResultSchema,
  type CommitConflict,
  type CommitHashPort,
  type CommitPort,
  type CommitReceipt,
  type CommitReferences,
  CommitRecordSchema,
} from '../ports/commit';
import {
  type SubmitValidationIssue,
  type ValidatedCardsResponse,
  type ValidatedMessageResponse,
  SubmitValidationContextSchema,
} from './submit-cards-evidence';
import { validateMessage, validateSubmitCards } from './submit-cards';

const CommitExpectedRevisionSchema = v.pipe(
  NonNegativeSafeIntegerSchema,
  v.maxValue(Number.MAX_SAFE_INTEGER - 1),
);

export const CommitApplicationRequestSchema = v.strictObject({
  scope: RegistryScopeSchema,
  turnId: TurnIdSchema,
  expectedRevision: CommitExpectedRevisionSchema,
  idempotencyKey: OpaqueIdSchema,
});
export type CommitApplicationRequest = v.InferOutput<typeof CommitApplicationRequestSchema>;

export type CommittedResponse = ValidatedCardsResponse | ValidatedMessageResponse;

export type CommitApplicationResult =
  | { status: 'invalid'; issues: readonly SubmitValidationIssue[] }
  | { status: 'committed'; receipt: CommitReceipt }
  | { status: 'conflict'; conflict: CommitConflict };

type EphemeralResponse = {
  readonly scope: RegistryScope;
  readonly turnId: string;
  readonly responseId: string;
  readonly response: CommittedResponse;
};

const turnKey = (scope: RegistryScope, turnId: string): string =>
  `${scope.ownerScopeRef}\u0000${scope.threadId}\u0000${turnId}`;

const invalidRequest = (): CommitApplicationResult => ({
  status: 'invalid',
  issues: [
    {
      code: 'INVALID_ARGUMENT',
      path: 'commit',
      message: 'commit request is invalid',
      missingFields: [],
    },
  ],
});

export class CommitAdapterError extends Error {
  readonly code = 'COMMIT_ADAPTER_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'CommitAdapterError';
  }
}

const schemaFailure = (message: string): never => {
  throw new CommitAdapterError(message);
};

const sameScope = (left: RegistryScope, right: RegistryScope): boolean =>
  left.ownerScopeRef === right.ownerScopeRef && left.threadId === right.threadId;

const addUnique = (target: Set<string>, values: readonly string[]): void => {
  for (const value of values) target.add(value);
};

const referencesFor = (response: CommittedResponse): CommitReferences => {
  const candidateIds = new Set<string>();
  const observationIds = new Set<string>();
  if (response.presentation === 'replace') {
    addUnique(
      observationIds,
      response.message.flatMap((text) => text.evidenceIds),
    );
    const cards = [response.hero, ...response.alts];
    addUnique(
      candidateIds,
      cards.map((card) => card.candidateId),
    );
    for (const card of cards) {
      addUnique(observationIds, card.evidenceIds);
      addUnique(observationIds, card.why.evidenceIds);
      if (card.diff !== null) addUnique(observationIds, card.diff.evidenceIds);
    }
  } else {
    addUnique(observationIds, response.message.evidenceIds);
  }
  return {
    candidateIds: [...candidateIds],
    observationIds: [...observationIds],
  };
};

const responseKey = (scope: RegistryScope, turnId: string, responseId: string): string =>
  `${scope.ownerScopeRef}\u0000${scope.threadId}\u0000${turnId}\u0000${responseId}`;

/**
 * Validates model output, records a reference-only CAS receipt, and keeps the assembled response
 * in memory for the current turn. Durable adapters never receive the assembled response.
 */
export class SubmitApplication {
  private readonly ephemeralResponses = new Map<string, EphemeralResponse>();
  private readonly disposedTurns = new Set<string>();

  constructor(
    private readonly commits: CommitPort,
    private readonly ids: Pick<IdPort, 'nextResponseId'>,
    private readonly hashes: CommitHashPort,
  ) {}

  commitCards(
    input: unknown,
    context: unknown,
    registry: CandidateObservationRegistryPort,
    request: unknown,
  ): Promise<CommitApplicationResult> {
    const parsedRequest = v.safeParse(CommitApplicationRequestSchema, request);
    if (!parsedRequest.success) return Promise.resolve(invalidRequest());
    const parsedContext = v.safeParse(SubmitValidationContextSchema, context);
    if (
      !parsedContext.success ||
      !sameScope(parsedRequest.output.scope, parsedContext.output.scope)
    ) {
      return Promise.resolve(invalidRequest());
    }
    const validation = validateSubmitCards(input, parsedContext.output, registry);
    if (validation.status === 'invalid') return Promise.resolve(validation);
    return this.commitResponse(validation.response, parsedRequest.output);
  }

  commitMessage(
    input: unknown,
    context: unknown,
    registry: CandidateObservationRegistryPort,
    request: unknown,
  ): Promise<CommitApplicationResult> {
    const parsedRequest = v.safeParse(CommitApplicationRequestSchema, request);
    if (!parsedRequest.success) return Promise.resolve(invalidRequest());
    const parsedContext = v.safeParse(SubmitValidationContextSchema, context);
    if (
      !parsedContext.success ||
      !sameScope(parsedRequest.output.scope, parsedContext.output.scope)
    ) {
      return Promise.resolve(invalidRequest());
    }
    const validation = validateMessage(input, parsedContext.output, registry);
    if (validation.status === 'invalid') return Promise.resolve(validation);
    return this.commitResponse(validation.response, parsedRequest.output);
  }

  getCommittedResponse(
    scope: RegistryScope,
    turnId: string,
    responseId: string,
  ): CommittedResponse | undefined {
    if (this.disposedTurns.has(turnKey(scope, turnId))) return undefined;
    const response = this.ephemeralResponses.get(responseKey(scope, turnId, responseId))?.response;
    return response === undefined ? undefined : structuredClone(response);
  }

  clearTurn(scope: RegistryScope, turnId: string): void {
    this.disposedTurns.add(turnKey(scope, turnId));
    const prefix = `${scope.ownerScopeRef}\u0000${scope.threadId}\u0000${turnId}\u0000`;
    for (const key of this.ephemeralResponses.keys()) {
      if (key.startsWith(prefix)) this.ephemeralResponses.delete(key);
    }
  }

  private commitResponse(
    response: CommittedResponse,
    request: CommitApplicationRequest,
  ): Promise<CommitApplicationResult> {
    const references = referencesFor(response);
    const canonical = JSON.stringify({ presentation: response.presentation, response });
    if (canonical === undefined) {
      return Promise.reject(new CommitAdapterError('payload could not be canonicalized'));
    }
    return this.commitWithDigest(response, request, references, canonical);
  }

  private async commitWithDigest(
    response: CommittedResponse,
    request: CommitApplicationRequest,
    references: CommitReferences,
    canonical: string,
  ): Promise<CommitApplicationResult> {
    const payloadDigest = await this.hashes.digest(canonical);
    if (this.disposedTurns.has(turnKey(request.scope, request.turnId))) {
      return {
        status: 'conflict',
        conflict: {
          code: 'STALE_REVISION',
          message: 'turn ephemeral response was disposed',
        },
      };
    }
    const recordCandidate = {
      schemaVersion: 'v1' as const,
      scope: request.scope,
      turnId: request.turnId,
      idempotencyKey: request.idempotencyKey,
      responseId: this.ids.nextResponseId(),
      revision: request.expectedRevision + 1,
      payloadDigest,
      presentation: response.presentation,
      references,
    };
    const parsedRecord = v.safeParse(CommitRecordSchema, recordCandidate);
    if (!parsedRecord.success) return schemaFailure('generated commit record is invalid');
    const rawResult = await this.commits.commit({
      expectedRevision: request.expectedRevision,
      record: parsedRecord.output,
    });
    const parsedResult = v.safeParse(CommitPortResultSchema, rawResult);
    if (!parsedResult.success) return schemaFailure('commit adapter returned an invalid result');
    if (parsedResult.output.status === 'conflict') return parsedResult.output;
    const receipt = parsedResult.output.receipt;
    if (receipt.payloadDigest !== payloadDigest || receipt.presentation !== response.presentation) {
      return schemaFailure('commit receipt does not match the request');
    }
    if (
      receipt.revision !== parsedRecord.output.revision ||
      (!receipt.replayed && receipt.responseId !== parsedRecord.output.responseId)
    ) {
      return schemaFailure('commit receipt revision or response ID does not match the request');
    }
    if (this.disposedTurns.has(turnKey(request.scope, request.turnId))) {
      return parsedResult.output;
    }
    const storedResponse = structuredClone(response);
    this.ephemeralResponses.set(responseKey(request.scope, request.turnId, receipt.responseId), {
      scope: request.scope,
      turnId: request.turnId,
      responseId: receipt.responseId,
      response: storedResponse,
    });
    return parsedResult.output;
  }
}
