import { JourneyScreen } from '@mobile/journey/JourneyScreen';
import { useConversations, type ConversationBinding } from '@mobile/journey/hooks/useConversations';
import { ConversationTranscript } from '@mobile/journey/components/conversations/ConversationTranscript';
import type { JourneyPreferencesService } from '@mobile/preferences/services/preferences';

export function ConversationJourneyScreen({
  binding,
  preferences,
}: {
  readonly binding: ConversationBinding;
  readonly preferences?: JourneyPreferencesService;
}): React.JSX.Element {
  const conversation = useConversations(binding);
  const state = conversation.state;
  return (
    <JourneyScreen
      key={state.selected?.conversationId ?? 'new-conversation'}
      threadId={state.responseState?.threadId ?? state.run?.threadId ?? 'conversation-new'}
      responseState={state.responseState}
      {...(binding.photoClient === undefined ? {} : { photoClient: binding.photoClient })}
      {...(binding.storage === undefined ? {} : { storage: binding.storage })}
      {...(binding.savedPlacePreview === undefined
        ? {}
        : { savedPlacePreview: binding.savedPlacePreview })}
      {...(preferences === undefined ? {} : { preferences })}
      requestStatus={
        state.pending || conversation.locating ? 'pending' : state.error === null ? 'idle' : 'error'
      }
      errorMessage={state.error ?? '会話を読み込めませんでした。'}
      onSubmit={(text, context) => {
        void conversation.submit(text, context).catch(conversation.reportError);
      }}
      onNewSearch={conversation.newConversation}
      onRetry={() => {
        void conversation.retry().catch(conversation.reportError);
      }}
      onCancel={() => {
        void conversation.cancel().catch(conversation.reportError);
      }}
      conversation={{
        hasMessages: state.messages.length > 0,
        renderTranscript: (liveMessages, onSourcePress) => (
          <ConversationTranscript
            messages={state.messages}
            liveMessages={liveMessages}
            onSourcePress={onSourcePress}
            loading={state.loading}
            hasOlder={state.beforeSequence !== null}
            onOlder={() => {
              void conversation.older().catch(conversation.reportError);
            }}
          />
        ),
        navigation: {
          conversations: state.conversations,
          selectedId: state.selected?.conversationId ?? null,
          unavailable: state.listError,
          hasMore: state.nextCursor !== null,
          onSelect: (id) => {
            void conversation.select(id).catch(conversation.reportError);
          },
          onDelete: (id) => {
            void conversation.remove(id).catch(conversation.reportError);
          },
          onMore: () => {
            void conversation.loadMore().catch(conversation.reportError);
          },
          onRefresh: () => {
            void conversation.refresh().catch(conversation.reportError);
          },
        },
      }}
    />
  );
}
