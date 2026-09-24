import type { GetPlaceDetailsInput } from '@worker/application/ports/operations';
import type { RetentionMetadata } from '@worker/domain/evidence/retention';
import type {
  RuntimeGateModelCallOptions,
  RuntimeGateModelStreamPart,
} from '../support/runtime-model-fixture';
import {
  messageParts,
  streamOf,
  toolParts,
  type ModelEvalFixtureEvidenceSnapshot,
} from './model-eval-context-output';
import {
  collectProjectedPromptValues,
  modelContextIn,
  modelPreferenceBudgetIn,
  type ProjectedObservation,
} from './model-eval-context-values';

export const MODEL_EVAL_REPAIR_PRELUDE_NOW = '2026-09-10T10:00:00.000Z';
export const MODEL_EVAL_REPAIR_TARGET_NOW = '2026-09-10T12:00:00.000Z';
export const MODEL_EVAL_REPAIR_REFRESH_FRESH_UNTIL = '2026-09-10T14:00:00.000Z';

/** Provider freshness ends at 21:00; storage, display, and session windows remain separate. */
const REPAIR_POLICY_FRESH_UNTIL = '2026-09-10T18:00:00.000Z';
const REPAIR_DISPLAY_UNTIL = '2026-09-10T20:00:00.000Z';
const REPAIR_RETENTION_UNTIL = '2026-09-10T22:00:00.000Z';
const REPAIR_SESSION_EXPIRES_AT = '2026-09-10T23:00:00.000Z';

const repairRetention = () =>
  ({
    retentionDecision: 'allow',
    retentionMode: 'provider_limited',
    sessionExpiresAt: REPAIR_SESSION_EXPIRES_AT,
    freshUntil: REPAIR_POLICY_FRESH_UNTIL,
    displayUntil: REPAIR_DISPLAY_UNTIL,
    retentionUntil: REPAIR_RETENTION_UNTIL,
    deletionScheduledAt: REPAIR_RETENTION_UNTIL,
    attribution: null,
    restoreMode: 'full',
    policyStatus: 'available',
    displayPolicyStatus: 'available',
  }) as const satisfies RetentionMetadata;

/** Gives the prelude an exact 21:00 source boundary and the refresh a later one. */
export const repairObservationPolicyFor = (phase: 'cards' | 'message') => {
  const freshUntil =
    phase === 'cards' ? MODEL_EVAL_REPAIR_TARGET_NOW : MODEL_EVAL_REPAIR_REFRESH_FRESH_UNTIL;
  return {
    freshUntil,
    expiresAt: phase === 'cards' ? '2026-09-10T16:00:00.000Z' : '2026-09-10T17:00:00.000Z',
    retention: repairRetention(),
  };
};

