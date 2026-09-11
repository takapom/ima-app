import { describe, expect, it } from 'vitest';
import type { ValidatedMessageResponse, RetentionMetadata } from '@ima/core';
import {
  mapCommittedResponseToPublic,
  RuntimePublicResponseError,
} from '../../src/runtime/runtime-response';

const availableRetention: RetentionMetadata = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-11T00:00:00.000Z',
  freshUntil: '2026-09-10T13:00:00.000Z',
  displayUntil: '2026-09-10T18:00:00.000Z',
  retentionUntil: '2026-09-10T23:00:00.000Z',
  deletionScheduledAt: '2026-09-10T23:00:00.000Z',
  attribution: { label: 'ホットペッパー', sourceLink: 'https://www.hotpepper.jp' },
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};

const withheldRetention: RetentionMetadata = {
  ...availableRetention,
  retentionDecision: 'deny',
  retentionMode: 'session_only',
  retentionUntil: null,
  deletionScheduledAt: null,
  restoreMode: 'unavailable',
  policyStatus: 'policy_withheld',
  displayPolicyStatus: 'policy_withheld',
};

type EvidenceLink = ValidatedMessageResponse['message']['evidence'][number];

const hpEvidence: EvidenceLink = {
  observationId: 'hp-observation',
  candidateId: 'candidate-hp',
  field: 'price',
  sources: [
    {
      provider: 'hotpepper',
      recordRef: 'hp-record',
      attribution: 'ホットペッパー',
      publicUrl: 'https://www.hotpepper.jp',
    },
  ],
  retention: availableRetention,
};

const response: ValidatedMessageResponse = {
  presentation: 'keep',
  message: {
    text: '保存した候補を確認しました',
    evidenceIds: [hpEvidence.observationId],
    basis: 'grounded',
    evidence: [hpEvidence],
  },
};

const options = {
  threadId: 'thread-hp',
  turnId: 'turn-hp',
  responseId: 'response-hp',
  revision: 1,
  textRetention: availableRetention,
};

describe('runtime public Hot Pepper evidence', () => {
  it('does not publish a message with stale HP evidence retention metadata', () => {
    expect(() =>
      mapCommittedResponseToPublic(response, {
        ...options,
        resolveCardEvidence: (candidateId, evidenceId) =>
          candidateId === hpEvidence.candidateId && evidenceId === hpEvidence.observationId
            ? { ...hpEvidence, retention: withheldRetention }
            : undefined,
      }),
    ).toThrowError(new RuntimePublicResponseError('PUBLIC_RESPONSE_INVALID'));
  });

  it('fails closed when current evidence cannot be re-resolved', () => {
    expect(() =>
      mapCommittedResponseToPublic(response, {
        ...options,
        resolveCardEvidence: () => undefined,
      }),
    ).toThrowError(new RuntimePublicResponseError('CARD_EVIDENCE_MISSING'));
  });
});
