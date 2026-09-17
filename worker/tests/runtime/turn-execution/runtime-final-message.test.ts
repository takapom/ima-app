import * as v from 'valibot';
import { expect, describe, it } from 'vitest';
import { AssistantResponseSchema } from '@ima/contracts';
import {
  CandidateObservationRegistry,
  SubmitApplication,
  type CommitPort,
  type CommitRecord,
  type CommitRequest,
  type ConstraintValidationContext,
  type RegistryIdPort,
  type SubmitValidationContext,
  type ValidatedCard,
  type ValidatedMessageResponse,
} from '@ima/core';
import {
  parseRuntimeFinalMessage,
  RuntimeFinalMessageError,
} from '@worker/runtime/turn-execution/runtime-final-message';
import {
  mapCommittedResponseToPublic,
  RuntimePublicResponseError,
} from '@worker/runtime/response/runtime-response';

const now = '2026-09-10T12:00:00Z';
const scope = { ownerScopeRef: 'owner-final', threadId: 'thread-final' };
const constraintContext: ConstraintValidationContext = {
  threadId: scope.threadId,
  originalTurns: [
    {
      threadId: scope.threadId,
      turnId: 'turn-source',
      text: '最大徒歩を20分に変更する',
    },
  ],
};

const validationContext: SubmitValidationContext = {
  scope,
  serverNow: now,
  departureAt: now,
  expectedObservationContext: {
    ownerScopeRef: scope.ownerScopeRef,
    threadId: scope.threadId,
    capabilityVersion: 'final-v1',
    locationRevision: 1,
    originRef: null,
    homeStationRef: null,
    minimumStayMinutes: null,
    timeContext: 'now',
  },
  preferences: {
    maxWalkMinutes: null,
    homeStationRef: null,
    minimumStayMinutes: null,
  },
  travel: [],
  requireLastOrderAtArrival: false,
};

class FixedIds implements RegistryIdPort {
  nextCallId(): string {
    return 'call-final';
  }

  nextCandidateId(): string {
    return 'candidate-final';
  }

  nextObservationId(): string {
    return 'observation-final';
  }

  nextResponseId(): string {
    return 'response-final';
  }

  nextPlaceRef(): string {
    return 'place-final';
  }
}

class RecordingCommit implements CommitPort {
  readonly records: CommitRecord[] = [];

  commit(request: CommitRequest) {
    this.records.push(request.record);
    return {
      status: 'committed' as const,
      receipt: {
        responseId: request.record.responseId,
        revision: request.record.revision,
        payloadDigest: request.record.payloadDigest,
        presentation: request.record.presentation,
        replayed: false,
      },
    };
  }
}

const makeApplication = () => {
  const commits = new RecordingCommit();
  const application = new SubmitApplication(
    commits,
    { nextResponseId: () => 'response-final' },
    { digest: (value) => `digest-${value.length}` },
  );
  const registry = new CandidateObservationRegistry({ now: () => now }, new FixedIds());
  return { application, commits, registry };
};

const finalText = (
  message: Record<string, unknown> = {
    text: '条件を確認しました',
    evidenceIds: [],
    basis: 'conversational',
  },
  metadata?: unknown,
): string =>
  JSON.stringify({
    kind: 'final_message',
    message,
    ...(metadata === undefined ? {} : { metadata }),
  });

const validMetadata = {
  turnConstraints: {
    changes: [
      {
        maxWalkMinutes: 20,
        sourceTurnId: 'turn-source',
        quote: '最大徒歩を20分に変更する',
      },
    ],
  },
};

