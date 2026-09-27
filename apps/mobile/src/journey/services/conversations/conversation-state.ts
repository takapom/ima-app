import type { Conversation, ConversationMessage, ConversationRun } from '@ima/contracts';
import type { AssistantResponseState } from '@mobile/journey/state/assistant-response';
export type ConversationState = {
  readonly conversations: readonly Conversation[];
  readonly selected: Conversation | null;
  readonly messages: readonly ConversationMessage[];
  readonly run: ConversationRun | null;
  readonly responseState: AssistantResponseState | null;
  readonly loading: boolean;
  readonly pending: boolean;
  readonly listError: boolean;
  readonly error: string | null;
  readonly syncError: string | null;
  readonly nextCursor: string | null;
  readonly beforeSequence: number | null;
};
export const initialState = (): ConversationState => ({
  conversations: [],
  selected: null,
  messages: [],
  run: null,
  responseState: null,
  loading: false,
  pending: false,
  listError: false,
  error: null,
  syncError: null,
  nextCursor: null,
  beforeSequence: null,
});
export const pendingRun = (run: ConversationRun | null) =>
  run?.status === 'accepted' || run?.status === 'running';
