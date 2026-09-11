import type { SaveMessagesResult } from '@cloudflare/ai-chat';
import type { GetPlaceDetailsInput, SearchPlacesInput, SubmitCardsInput } from '@ima/core';
import type { RuntimeGateCoreReport } from './runtime-gate-core';
import type { RuntimeGateSseEvent } from './runtime-gate-sse';
import type { RuntimeGateStepReport } from './runtime-gate-step';
import type { RuntimeGateModelReport, RuntimeGateScenario } from '../support/runtime-model-fixture';

export type RuntimeGateToolName = 'search_places' | 'get_place_details' | 'submit_cards';
export type RuntimeGateToolInput = SearchPlacesInput | GetPlaceDetailsInput | SubmitCardsInput;

export type RuntimeGateReplayCommit = {
  responseId: string;
  revision: number;
  candidateIds: string[];
  evidenceIds: string[];
};

export type RuntimeGateReplayRecord = {
  idempotencyKey: string;
  payloadDigest: string;
  turnId: string;
  revision: number;
  commit: RuntimeGateReplayCommit;
};

export type RuntimeGateState = {
  replay?: RuntimeGateReplayRecord;
};

export type RuntimeGateReplayReport = {
  action: 'none' | 'run' | 'replay';
  outcome: 'none' | 'stored' | 'replayed' | 'conflict' | 'stale' | 'missing';
  idempotencyKey: string | null;
  turnId: string | null;
  requestedRevision: number | null;
  storedRevision: number | null;
  commit: RuntimeGateReplayCommit | null;
  sameCommit: boolean;
};

export type RuntimeGateToolExecution = {
  name: RuntimeGateToolName;
  input: RuntimeGateToolInput;
  abortSignalPassed: boolean;
};

export type RuntimeGatePublicReport = {
  scenario: RuntimeGateScenario;
  result: { requestId: string; status: SaveMessagesResult['status']; error: string | null } | null;
  nativeSdkStarted: boolean;
  replay: RuntimeGateReplayReport;
  toolAllowlist: RuntimeGateToolName[];
  toolExecutions: RuntimeGateToolExecution[];
  model: RuntimeGateModelReport;
  core: RuntimeGateCoreReport;
  step: RuntimeGateStepReport;
  sse: {
    events: RuntimeGateSseEvent[];
    persistedMarkerPresent: boolean;
  };
};