describe('runtime final message boundary', () => {
  it('strictly parses a final envelope and validates source-turn metadata', () => {
    const parsed = parseRuntimeFinalMessage(finalText(undefined, validMetadata), constraintContext);
    expect(parsed).toEqual({
      kind: 'final_message',
      message: {
        text: '条件を確認しました',
        evidenceIds: [],
        basis: 'conversational',
      },
      metadata: validMetadata,
    });
  });

  it('rejects arbitrary text, extra fields, and non-matching source quotes with typed errors', () => {
    expect(() => parseRuntimeFinalMessage('自由文', constraintContext)).toThrowError(
      new RuntimeFinalMessageError('INVALID_JSON'),
    );
    expect(() =>
      parseRuntimeFinalMessage(
        JSON.stringify({
          kind: 'final_message',
          message: {
            text: '秘密本文',
            evidenceIds: [],
            basis: 'conversational',
            providerSecret: 'must-not-pass',
          },
        }),
        constraintContext,
      ),
    ).toThrowError(new RuntimeFinalMessageError('INVALID_ENVELOPE'));
    expect(() =>
      parseRuntimeFinalMessage(
        finalText(undefined, {
          turnConstraints: {
            changes: [
              {
                maxWalkMinutes: 20,
                sourceTurnId: 'turn-source',
                quote: '別の原文',
              },
            ],
          },
        }),
        constraintContext,
      ),
    ).toThrowError(new RuntimeFinalMessageError('INVALID_METADATA'));
  });

  it('passes only the parsed message to Core commit and returns no body on invalid evidence', async () => {
    const fixture = makeApplication();
    const parsed = parseRuntimeFinalMessage(
      finalText({
        text: '未登録根拠の本文',
        evidenceIds: ['missing-observation'],
        basis: 'grounded',
      }),
      constraintContext,
    );
    const result = await fixture.application.commitMessage(
      parsed.message,
      validationContext,
      fixture.registry,
      {
        scope,
        turnId: 'turn-final',
        expectedRevision: 1,
        idempotencyKey: 'final-key',
      },
    );
    expect(result.status).toBe('invalid');
    expect(fixture.commits.records).toHaveLength(0);
    expect(result).not.toHaveProperty('message');
    expect(JSON.stringify(result)).not.toContain('未登録根拠の本文');
  });

  it('commits a structurally valid conversational message without exposing its body in the result', async () => {
    const fixture = makeApplication();
    const parsed = parseRuntimeFinalMessage(finalText(), constraintContext);
    const result = await fixture.application.commitMessage(
      parsed.message,
      validationContext,
      fixture.registry,
      {
        scope,
        turnId: 'turn-final',
        expectedRevision: 1,
        idempotencyKey: 'final-commit',
      },
    );
    expect(result).toMatchObject({ status: 'committed' });
    expect(result).not.toHaveProperty('message');
    expect(fixture.commits.records[0]?.references).toEqual({
      candidateIds: [],
      observationIds: [],
    });
  });
});

const retention = {
  retentionDecision: 'deny' as const,
  retentionMode: 'session_only' as const,
  sessionExpiresAt: '2026-09-10T23:00:00Z',
  freshUntil: '2026-09-10T13:00:00Z',
  displayUntil: '2026-09-10T22:00:00Z',
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: { label: 'Fixture', sourceLink: null },
  restoreMode: 'reference_only' as const,
  policyStatus: 'available' as const,
  displayPolicyStatus: 'available' as const,
};

type EvidenceLink = ValidatedMessageResponse['message']['evidence'][number];

const evidenceLink = (observationId: string, field: EvidenceLink['field']): EvidenceLink => ({
  observationId,
  candidateId: 'candidate-1',
  field,
  sources: [
    {
      provider: 'fixture',
      recordRef: `record-${observationId}`,
      attribution: 'Fixture',
      publicUrl: null,
    },
  ],
  retention,
});

const responseMetadata = {
  threadId: 'thread-final',
  turnId: 'turn-final',
  responseId: 'response-final',
  revision: 2,
  textRetention: retention,
};

const identity = {
  name: '店A',
  area: '恵比寿',
  address: null,
  category: 'cafe',
  businessStatus: 'operational' as const,
  sourceUrl: null,
};

