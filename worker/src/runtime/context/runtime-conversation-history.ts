import * as v from 'valibot';
import type { AssistantResponse, ThreadTurnRequest } from '@ima/contracts';
import {
  ModelHistoryEntrySchema,
  type ModelHistoryEntry,
} from '@worker/application/model-context/model-context';
import { RetentionMetadataSchema, type RetentionMetadata } from '@worker/domain/evidence/retention';
import { type RegistryScope } from '@worker/domain/evidence/freshness';
import { isRuntimeRetentionWindowOpen } from '@worker/runtime/retention/runtime-retention';

export type RetainedHistoryEntry = ModelHistoryEntry & {
  readonly retention?: RetentionMetadata | undefined;
};

/** History quotes earlier utterances; their freshness belonged to the turn that produced them. */
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
      : { ...entry, text: '[withheld]' },
  );

export const responseHistory = (response: AssistantResponse): readonly RetainedHistoryEntry[] =>
  response.message.flatMap((message) => {
    const parsed = v.safeParse(ModelHistoryEntrySchema, {
      threadId: response.threadId,
      turnId: response.turnId,
      role: 'assistant',
      text: message.text,
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
  });
  return parsed.success ? parsed.output : undefined;
};
