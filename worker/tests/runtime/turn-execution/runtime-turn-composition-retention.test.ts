import type { CommitHashPort } from '@worker/application/ports/commit';
import type { ObservationRegistration } from '@worker/domain/candidates/registry';
import { describe, expect, it } from 'vitest';
import {
  NOW,
  SCOPE,
  allowRetention,
  createComposition,
  stepMessages,
  captureToolResult,
  RecordingCommit,
  retention,
  validationContext,
} from './runtime-turn-composition-fixture';

describe('Runtime turn composition retention boundaries', () => {
  it('keeps current-turn tool data across steps, then withholds it after expiry or invalidation', async () => {
    let currentNow = NOW;
    const { composition, registry, currentCandidateId, model } = createComposition(
      undefined,
      undefined,
      allowRetention,
      () => currentNow,
    );
    const observation: ObservationRegistration = {
      scope: SCOPE,
      candidateId: currentCandidateId,
      field: 'identity',
      value: { name: 'OBSERVATION_CANARY' },
      basis: 'provider_reported',
      sourceUpdatedAt: null,
      freshUntil: '2026-09-10T00:01:00Z',
      expiresAt: '2026-09-10T00:02:00Z',
      context: validationContext.expectedObservationContext,
      sources: [
        { provider: 'fixture', recordRef: 'current-record', attribution: null, publicUrl: null },
      ],
      retention: allowRetention.retention,
    };
    const stored = registry.registerObservation(observation);
    const transformed = await captureToolResult(composition, {
      observationId: stored.observationId,
      candidateId: stored.candidateId,
      field: stored.field,
      freshUntil: stored.freshUntil,
      expiresAt: stored.expiresAt,
      value: { name: 'OBSERVATION_CANARY' },
    });
    await composition.projectStep(
      {
        steps: [],
        stepNumber: 0,
        model,
        messages: [{ role: 'user', content: 'current-turn' }],
        experimental_context: undefined,
      },
      currentNow,
    );
    const projected = await composition.projectStep(
      {
        steps: [],
        stepNumber: 1,
        model,
        messages: stepMessages(transformed.toolCallId, transformed.output),
        experimental_context: undefined,
      },
      currentNow,
    );
    expect(JSON.stringify(projected.messages)).toContain('OBSERVATION_CANARY');

    currentNow = '2026-09-10T00:01:01Z';
    const expired = await composition.projectStep(
      {
        steps: [],
        stepNumber: 2,
        model,
        messages: stepMessages(transformed.toolCallId, transformed.output),
        experimental_context: undefined,
      },
      currentNow,
    );
    expect(JSON.stringify(expired.messages)).not.toContain('OBSERVATION_CANARY');
    expect(JSON.stringify(expired.messages)).toContain('[withheld]');

    currentNow = NOW;
    registry.invalidateObservationReuse(SCOPE, currentCandidateId, 'identity');
    const invalidated = await composition.projectStep(
      {
        steps: [],
        stepNumber: 3,
        model,
        messages: stepMessages(transformed.toolCallId, transformed.output),
        experimental_context: undefined,
      },
      currentNow,
    );
    expect(JSON.stringify(invalidated.messages)).not.toContain('OBSERVATION_CANARY');
    composition.dispose();
  });

  it('does not invoke the durable commit port after disposal during final hashing', async () => {
    let started = false;
    let resolveDigest: ((digest: string) => void) | undefined;
    const digest = new Promise<string>((resolve) => {
      resolveDigest = resolve;
    });
    const hashes: CommitHashPort = {
      digest: () => {
        started = true;
        return digest;
      },
    };
    const commit = new RecordingCommit();
    const { composition } = createComposition(commit, 1, retention, () => NOW, hashes);
    composition.onAccepted({
      terminal: 'message',
      finalText: JSON.stringify({
        kind: 'final_message',
        message: 'cancel me',
      }),
      emptyFinal: false,
      partCount: 1,
      bytes: 32,
    });
    const pending = composition.getCommittedResponse();
    await Promise.resolve();
    expect(started).toBe(true);
    composition.dispose();
    resolveDigest?.('composition-digest');
    await expect(pending).resolves.toBeUndefined();
    expect(commit.requests).toHaveLength(0);
  });
});