const openingHours = {
  timeZone: 'UTC',
  intervals: [{ startAt: '2026-09-10T11:00:00Z', endAt: '2026-09-10T15:00:00Z' }],
  weeklyText: ['11:00-15:00'],
  evaluatedAt: now,
  listedOpenAtEvaluation: true,
  nextBoundaryAt: '2026-09-10T15:00:00Z',
  lastOrderAt: '2026-09-10T14:00:00Z',
  lastOrderRaw: '14:00',
};

const cardEvidenceLinks = new Map([
  ['obs-identity', evidenceLink('obs-identity', 'identity')],
  ['obs-opening', evidenceLink('obs-opening', 'opening_hours')],
  ['obs-photos', evidenceLink('obs-photos', 'photos')],
]);

const requireCardEvidenceLink = (evidenceId: string): EvidenceLink => {
  const link = cardEvidenceLinks.get(evidenceId);
  if (link === undefined) throw new Error('card evidence fixture is incomplete');
  return link;
};

const card: ValidatedCard = {
  candidateId: 'candidate-1',
  identity,
  openingHours,
  price: null,
  photos: {
    photos: [
      {
        photoRef: 'photo-internal-token',
        attributions: [{ displayName: 'Fixture source', uri: null }],
        sourceUrl: null,
      },
    ],
  },
  walkingRoute: null,
  lastTrain: null,
  evidenceIds: ['obs-identity', 'obs-opening', 'obs-photos'],
  why: {
    text: '営業中の候補です',
    evidenceIds: ['obs-identity'],
    basis: 'grounded',
    evidence: [requireCardEvidenceLink('obs-identity')],
  },
  diff: null,
};

