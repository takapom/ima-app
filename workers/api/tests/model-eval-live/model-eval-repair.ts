import type { GetPlaceDetailsInput, RetentionMetadata } from '@ima/core';
import type {
  RuntimeGateModelCallOptions,
  RuntimeGateModelStreamPart,
} from '../runtime-gate/runtime-gate-provider';
import {
  finalParts,
  streamOf,
  toolParts,
  type ModelEvalFixtureEvidenceSnapshot,
} from './model-eval-context-output';
import {
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

type RepairProjectedEvidence = {
  readonly candidateId: string;
  readonly field: string;
  readonly observationId: string;
  readonly status: string;
  readonly reason?: string;
  readonly freshUntil?: string | null;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const array = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? (value as readonly unknown[]) : [];

const projectedEvidenceFor = (
  prompt: RuntimeGateModelCallOptions['prompt'],
): readonly RepairProjectedEvidence[] => {
  const contextEvidence = array(modelContextIn(prompt)?.evidence).flatMap((value) => {
    if (!record(value)) return [];
    const candidateId = value.candidateId;
    const field = value.field;
    const observationId = value.observationId;
    const status = value.status;
    const reason = value.reason;
    const freshUntil = value.freshUntil;
    return typeof candidateId === 'string' &&
      typeof field === 'string' &&
      typeof observationId === 'string' &&
      typeof status === 'string'
      ? [
          {
            candidateId,
            field,
            observationId,
            status,
            ...(typeof reason === 'string' ? { reason } : {}),
            ...(freshUntil === null || typeof freshUntil === 'string' ? { freshUntil } : {}),
          },
        ]
      : [];
  });
  const toolEvidence = array(prompt).flatMap((message) => {
    if (!record(message) || message.role !== 'tool') return [];
    return array(message.content).flatMap((part) => {
      if (!record(part) || part.type !== 'tool-result' || part.toolName !== 'get_place_details') {
        return [];
      }
      const output = record(part.output) ? part.output.value : undefined;
      if (!record(output) || (output.status !== 'ok' && output.status !== 'partial')) return [];
      const data = record(output.data) ? output.data : undefined;
      if (!record(data) || !Array.isArray(data.items)) return [];
      return data.items.flatMap((item) => {
        if (!record(item) || typeof item.candidateId !== 'string' || !record(item.fields)) {
          return [];
        }
        return Object.entries(item.fields).flatMap(([field, value]) => {
          if (!record(value) || value.status !== 'known' || !Array.isArray(value.observations)) {
            return [];
          }
          return value.observations.flatMap((observation) => {
            if (
              !record(observation) ||
              observation.field !== field ||
              typeof observation.observationId !== 'string' ||
              typeof observation.candidateId !== 'string' ||
              typeof observation.field !== 'string'
            ) {
              return [];
            }
            return [
              {
                candidateId: observation.candidateId,
                field: observation.field,
                observationId: observation.observationId,
                status: 'known',
              },
            ];
          });
        });
      });
    });
  });
  return [...contextEvidence, ...toolEvidence];
};

const openingEvidenceFor = (
  prompt: RuntimeGateModelCallOptions['prompt'],
  candidateId: string,
  status: 'known' | 'stale',
): readonly RepairProjectedEvidence[] =>
  projectedEvidenceFor(prompt).filter(
    (evidence) =>
      evidence.candidateId === candidateId &&
      evidence.field === 'opening_hours' &&
      (evidence.status === status ||
        (status === 'stale' &&
          evidence.status === 'withheld' &&
          evidence.reason === 'evidence retention window has ended' &&
          typeof evidence.freshUntil === 'string' &&
          Date.parse(evidence.freshUntil) <= Date.parse(MODEL_EVAL_REPAIR_TARGET_NOW))),
  );

export const freshRepairEvidenceIdsFor = (
  prompt: RuntimeGateModelCallOptions['prompt'],
  candidateId: string,
): readonly string[] =>
  openingEvidenceFor(prompt, candidateId, 'known').map((item) => item.observationId);

export const staleRepairEvidenceIdsFor = (
  prompt: RuntimeGateModelCallOptions['prompt'],
  candidateId: string,
): readonly string[] =>
  openingEvidenceFor(prompt, candidateId, 'stale').map((item) => item.observationId);

export type RepairTargetResult =
  | {
      readonly ok: true;
      readonly candidateId: string;
      readonly staleEvidenceIds: readonly string[];
    }
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
  const staleEvidenceIds = staleRepairEvidenceIdsFor(prompt, target.candidateId);
  return staleEvidenceIds.length === 0
    ? { ok: false, code: 'REPAIR_STALE_EVIDENCE_MISSING' }
    : { ok: true, candidateId: target.candidateId, staleEvidenceIds };
};

export const repairEvidenceSnapshotFor = (
  prompt: RuntimeGateModelCallOptions['prompt'],
  candidateId: string,
): ModelEvalFixtureEvidenceSnapshot => {
  const evidenceIds = freshRepairEvidenceIdsFor(prompt, candidateId);
  const observations: ProjectedObservation[] = evidenceIds.map((observationId) => ({
    candidateId,
    field: 'opening_hours',
    observationId,
  }));
  return {
    candidateId,
    evidenceIds,
    modelBudget: modelPreferenceBudgetIn(prompt),
    observations,
  };
};

export type RepairFixturePartsInput = {
  readonly prompt: RuntimeGateModelCallOptions['prompt'];
  readonly currentCall: number;
  readonly step: (name: 'get_place_details' | 'final_message') => void;
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
  const evidenceIds = freshRepairEvidenceIdsFor(input.prompt, target.candidateId);
  input.step('final_message');
  if (evidenceIds.length === 0) {
    return streamOf(
      finalParts(
        '営業時間を更新できませんでした。確認できた範囲では不明です。',
        [],
        'conversational',
      ),
    );
  }
  input.finalEvidence(repairEvidenceSnapshotFor(input.prompt, target.candidateId));
  return streamOf(finalParts('営業時間の根拠を更新しました。', evidenceIds));
};