export const repairOverridesFor = (profile: string, phase: () => 'cards' | 'message') => {
  if (profile !== 'repair') return {};
  return {
    observationPolicy: () => repairObservationPolicyFor(phase()),
    detailsObservationPolicy: () => repairObservationPolicyFor(phase()),
  };
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const array = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? (value as readonly unknown[]) : [];

/**
 * At the target the prelude's opening hours are stale, or withheld once their retention window has
 * ended; either way the model cannot use them. A refresh arrives as a details summary.
 */
const openingObservationsFor = (
  prompt: RuntimeGateModelCallOptions['prompt'],
  candidateId: string,
  state: 'stale' | 'refreshed',
): readonly ProjectedObservation[] =>
  collectProjectedPromptValues(prompt).observations.filter(
    (observation) =>
      observation.candidateId === candidateId &&
      observation.field === 'opening_hours' &&
      (state === 'stale'
        ? observation.status === 'stale' || observation.status === 'withheld'
        : observation.status === 'known' && observation.source === 'details'),
  );

export type RepairTargetResult =
  | { readonly ok: true; readonly candidateId: string }
  | {
      readonly ok: false;
      readonly code: 'REPAIR_CARD_CONTEXT_MISSING' | 'REPAIR_STALE_EVIDENCE_MISSING';
    };

type RepairCardTargetResult =
  | { readonly ok: true; readonly candidateId: string }
  | { readonly ok: false; readonly code: 'REPAIR_CARD_CONTEXT_MISSING' };

const repairCardTargetFor = (
  prompt: RuntimeGateModelCallOptions['prompt'],
): RepairCardTargetResult => {
  const cardSet = modelContextIn(prompt)?.cardSet;
  if (!record(cardSet)) return { ok: false, code: 'REPAIR_CARD_CONTEXT_MISSING' };
  const first = array(cardSet.entries)[0];
  if (!record(first) || typeof first.candidateId !== 'string') {
    return { ok: false, code: 'REPAIR_CARD_CONTEXT_MISSING' };
  }
  if (
    !array(cardSet.candidates).some(
      (candidate) => record(candidate) && candidate.candidateId === first.candidateId,
    )
  ) {
    return { ok: false, code: 'REPAIR_CARD_CONTEXT_MISSING' };
  }
  return { ok: true, candidateId: first.candidateId };
};

/** Resolves the formal hero card only; dataset IDs and display names are never guessed. */
export const repairTargetFor = (
  prompt: RuntimeGateModelCallOptions['prompt'],
): RepairTargetResult => {
  const target = repairCardTargetFor(prompt);
  if (!target.ok) return target;
  return openingObservationsFor(prompt, target.candidateId, 'stale').length === 0
    ? { ok: false, code: 'REPAIR_STALE_EVIDENCE_MISSING' }
    : { ok: true, candidateId: target.candidateId };
};

export const repairEvidenceSnapshotFor = (
  prompt: RuntimeGateModelCallOptions['prompt'],
  candidateId: string,
): ModelEvalFixtureEvidenceSnapshot => {
  const observations = openingObservationsFor(prompt, candidateId, 'refreshed');
  return {
    candidateId,
    knownFields: observations.length === 0 ? [] : ['opening_hours'],
    modelBudget: modelPreferenceBudgetIn(prompt),
    observations,
  };
};

export type RepairFixturePartsInput = {
  readonly prompt: RuntimeGateModelCallOptions['prompt'];
  readonly currentCall: number;
  readonly step: (name: 'get_place_details' | 'respond:answer') => void;
  readonly detailsRequest: (candidateIds: readonly string[]) => void;
  readonly finalEvidence: (snapshot: ModelEvalFixtureEvidenceSnapshot) => void;
};

/** Refreshes one formally selected candidate and withholds old evidence after failure. */
export const repairPartsFor = (
  input: RepairFixturePartsInput,
): ReadableStream<RuntimeGateModelStreamPart> => {
  if (input.currentCall === 0) {
    const target = repairTargetFor(input.prompt);
    if (!target.ok) throw new Error(target.code);
    input.step('get_place_details');
    input.detailsRequest([target.candidateId]);
    const details: GetPlaceDetailsInput = {
      requests: [{ candidateId: target.candidateId, fields: ['opening_hours'] }],
      freshness: 'refresh',
    };
    return streamOf(toolParts(input.currentCall, 'get_place_details', details));
  }
  const target = repairCardTargetFor(input.prompt);
  if (!target.ok) throw new Error(target.code);
  const refreshed = openingObservationsFor(input.prompt, target.candidateId, 'refreshed');
  input.step('respond:answer');
  if (refreshed.length === 0) {
    return streamOf(
      messageParts(
        input.currentCall,
        'answer',
        '営業時間を更新できませんでした。確認できた範囲では不明です。',
      ),
    );
  }
  input.finalEvidence(repairEvidenceSnapshotFor(input.prompt, target.candidateId));
  return streamOf(messageParts(input.currentCall, 'answer', '営業時間の根拠を更新しました。'));
};
