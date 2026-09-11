import type { UIMessage } from 'ai';
import type { GetPlaceDetailsInput, SearchPlacesInput, SubmitCardsInput } from '@ima/core';
import type { RuntimeGateToolEnvelope } from '../runtime-gate/runtime-gate-contract';
import type { RuntimeGateCoreReport } from '../runtime-gate/runtime-gate-core';
import type {
  RuntimeGateModelReport,
  RuntimeGateScenario,
} from '../support/runtime-model-fixture';
import type { RuntimeGateStepReport } from '../runtime-gate/runtime-gate-step';
import { DENIED_MARKER } from '../support/runtime-model-fixture';
import { markerRowsByTable, type ThinkRuntimeTableObservation } from './think-runtime-audit';
import type { ThinkRuntimeReplayReport } from './think-runtime-replay';
import type { ThinkRuntimeTransformReport } from './think-runtime-transform';

export type RuntimeGateToolName = 'search_places' | 'get_place_details' | 'submit_cards';
export type RuntimeGateToolInput = SearchPlacesInput | GetPlaceDetailsInput | SubmitCardsInput;
export type RuntimeGateSearchEnvelope = RuntimeGateToolEnvelope<SearchPlacesInput>;
export type RuntimeGateDetailsEnvelope = RuntimeGateToolEnvelope<GetPlaceDetailsInput>;
export type RuntimeGateSubmitEnvelope = RuntimeGateToolEnvelope<SubmitCardsInput>;

export type ThinkRuntimeToolExecution = {
  name: RuntimeGateToolName;
  input: RuntimeGateToolInput;
  abortSignalPassed: boolean;
};

export type ThinkRuntimeResult = {
  requestId: string;
  status: string;
  error: string | null;
};

export type ThinkRuntimeLogEntry = {
  toolName: string;
  success: boolean;
  errorCode: string | null;
};

function resultError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : 'UPSTREAM_UNAVAILABLE';
}

export type ThinkRuntimePublicReport = {
  scenario: RuntimeGateScenario;
  result: ThinkRuntimeResult | null;
  nativeSdkStarted: boolean;
  replay: ThinkRuntimeReplayReport;
  toolAllowlist: RuntimeGateToolName[];
  beforeTurnSteps: number;
  beforeStepNumbers: number[];
  beforeToolCalls: string[];
  toolExecutions: ThinkRuntimeToolExecution[];
  logEntries: ThinkRuntimeLogEntry[];
  model: RuntimeGateModelReport;
  core: RuntimeGateCoreReport;
  step: RuntimeGateStepReport;
  transform: ThinkRuntimeTransformReport;
  ephemeralResultsCaptured: number;
  ephemeralResultsProjected: number;
  canary: {
    value: string;
    liveCacheMarkerPresent: boolean;
    sessionHistoryMarkerPresent: boolean;
    storageMarkerCounts: Record<string, ThinkRuntimeTableObservation>;
  } | null;
  persistence: {
    liveCacheMarkerPresent: boolean;
    sessionHistoryMarkerPresent: boolean;
    storageMarkerCounts: Record<string, ThinkRuntimeTableObservation>;
  };
};

export const TOOL_ALLOWLIST: RuntimeGateToolName[] = [
  'search_places',
  'get_place_details',
  'submit_cards',
];

export function saveResult(result: {
  requestId: string;
  status: string;
  error?: unknown;
}): ThinkRuntimeResult {
  return {
    requestId: result.requestId,
    status: result.status,
    error: result.error === undefined ? null : resultError(result.error),
  };
}

export type ThinkRuntimeReportInput = {
  scenario: RuntimeGateScenario;
  result: ThinkRuntimeResult | null;
  messages: readonly UIMessage[];
  nativeSdkStarted: boolean;
  replay: ThinkRuntimeReplayReport;
  beforeTurnSteps: number;
  beforeStepNumbers: number[];
  beforeToolCalls: string[];
  toolExecutions: ThinkRuntimeToolExecution[];
  logEntries: ThinkRuntimeLogEntry[];
  model: RuntimeGateModelReport;
  core: RuntimeGateCoreReport;
  step: RuntimeGateStepReport;
  transform: ThinkRuntimeTransformReport;
  ephemeralResultsCaptured: number;
  ephemeralResultsProjected: number;
  canary: string | null;
  sessionHistoryMarkerPresent: boolean;
  sessionHistoryCanaryPresent: boolean;
  storageSql: Parameters<typeof markerRowsByTable>[0];
};

export function buildThinkRuntimePublicReport(
  input: ThinkRuntimeReportInput,
): ThinkRuntimePublicReport {
  const serialized = JSON.stringify(input.messages);
  return {
    scenario: input.scenario,
    result: input.result,
    nativeSdkStarted: input.nativeSdkStarted,
    replay: input.replay,
    toolAllowlist: [...TOOL_ALLOWLIST],
    beforeTurnSteps: input.beforeTurnSteps,
    beforeStepNumbers: input.beforeStepNumbers,
    beforeToolCalls: input.beforeToolCalls,
    toolExecutions: input.toolExecutions,
    logEntries: input.logEntries,
    model: input.model,
    core: input.core,
    step: input.step,
    transform: input.transform,
    ephemeralResultsCaptured: input.ephemeralResultsCaptured,
    ephemeralResultsProjected: input.ephemeralResultsProjected,
    canary:
      input.canary === null
        ? null
        : {
            value: input.canary,
            liveCacheMarkerPresent: serialized.includes(input.canary),
            sessionHistoryMarkerPresent: input.sessionHistoryCanaryPresent,
            storageMarkerCounts: markerRowsByTable(input.storageSql, input.canary),
          },
    persistence: {
      liveCacheMarkerPresent: serialized.includes(DENIED_MARKER),
      sessionHistoryMarkerPresent: input.sessionHistoryMarkerPresent,
      storageMarkerCounts: markerRowsByTable(input.storageSql, DENIED_MARKER),
    },
  };
}