describe('Core committed response to public DTO mapping', () => {
  it('maps a message response through the public schema and strips Core-only evidence fields', () => {
    const response: ValidatedMessageResponse = {
      presentation: 'keep',
      message: {
        text: '条件を確認しました',
        evidenceIds: [],
        basis: 'conversational',
        evidence: [],
      },
    };
    const publicResponse = mapCommittedResponseToPublic(response, responseMetadata);
    expect(v.safeParse(AssistantResponseSchema, publicResponse).success).toBe(true);
    expect(publicResponse).toMatchObject({
      kind: 'message',
      presentation: 'keep',
      cardSetId: null,
      message: [{ text: '条件を確認しました', evidence: [], retention }],
    });
    expect(JSON.stringify(publicResponse)).not.toContain('recordRef');
  });

  it('maps cards with field evidence, photo token translation, and no internal source objects', () => {
    const response = {
      presentation: 'replace' as const,
      message: [card.why],
      hero: card,
      alts: [],
    };
    const publicResponse = mapCommittedResponseToPublic(response, {
      ...responseMetadata,
      cardSetId: 'card-set-final',
      resolveCardEvidence: (_candidateId, evidenceId) => cardEvidenceLinks.get(evidenceId),
      resolvePhotoToken: (_candidateId, photoRef) =>
        photoRef === 'photo-internal-token' ? 'photo-token-public' : undefined,
    });
    expect(v.safeParse(AssistantResponseSchema, publicResponse).success).toBe(true);
    expect(publicResponse.kind).toBe('cards');
    if (publicResponse.kind !== 'cards') throw new Error('expected cards response');
    expect(publicResponse.cards.hero.facts.photos).toMatchObject({
      status: 'known',
      value: { photos: [{ photoToken: 'photo-token-public' }] },
    });
    const identityFact = publicResponse.cards.hero.facts.identity;
    if (identityFact.status !== 'known') throw new Error('expected known identity fact');
    expect(identityFact.evidence).toEqual([
      { evidenceId: 'obs-identity', attribution: retention.attribution, retention },
    ]);
    expect(JSON.stringify(publicResponse)).not.toContain('recordRef');
    expect(JSON.stringify(publicResponse)).not.toContain('photo-internal-token');
  });

  it('requires an explicit card-set ID and card evidence resolver for card responses', () => {
    const response = {
      presentation: 'replace' as const,
      message: [card.why],
      hero: card,
      alts: [],
    };
    expect(() => mapCommittedResponseToPublic(response, responseMetadata)).toThrowError(
      new RuntimePublicResponseError('CARD_SET_ID_REQUIRED'),
    );
    expect(() =>
      mapCommittedResponseToPublic(response, {
        ...responseMetadata,
        cardSetId: 'card-set-final',
      }),
    ).toThrowError(new RuntimePublicResponseError('CARD_EVIDENCE_RESOLVER_REQUIRED'));
    const publicResponse = mapCommittedResponseToPublic(response, {
      ...responseMetadata,
      cardSetId: 'card-set-final',
      resolveCardEvidence: (_candidateId, evidenceId) => cardEvidenceLinks.get(evidenceId),
    });
    if (publicResponse.kind !== 'cards') throw new Error('expected cards response');
    expect(publicResponse.cards.hero.facts.photos).toMatchObject({
      status: 'unknown',
      reason: '写真を表示できません',
    });
  });

  it('withholds missing photo evidence while keeping the card usable', () => {
    const response = {
      presentation: 'replace' as const,
      message: [card.why],
      hero: { ...card, evidenceIds: ['obs-identity', 'obs-opening'] },
      alts: [],
    };
    const publicResponse = mapCommittedResponseToPublic(response, {
      ...responseMetadata,
      cardSetId: 'card-set-photo-withheld',
      resolveCardEvidence: (_candidateId, evidenceId) => cardEvidenceLinks.get(evidenceId),
      resolvePhotoToken: () => undefined,
    });
    expect(v.safeParse(AssistantResponseSchema, publicResponse).success).toBe(true);
    if (publicResponse.kind !== 'cards') throw new Error('expected cards response');
    expect(publicResponse.cards.hero.facts.photos).toMatchObject({
      status: 'unknown',
      reason: '写真を表示できません',
    });
    expect(JSON.stringify(publicResponse)).not.toContain('photo-internal-token');
  });

  it('distinguishes an actual empty photo set from a partially withheld set', () => {
    if (card.photos === null) throw new Error('photo fixture is incomplete');
    const originalPhotos = card.photos;
    const response = {
      presentation: 'replace' as const,
      message: [card.why],
      hero: { ...card, photos: { photos: [] } },
      alts: [],
    };
    const emptyResponse = mapCommittedResponseToPublic(response, {
      ...responseMetadata,
      cardSetId: 'card-set-photo-empty',
      resolveCardEvidence: (_candidateId, evidenceId) => cardEvidenceLinks.get(evidenceId),
      resolvePhotoToken: () => undefined,
    });
    if (emptyResponse.kind !== 'cards') throw new Error('expected cards response');
    expect(emptyResponse.cards.hero.facts.photos).toMatchObject({
      status: 'known',
      value: { photos: [] },
    });

    const partialResponse = mapCommittedResponseToPublic(
      {
        ...response,
        hero: {
          ...card,
          photos: {
            photos: [
              ...originalPhotos.photos,
              {
                photoRef: 'photo-internal-token-2',
                attributions: [],
                sourceUrl: null,
              },
            ],
          },
        },
      },
      {
        ...responseMetadata,
        cardSetId: 'card-set-photo-partial',
        resolveCardEvidence: (_candidateId, evidenceId) => cardEvidenceLinks.get(evidenceId),
        resolvePhotoToken: (_candidateId, photoRef) =>
          photoRef === 'photo-internal-token' ? 'photo-token-public' : undefined,
      },
    );
    if (partialResponse.kind !== 'cards') throw new Error('expected cards response');
    expect(partialResponse.cards.hero.facts.photos).toMatchObject({
      status: 'known',
      value: {
        photos: [{ photoToken: 'photo-token-public' }],
        partialReason: '一部の写真は表示できません',
      },
    });
  });
});
