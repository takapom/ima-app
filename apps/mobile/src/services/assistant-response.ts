import {
  parseSearchResponse,
  parseThreadSnapshot,
  type AssistantResponse,
  type ThreadReadResponse,
  type ThreadResponseRecord,
} from '@ima/contracts';
import {
  acknowledgeRestoredResponse,
  advanceAssistantRevision,
  applyAssistantResponse,
  type AssistantResponseState,
} from '../state/assistant-response';

export type ResponseApplyResult = {
  readonly state: AssistantResponseState;
  readonly accepted: boolean;
  readonly issues: readonly string[];
};

const accepted = (state: AssistantResponseState): ResponseApplyResult => ({
  state,
  accepted: true,
  issues: [],
});

const rejected = (
  state: AssistantResponseState,
  issues: readonly string[],
): ResponseApplyResult => ({
  state,
  accepted: false,
  issues,
});

const threadMismatch = (expected: string, actual: string) =>
  `response thread ${actual} does not match state thread ${expected}`;

export const applySearchResponseJson = (
  state: AssistantResponseState,
  input: unknown,
): ResponseApplyResult => {
  const parsed = parseSearchResponse(input);
  if (!parsed.success) return rejected(state, parsed.issues);
  if (parsed.data.response.threadId !== state.threadId) {
    return rejected(state, [threadMismatch(state.threadId, parsed.data.response.threadId)]);
  }
  return accepted(applyAssistantResponse(state, parsed.data.response));
};

const fullResponseFromRecord = (
  snapshot: ThreadReadResponse,
  record: ThreadResponseRecord,
): AssistantResponse | null => {
  if (record.restoreMode !== 'full') return null;
  return {
    ...record,
    schemaVersion: snapshot.schemaVersion,
    threadId: snapshot.threadId,
  };
};

export const applyThreadSnapshotJson = (
  state: AssistantResponseState,
  input: unknown,
): ResponseApplyResult => {
  const parsed = parseThreadSnapshot(input);
  if (!parsed.success) return rejected(state, parsed.issues);
  if (parsed.data.threadId !== state.threadId) {
    return rejected(state, [threadMismatch(state.threadId, parsed.data.threadId)]);
  }

  const next = [...parsed.data.responses]
    .sort((left, right) => left.revision - right.revision)
    .reduce((current, record) => {
      if (record.restoreMode === 'full') {
        const response = fullResponseFromRecord(parsed.data, record);
        return response === null ? current : applyAssistantResponse(current, response);
      }
      return acknowledgeRestoredResponse(current, {
        responseId: record.responseId,
        revision: record.revision,
        kind: record.kind,
        cardSetId: record.cardSetId,
        threadId: parsed.data.threadId,
        restoreMode: record.restoreMode,
      });
    }, state);

  return accepted(advanceAssistantRevision(next, parsed.data.revision));
};
