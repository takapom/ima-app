import type { JSONValue } from 'ai';
import type { ObservationRegistration } from '@worker/domain/candidates/registry';
import type { RetentionMetadata } from '@worker/domain/evidence/retention';
import { denyModelContextFieldPolicy } from '@worker/application/model-context/model-context-policy';
import { describe, expect, it } from 'vitest';
import {
  NOW,
  SCOPE,
  allowRetention,
  createComposition,
  captureToolResult,
  modelContext,
  RecordingCommit,
  respondWith,
  retention,
  stepMessages,
  validationContext,
} from './runtime-turn-composition-fixture';

/** Shown for a shorter time than the turn's own text retention. */
const shortRetention: RetentionMetadata = {
  ...allowRetention.retention,
  displayUntil: '2026-09-10T00:01:10Z',
  retentionUntil: '2026-09-10T00:01:20Z',
  deletionScheduledAt: '2026-09-10T00:01:20Z',
};

type Composition = ReturnType<typeof createComposition>;

const register = (
  fixture: Composition,
  field: ObservationRegistration['field'],
  value: ObservationRegistration['value'],
  observationRetention: RetentionMetadata,
) =>
  fixture.registry.registerObservation({
    scope: SCOPE,
    candidateId: fixture.currentCandidateId,
    field,
    value,
    basis: 'provider_reported',
    sourceUpdatedAt: null,
    freshUntil: '2026-09-10T00:01:00Z',
    expiresAt: '2026-09-10T00:02:00Z',
    context: validationContext.expectedObservationContext,
    sources: [
      { provider: 'fixture', recordRef: 'presented-record', attribution: null, publicUrl: null },
    ],
    retention: observationRetention,
  });

const observationOutput = (stored: ReturnType<typeof register>): JSONValue => ({
  observationId: stored.observationId,
  candidateId: stored.candidateId,
  field: stored.field,
  fetchedAt: NOW,
  freshUntil: stored.freshUntil,
  expiresAt: stored.expiresAt,
  value: JSON.parse(JSON.stringify(stored.value)) as JSONValue,
});

/** Shows one tool result to the model, answers, and returns what was published and stored. */
const answerAfterShowing = async (
  fixture: Composition,
  output: Parameters<typeof captureToolResult>[1],
) => {
  const transformed = await captureToolResult(fixture.composition, output);
  await fixture.composition.projectStep(
    {
      steps: [],
      stepNumber: 1,
      model: fixture.model,
      messages: stepMessages(transformed.toolCallId, transformed.output),
      experimental_context: undefined,
    },
    NOW,
  );
  await respondWith(fixture.composition, { kind: 'answer', message: '確認しました' });
  const response = await fixture.composition.getCommittedResponse();
  const published =
    response !== undefined && 'responseId' in response ? response.message[0]?.retention : undefined;
  const context = fixture.composition.retention.context;
  const stored = (typeof context === 'function' ? context() : context).retention;
  fixture.composition.dispose();
  return { published, stored };
};

const compositionWith = (fieldPolicy?: typeof denyModelContextFieldPolicy) =>
  createComposition(
    new RecordingCommit(),
    1,
    allowRetention,
    () => NOW,
    { digest: () => 'composition-digest' },
    { textRetention: allowRetention.retention },
    fieldPolicy === undefined ? {} : { modelContext: { ...modelContext, fieldPolicy } },
  );

describe('generated text retention follows what the model was shown (#61)', () => {
  it('narrows the published and the stored text by a shown observation', async () => {
    const fixture = compositionWith();
    const stored = register(fixture, 'identity', { name: '短い店' }, shortRetention);
    const result = await answerAfterShowing(fixture, observationOutput(stored));

    for (const bound of [result.published, result.stored]) {
      expect(bound).toMatchObject({
        retentionDecision: 'allow',
        displayUntil: shortRetention.displayUntil,
        retentionUntil: shortRetention.retentionUntil,
      });
    }
  });

  it('stops storing the text once a shown observation may not be stored', async () => {
    const fixture = compositionWith();
    const stored = register(fixture, 'identity', { name: '保存不可の店' }, retention.retention);
    const result = await answerAfterShowing(fixture, observationOutput(stored));

    expect(result.published).toMatchObject({ retentionDecision: 'deny' });
    expect(result.stored).toMatchObject({ retentionDecision: 'deny' });
  });

  it('does not narrow by a field the model input policy withheld', async () => {
    const fixture = compositionWith({
      ...denyModelContextFieldPolicy,
      evidence: { ...denyModelContextFieldPolicy.evidence, identity: 'allow' },
    });
    const identity = register(
      fixture,
      'identity',
      { name: '表示できる店' },
      allowRetention.retention,
    );
    const price = register(
      fixture,
      'price',
      { level: null, range: null, rawLabel: '1001～1500円' },
      retention.retention,
    );
    const result = await answerAfterShowing(fixture, {
      status: 'ok',
      data: {
        searchId: 'search-presented',
        candidates: [
          {
            candidateId: fixture.currentCandidateId,
            identity: { status: 'known', observations: [observationOutput(identity)] },
            price: { status: 'known', observations: [observationOutput(price)] },
          },
        ],
        applied: { areaDescription: '渋谷', excludedCount: 0 },
        nextCursor: null,
        coverage: 'provider_results',
      },
      warnings: [],
    });

    // The denied price never reached the model, so its storage limit does not apply.
    expect(result.published).toMatchObject({
      retentionDecision: 'allow',
      displayUntil: allowRetention.retention.displayUntil,
    });
  });
});
