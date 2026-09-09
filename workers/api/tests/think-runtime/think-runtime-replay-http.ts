import * as v from 'valibot';
import { ThreadReadResponseSchema, type ThreadReadResponse } from '@ima/contracts';
import {
  RuntimeGateHttpError,
  type RuntimeGateHttpContext,
} from '../runtime-gate/http/runtime-gate-http';
import type { ThinkRuntimeReplayCommit } from './think-runtime-replay';

type JsonRecord = Record<string, unknown>;

type ReplayHttpReport = {
  nativeSdkStarted: boolean;
  modelCalls: number;
  coreCommitCount: number;
  result: {
    requestId: string;
    status: string;
    error: string | null;
  };
  replay: {
    action: string;
    outcome: string;
    turnId: string | null;
    requestedRevision: number | null;
    storedRevision: number | null;
    sameCommit: boolean;
    commit: ThinkRuntimeReplayCommit | null;
  };
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

function fail(code: string): never {
  throw new RuntimeGateHttpError(code);
}

function parseCommit(value: unknown): ThinkRuntimeReplayCommit | null {
  if (value === null) return null;
  if (!isRecord(value)) return fail('FIXTURE_REPLAY_COMMIT_INVALID');
  const candidateIds = stringArray(value.candidateIds);
  const evidenceIds = stringArray(value.evidenceIds);
  if (
    typeof value.responseId !== 'string' ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    candidateIds === null ||
    evidenceIds === null
  ) {
    return fail('FIXTURE_REPLAY_COMMIT_INVALID');
  }
  return { responseId: value.responseId, revision: value.revision, candidateIds, evidenceIds };
}

function readReport(value: unknown): ReplayHttpReport {
  if (!isRecord(value)) return fail('FIXTURE_REPLAY_REPORT_INVALID');
  const model = value.model;
  const core = value.core;
  if (
    typeof value.nativeSdkStarted !== 'boolean' ||
    !isRecord(model) ||
    typeof model.calls !== 'number' ||
    !Number.isSafeInteger(model.calls) ||
    model.calls < 0 ||
    !isRecord(core) ||
    !Array.isArray(core.commits)
  ) {
    return fail('FIXTURE_REPLAY_SIDE_EFFECT_REPORT_INVALID');
  }
  const result = value.result;
  if (
    !isRecord(result) ||
    typeof result.requestId !== 'string' ||
    typeof result.status !== 'string' ||
    (result.error !== null && typeof result.error !== 'string')
  ) {
    return fail('FIXTURE_REPLAY_RESULT_INVALID');
  }
  const replay = value.replay;
  if (
    !isRecord(replay) ||
    typeof replay.action !== 'string' ||
    typeof replay.outcome !== 'string' ||
    (replay.turnId !== null && typeof replay.turnId !== 'string') ||
    (replay.requestedRevision !== null && typeof replay.requestedRevision !== 'number') ||
    (replay.storedRevision !== null && typeof replay.storedRevision !== 'number') ||
    typeof replay.sameCommit !== 'boolean'
  ) {
    return fail('FIXTURE_REPLAY_STATE_INVALID');
  }
  return {
    nativeSdkStarted: value.nativeSdkStarted,
    modelCalls: model.calls,
    coreCommitCount: core.commits.length,
    result: {
      requestId: result.requestId,
      status: result.status,
      error: result.error,
    },
    replay: {
      action: replay.action,
      outcome: replay.outcome,
      turnId: replay.turnId,
      requestedRevision: replay.requestedRevision,
      storedRevision: replay.storedRevision,
      sameCommit: replay.sameCommit,
      commit: parseCommit(replay.commit),
    },
  };
}

function referenceResponse(
  report: ReplayHttpReport,
  context: RuntimeGateHttpContext,
): ThreadReadResponse {
  if (
    report.nativeSdkStarted ||
    report.modelCalls !== 0 ||
    report.coreCommitCount > 1 ||
    report.result.status !== 'completed' ||
    report.result.error !== null ||
    report.replay.action !== 'replay' ||
    report.replay.outcome !== 'replayed' ||
    !report.replay.sameCommit
  ) {
    return fail('FIXTURE_REPLAY_NOT_AVAILABLE');
  }
  const commit = report.replay.commit;
  if (commit === null) return fail('FIXTURE_REPLAY_COMMIT_MISSING');
  if (report.replay.turnId !== context.turnId) {
    return fail('FIXTURE_REPLAY_TURN_MISMATCH');
  }
  if (
    report.replay.requestedRevision !== context.revision ||
    report.replay.storedRevision !== commit.revision ||
    commit.revision !== context.revision
  ) {
    return fail('FIXTURE_REPLAY_REVISION_MISMATCH');
  }

  const dto: unknown = {
    schemaVersion: 'v1',
    requestId: report.result.requestId,
    threadId: context.threadId,
    revision: context.revision,
    active: true,
    responses: [
      {
        turnId: context.turnId,
        responseId: commit.responseId,
        revision: commit.revision,
        kind: 'cards',
        presentation: 'replace',
        cardSetId: `cards-${commit.responseId}`,
        restoreMode: 'reference_only',
      },
    ],
  };
  const parsed = v.safeParse(ThreadReadResponseSchema, dto);
  return parsed.success ? parsed.output : fail('FIXTURE_REPLAY_RESPONSE_INVALID');
}

/** Convert a successful Think replay into the body-only-free thread snapshot contract. */
export function normalizeThinkRuntimeReplayReport(
  report: unknown,
  context: RuntimeGateHttpContext,
): ThreadReadResponse {
  return referenceResponse(readReport(report), context);
}
