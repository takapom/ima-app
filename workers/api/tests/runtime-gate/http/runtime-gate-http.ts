import * as v from 'valibot';
import { EvidenceTextSchema, SubmitCardsInputSchema, type SubmitCardsInput } from '@ima/core';
import {
  IDENTITY_RETENTION,
  allObservations,
  observationFor,
  type RuntimeGateObservation,
} from '../runtime-gate-observations';
import {
  SearchResponseSchema,
  type EvidenceRef,
  type PublicCard,
  type SearchResponse,
} from '@ima/contracts';

type CoreEvidenceText = v.InferOutput<ReturnType<typeof EvidenceTextSchema>>;
type PublicMessage = SearchResponse['response']['message'][number];

type RuntimeGateHttpContext = {
  threadId: string;
  turnId: string;
  revision: number;
};

type ReplayCommit = {
  responseId: string;
  revision: number;
  candidateIds: string[];
  evidenceIds: string[];
};

type SubmitExecution = {
  name: 'submit_cards';
  input: SubmitCardsInput;
};

type HttpReport = {
  result: { requestId: string; status: string; error: string | null } | null;
  replay: { outcome: string; commit: ReplayCommit | null };
  core: { commits: Array<{ candidateIds: string[]; evidenceIds: string[] }> };
  toolExecutions: SubmitExecution[];
  acceptedFinals: CoreEvidenceText[];
};

export class RuntimeGateHttpError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'RuntimeGateHttpError';
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringArray = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;

const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const fail = (code: string): never => {
  throw new RuntimeGateHttpError(code);
};

function replayCommit(value: unknown): ReplayCommit | null {
  if (value === null) return null;
  if (!isRecord(value)) return fail('FIXTURE_REPORT_INVALID_REPLAY_COMMIT');
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
    return fail('FIXTURE_REPORT_INVALID_REPLAY_COMMIT');
  }
  return { responseId: value.responseId, revision: value.revision, candidateIds, evidenceIds };
}

function readReport(value: unknown): HttpReport {
  if (!isRecord(value)) return fail('FIXTURE_REPORT_INVALID');

  const resultValue = value.result;
  let result: HttpReport['result'];
  if (resultValue === null) {
    result = null;
  } else if (
    isRecord(resultValue) &&
    typeof resultValue.requestId === 'string' &&
    typeof resultValue.status === 'string' &&
    (resultValue.error === null || typeof resultValue.error === 'string')
  ) {
    result = {
      requestId: resultValue.requestId,
      status: resultValue.status,
      error: resultValue.error,
    };
  } else {
    return fail('FIXTURE_REPORT_INVALID_RESULT');
  }

  const replayValue = value.replay;
  if (!isRecord(replayValue) || typeof replayValue.outcome !== 'string') {
    return fail('FIXTURE_REPORT_INVALID_REPLAY');
  }

  const coreValue = value.core;
  if (!isRecord(coreValue) || !Array.isArray(coreValue.commits)) {
    return fail('FIXTURE_REPORT_INVALID_CORE');
  }
  const commits = coreValue.commits.map((commit) => {
    if (!isRecord(commit)) return fail('FIXTURE_REPORT_INVALID_COMMIT');
    const candidateIds = stringArray(commit.candidateIds);
    const evidenceIds = stringArray(commit.evidenceIds);
    if (candidateIds === null || evidenceIds === null) {
      return fail('FIXTURE_REPORT_INVALID_COMMIT');
    }
    return { candidateIds, evidenceIds };
  });

  if (!Array.isArray(value.toolExecutions)) return fail('FIXTURE_REPORT_INVALID_TOOLS');
  const toolExecutions = value.toolExecutions.flatMap((execution): SubmitExecution[] => {
    if (!isRecord(execution) || execution.name !== 'submit_cards') return [];
    const parsed = v.safeParse(SubmitCardsInputSchema, execution.input);
    return parsed.success ? [{ name: 'submit_cards', input: parsed.output }] : [];
  });

  const stepValue = value.step;
  if (!isRecord(stepValue) || !Array.isArray(stepValue.acceptedSteps)) {
    return fail('FIXTURE_REPORT_INVALID_STEPS');
  }
  const acceptedFinals = stepValue.acceptedSteps.flatMap((step): CoreEvidenceText[] => {
    if (!isRecord(step) || step.finalMessage === undefined) return [];
    const parsed = v.safeParse(EvidenceTextSchema(300), step.finalMessage);
    return parsed.success ? [parsed.output] : [];
  });

  return {
    result,
    replay: { outcome: replayValue.outcome, commit: replayCommit(replayValue.commit) },
    core: { commits },
    toolExecutions,
    acceptedFinals,
  };
}

function observationForId(evidenceId: string): RuntimeGateObservation {
  const observation = allObservations.find((item) => item.observationId === evidenceId);
  if (observation === undefined) return fail(`FIXTURE_EVIDENCE_NOT_REGISTERED:${evidenceId}`);
  return observation;
}

function publicEvidence(observation: RuntimeGateObservation): EvidenceRef {
  return {
    evidenceId: observation.observationId,
    attribution: observation.retention.attribution,
    retention: observation.retention,
  };
}

