import * as v from 'valibot';
import type { AssistantResponse, ThreadTurnRequest } from '@ima/contracts';
import {
  ModelHistoryEntrySchema,
  OriginalTurnSchema,
  RetentionMetadataSchema,
  type ModelHistoryEntry,
  type OriginalTurn,
  type RegistryScope,
  type RetentionMetadata,
} from '@ima/core';
import { isRuntimeRetentionWindowOpen } from '@worker/infrastructure/runtime/retention/runtime-retention';

export type RetainedHistoryEntry = ModelHistoryEntry & {
  readonly retention?: RetentionMetadata | undefined;
};

/** History quotes earlier utterances; Core separately checks the freshness of their evidence. */
export const conversationBodyIsUsable = (retention: RetentionMetadata, now: string): boolean =>
  v.safeParse(RetentionMetadataSchema, retention).success &&
  isRuntimeRetentionWindowOpen({ ...retention, freshUntil: null }, now);

/** Model input contains only text whose own retention window is still open. */
export const projectConversationHistory = (
  history: readonly RetainedHistoryEntry[],
  now: string,
): ModelHistoryEntry[] =>
  structuredClone(history).map(({ retention, ...entry }) =>
    retention === undefined || conversationBodyIsUsable(retention, now)
      ? entry
      : { ...entry, text: '[withheld]', evidenceIds: [], basis: 'conversational' },
  );

export const responseHistory = (response: AssistantResponse): readonly RetainedHistoryEntry[] =>
  response.message.flatMap((message) => {
    const parsed = v.safeParse(ModelHistoryEntrySchema, {
      threadId: response.threadId,
      turnId: response.turnId,
      role: 'assistant',
      text: message.text,
      evidenceIds: message.evidenceIds,
      basis: message.basis,
    });
    return parsed.success ? [{ ...parsed.output, retention: message.retention }] : [];
  });

export const userHistoryFor = (
  input: ThreadTurnRequest,
  scope: RegistryScope,
): ModelHistoryEntry | undefined => {
  const parsed = v.safeParse(ModelHistoryEntrySchema, {
    threadId: scope.threadId,
    turnId: input.turnId ?? input.requestId,
    role: 'user',
    text: input.text,
    evidenceIds: [],
    basis: 'conversational',
  });
  return parsed.success ? parsed.output : undefined;
};

export const originalTurnFor = (
  input: ThreadTurnRequest,
  scope: RegistryScope,
): OriginalTurn | undefined => {
  const parsed = v.safeParse(OriginalTurnSchema, {
    threadId: scope.threadId,
    turnId: input.turnId ?? input.requestId,
    text: input.text,
  });
  return parsed.success ? parsed.output : undefined;
};
