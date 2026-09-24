import { expect, describe, it } from 'vitest';
import { CandidateObservationRegistry } from '@worker/application/candidate-registry/registry';
import { SubmitApplication } from '@worker/application/use-cases/submit-response/submit-application';
import {
  type CommitPort,
  type CommitRecord,
  type CommitRequest,
} from '@worker/application/ports/commit';
import { type RegistryIdPort } from '@worker/application/ports/context';
import { type SubmitValidationContext } from '@worker/application/use-cases/submit-response/validation/submit-cards-evidence';
import {
  parseRuntimeFinalMessage,
  RuntimeFinalMessageError,
} from '@worker/runtime/turn-execution/runtime-final-message';

const now = '2026-09-10T12:00:00Z';
const scope = { ownerScopeRef: 'owner-final', threadId: 'thread-final' };
const validationContext: SubmitValidationContext = {
  scope,
  serverNow: now,
  expectedObservationContext: {
    ownerScopeRef: scope.ownerScopeRef,
    threadId: scope.threadId,
    capabilityVersion: 'final-v1',
    locationRevision: 1,
    timeContext: 'now',
  },
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

const finalText = (message: unknown = '条件を確認しました', metadata?: unknown): string =>
  JSON.stringify({
    kind: 'final_message',
    message,
    ...(metadata === undefined ? {} : { metadata }),
  });

describe('runtime final message boundary', () => {
  it('strictly parses a final envelope and rejects the removed metadata field', () => {
    expect(() => parseRuntimeFinalMessage(finalText(undefined, {}))).toThrowError(
      new RuntimeFinalMessageError('INVALID_ENVELOPE'),
    );
    const parsed = parseRuntimeFinalMessage(finalText());
    expect(parsed).toEqual({
      kind: 'final_message',
      message: '条件を確認しました',
    });
  });

  it('rejects arbitrary text, extra fields, and legacy constraint metadata with typed errors', () => {
    expect(() => parseRuntimeFinalMessage('自由文')).toThrowError(
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
      ),
    ).toThrowError(new RuntimeFinalMessageError('INVALID_ENVELOPE'));
  });

  it('rejects the retired self-reported basis and citations instead of dropping them', () => {
    expect(() =>
      parseRuntimeFinalMessage(
        finalText({ text: '確認しました', evidenceIds: [], basis: 'conversational' }),
      ),
    ).toThrowError(new RuntimeFinalMessageError('INVALID_ENVELOPE'));
  });

  it('commits a structurally valid conversational message without exposing its body in the result', async () => {
    const fixture = makeApplication();
    const parsed = parseRuntimeFinalMessage(finalText());
    const result = await fixture.application.commitMessage(
      { kind: 'answer', message: parsed.message },
      validationContext,
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
