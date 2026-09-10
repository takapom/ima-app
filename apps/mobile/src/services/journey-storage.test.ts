import { describe, expect, it } from 'vitest';
import type { PublicCard, RetentionMetadata } from '@ima/contracts';
import {
  createSavedReferenceJourneyStorage,
  createUnavailableJourneyStorageService,
  type JourneyStorageSaveOptions,
} from './journey-storage';
import type { SavedReferenceSaveInput, SavedReferenceService } from './saved-reference-service';
import type { LocalSavedEntryId, ServerSavedPlaceRef } from './saved-place-types';

const referenceRetention: RetentionMetadata = {
  retentionDecision: 'allow',
  retentionMode: 'identifier_indefinite_owner_scoped',
  sessionExpiresAt: '2026-09-12T05:00:00+09:00',
  freshUntil: null,
  displayUntil: null,
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};

const cardEvidenceRetention: RetentionMetadata = {
  ...referenceRetention,
  retentionDecision: 'deny',
  retentionMode: 'session_only',
  sessionExpiresAt: '2026-09-12T05:00:00+09:00',
  policyStatus: 'policy_withheld',
  displayPolicyStatus: 'policy_withheld',
};

const candidate: PublicCard = {
  candidateId: 'candidate-1',
  facts: {
    identity: {
      status: 'known',
      value: {
        name: '夜カフェ',
        area: '恵比寿',
        address: null,
        category: 'cafe',
        businessStatus: 'operational',
        sourceUrl: null,
      },
      evidence: [
        {
          evidenceId: 'evidence-1',
          attribution: null,
          retention: cardEvidenceRetention,
        },
      ],
    },
  },
  why: {
    text: '静かに話せる',
    evidenceIds: [],
    evidence: [],
    basis: 'conversational',
    retention: cardEvidenceRetention,
  },
};

const savedReference = 'saved-ref-1' as ServerSavedPlaceRef;
const localEntry = 'local-1' as LocalSavedEntryId;

const serviceFor = (
  save: (input: SavedReferenceSaveInput) => ReturnType<SavedReferenceService['save']>,
): SavedReferenceService => ({
  save,
  remove: () => Promise.resolve({ status: 'already_deleted' }),
  refresh: () => Promise.resolve({ status: 'failed' as const, reason: 'api' as const }),
});

const optionsFor = (
  service: SavedReferenceService,
  overrides: Partial<{
    readonly currentScope: () => { readonly threadId: string; readonly revision: number } | null;
    readonly referenceRetentionFor: (card: PublicCard) => RetentionMetadata | null;
  }> = {},
) => ({
  service,
  currentScope: overrides.currentScope ?? (() => ({ threadId: 'thread-1', revision: 3 })),
  referenceRetentionFor: overrides.referenceRetentionFor ?? (() => referenceRetention),
});

describe('journey storage action boundary', () => {
  it('requires an injected reference policy and never derives it from card evidence', async () => {
    const received: SavedReferenceSaveInput[] = [];
    const service = createSavedReferenceJourneyStorage(
      optionsFor(
        serviceFor((input) => {
          received.push(input);
          return Promise.resolve({
            status: 'saved',
            localSavedEntryId: localEntry,
            serverSavedPlaceRef: savedReference,
          });
        }),
      ),
    );

    await expect(
      service.saveCandidate(candidate, { idempotencyKey: 'save-operation-1' }),
    ).resolves.toEqual({
      status: 'saved',
      localSavedEntryId: localEntry,
      serverSavedPlaceRef: savedReference,
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.candidateId).toBe(candidate.candidateId);
    expect(received[0]?.scope).toEqual({ threadId: 'thread-1', revision: 3 });
    expect(received[0]?.referenceRetention).toEqual(referenceRetention);
    expect(received[0]?.referenceRetention).not.toBe(cardEvidenceRetention);
  });

  it('does not report success when key, policy, or active scope is unavailable', async () => {
    let calls = 0;
    const service = serviceFor(() => {
      calls += 1;
      return Promise.resolve({
        status: 'saved',
        localSavedEntryId: localEntry,
        serverSavedPlaceRef: savedReference,
      });
    });

    await expect(
      createSavedReferenceJourneyStorage(optionsFor(service)).saveCandidate(candidate),
    ).resolves.toEqual({ status: 'failed', reason: 'invalid_input' });
    await expect(
      createSavedReferenceJourneyStorage(optionsFor(service)).saveCandidate(candidate, {
        idempotencyKey: '',
      }),
    ).resolves.toEqual({ status: 'failed', reason: 'invalid_input' });
    await expect(
      createSavedReferenceJourneyStorage(
        optionsFor(service, { referenceRetentionFor: () => null }),
      ).saveCandidate(candidate, { idempotencyKey: 'save-operation-1' }),
    ).resolves.toEqual({ status: 'failed', reason: 'retention_denied' });
    await expect(
      createSavedReferenceJourneyStorage(
        optionsFor(service, { currentScope: () => null }),
      ).saveCandidate(candidate, { idempotencyKey: 'save-operation-1' }),
    ).resolves.toEqual({ status: 'failed', reason: 'stale' });
    expect(calls).toBe(0);
  });

  it('forwards one retry key and the cancellation signal to the service', async () => {
    const inputs: SavedReferenceSaveInput[] = [];
    const service = createSavedReferenceJourneyStorage(
      optionsFor(
        serviceFor((input) => {
          inputs.push(input);
          return Promise.resolve({
            status: inputs.length === 1 ? 'saved' : 'already_saved',
            localSavedEntryId: localEntry,
            serverSavedPlaceRef: savedReference,
          });
        }),
      ),
    );
    const controller = new AbortController();
    const saveOptions: JourneyStorageSaveOptions = {
      idempotencyKey: 'save-retry-1',
      signal: controller.signal,
    };

    await expect(service.saveCandidate(candidate, saveOptions)).resolves.toMatchObject({
      status: 'saved',
    });
    await expect(service.saveCandidate(candidate, saveOptions)).resolves.toMatchObject({
      status: 'already_saved',
    });
    expect(inputs).toHaveLength(2);
    expect(inputs.map((input) => input.idempotencyKey)).toEqual(['save-retry-1', 'save-retry-1']);
    expect(inputs.every((input) => input.signal === controller.signal)).toBe(true);
  });

  it('keeps the disconnected default unavailable', async () => {
    await expect(
      createUnavailableJourneyStorageService().saveCandidate(candidate, {
        idempotencyKey: 'save-operation-1',
      }),
    ).resolves.toEqual({ status: 'failed', reason: 'storage_unavailable' });
  });

  it('maps service failures without turning them into saved state', async () => {
    const service = createSavedReferenceJourneyStorage(
      optionsFor(serviceFor(() => Promise.resolve({ status: 'failed', reason: 'stale' }))),
    );

    await expect(
      service.saveCandidate(candidate, { idempotencyKey: 'save-operation-1' }),
    ).resolves.toEqual({ status: 'failed', reason: 'stale' });
  });
});
