import type { ConversationMessage } from '@ima/contracts';
import type { ApiResult } from '@mobile/platform/http/api';

export const resultData = <T>(result: ApiResult<T>): T => {
  if (!result.ok)
    throw new Error(
      result.error.kind === 'http' && result.error.status === 404
        ? 'NOT_FOUND'
        : 'CONVERSATION_REQUEST_FAILED',
    );
  return result.data;
};

export const mergeMessages = (
  left: readonly ConversationMessage[],
  right: readonly ConversationMessage[],
) =>
  [
    ...new Map([...left, ...right].map((message) => [message.message.messageId, message])).values(),
  ].sort((a, b) => a.sequence - b.sequence);