function publicText(
  entry: CoreEvidenceText,
  fallbackRetention: RuntimeGateObservation['retention'] = IDENTITY_RETENTION,
): PublicMessage {
  const evidenceIds = [...entry.evidenceIds];
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    return fail('FIXTURE_TEXT_DUPLICATE_EVIDENCE');
  }
  const evidence = evidenceIds.map((evidenceId) => publicEvidence(observationForId(evidenceId)));
  const retention = evidence[0]?.retention ?? fallbackRetention;
  if (evidence.some((item) => JSON.stringify(item.retention) !== JSON.stringify(retention))) {
    return fail('FIXTURE_TEXT_RETENTION_MISMATCH');
  }
  if (
    evidence.length > 0 &&
    evidence.some((item) => JSON.stringify(item.retention) !== JSON.stringify(fallbackRetention))
  ) {
    return fail('FIXTURE_TEXT_RETENTION_EXCEEDS_SOURCE');
  }
  return {
    text: entry.text,
    evidenceIds,
    evidence,
    basis: entry.basis,
    retention,
  };
}

function publicCard(
  entry: SubmitCardsInput['hero'],
  textRetention: RuntimeGateObservation['retention'],
): PublicCard {
  const identity = observationFor(entry.candidateId, 'identity');
  if (
    identity.candidateId !== entry.candidateId ||
    identity.field !== 'identity' ||
    !sameIds(entry.evidenceIds, [identity.observationId]) ||
    !sameIds(entry.why.evidenceIds, entry.evidenceIds)
  ) {
    return fail(`FIXTURE_IDENTITY_EVIDENCE_MISMATCH:${entry.candidateId}`);
  }
  const card: PublicCard = {
    candidateId: entry.candidateId,
    facts: {
      identity: {
        status: 'known',
        value: identity.value,
        evidence: [publicEvidence(identity)],
      },
    },
    why: publicText(entry.why, textRetention),
  };
  return entry.diff === undefined ? card : { ...card, diff: publicText(entry.diff, textRetention) };
}

function responseFromReport(report: HttpReport, context: RuntimeGateHttpContext): SearchResponse {
  if (
    report.result === null ||
    report.result.status !== 'completed' ||
    report.result.error !== null
  ) {
    return fail('FIXTURE_POLICY_FAILED');
  }
  if (report.result.requestId.length === 0) return fail('FIXTURE_REQUEST_ID_MISSING');

  const commit = report.replay.commit;
  if (report.core.commits.length > 0) {
    if (report.core.commits.length !== 1 || report.replay.outcome !== 'stored' || commit === null) {
      return fail('FIXTURE_COMMIT_INCOMPLETE');
    }
    const execution = report.toolExecutions.at(-1);
    if (execution === undefined) return fail('FIXTURE_COMMITTED_INPUT_MISSING');
    const selections = [execution.input.hero, ...execution.input.alts];
    const candidateIds = selections.map((selection) => selection.candidateId);
    const evidenceIds = selections.flatMap((selection) => selection.evidenceIds);
    const coreCommit = report.core.commits[0];
    if (coreCommit === undefined) return fail('FIXTURE_COMMIT_MISSING');
    if (
      !sameIds(candidateIds, commit.candidateIds) ||
      !sameIds(evidenceIds, commit.evidenceIds) ||
      !sameIds(candidateIds, coreCommit.candidateIds) ||
      !sameIds(evidenceIds, coreCommit.evidenceIds)
    ) {
      return fail('FIXTURE_COMMIT_EVIDENCE_MISMATCH');
    }
    const identity = observationFor(execution.input.hero.candidateId, 'identity');
    const cards = {
      hero: publicCard(execution.input.hero, identity.retention),
      alts: execution.input.alts.map((entry) => publicCard(entry, identity.retention)),
    };
    const dto: unknown = {
      requestId: report.result.requestId,
      response: {
        schemaVersion: 'v1',
        threadId: context.threadId,
        turnId: context.turnId,
        responseId: commit.responseId,
        revision: commit.revision,
        kind: 'cards',
        presentation: 'replace',
        cardSetId: `cards-${commit.responseId}`,
        cards,
        message: execution.input.message.map((entry) => publicText(entry, identity.retention)),
      },
      warnings: [],
    };
    const parsed = v.safeParse(SearchResponseSchema, dto);
    return parsed.success ? parsed.output : fail('FIXTURE_PUBLIC_RESPONSE_INVALID');
  }

  if (report.acceptedFinals.length !== 1) return fail('FIXTURE_NO_PUBLIC_RESULT');
  const final = report.acceptedFinals[0];
  if (final === undefined) return fail('FIXTURE_NO_PUBLIC_RESULT');
  const dto: unknown = {
    requestId: report.result.requestId,
    response: {
      schemaVersion: 'v1',
      threadId: context.threadId,
      turnId: context.turnId,
      responseId: `response-${report.result.requestId}`,
      revision: context.revision,
      kind: 'message',
      presentation: 'keep',
      cardSetId: null,
      message: [publicText(final)],
    },
    warnings: [],
  };
  const parsed = v.safeParse(SearchResponseSchema, dto);
  return parsed.success ? parsed.output : fail('FIXTURE_PUBLIC_RESPONSE_INVALID');
}

export function normalizeRuntimeGateReport(
  report: unknown,
  context: RuntimeGateHttpContext,
): SearchResponse {
  return responseFromReport(readReport(report), context);
}

/** Think emits the same Core/step/report contract; require its replay ledger explicitly. */
export function normalizeThinkRuntimeReport(
  report: unknown,
  context: RuntimeGateHttpContext,
): SearchResponse {
  if (!isRecord(report) || !Object.prototype.hasOwnProperty.call(report, 'replay')) {
    return fail('FIXTURE_REPORT_INVALID_REPLAY');
  }
  return responseFromReport(readReport(report), context);
}

export function publicError(error: unknown): Response {
  const code = error instanceof RuntimeGateHttpError ? error.code : 'FIXTURE_HTTP_ADAPTER_ERROR';
  return Response.json({ error: code }, { status: 422 });
}

export type { RuntimeGateHttpContext };
