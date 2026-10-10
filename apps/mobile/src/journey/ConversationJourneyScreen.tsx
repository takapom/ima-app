import { JourneyScreen } from '@mobile/journey/JourneyScreen';
import { useConversations, type ConversationBinding } from '@mobile/journey/hooks/useConversations';
import { ConversationTranscript } from '@mobile/journey/components/conversations/ConversationTranscript';
import type { JourneyPreferencesService } from '@mobile/preferences/services/preferences';

export function ConversationJourneyScreen({
  binding,
  preferences,
  initialQuery,
  onInitialQuerySent,
}: {
  readonly binding: ConversationBinding;
  readonly preferences?: JourneyPreferencesService;
  readonly initialQuery?: string;
  readonly onInitialQuerySent?: () => void;
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
      {...(initialQuery === undefined ? {} : { initialQuery })}
      {...(onInitialQuerySent === undefined ? {} : { onInitialQuerySent })}
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
        renderTranscript: (liveMessages, onSourcePress, photoViewport, cardFocus) => (
          <ConversationTranscript
            messages={state.messages}
            liveCardSetId={state.responseState?.cardSetId ?? null}
            {...(binding.photoClient === undefined ? {} : { photoClient: binding.photoClient })}
            liveMessages={liveMessages}
            photoViewport={photoViewport}
            cardFocus={cardFocus}
            onSourcePress={onSourcePress}
            syncError={state.syncError}
            unsyncedTurnId={state.syncError === null ? null : (state.run?.turnId ?? null)}
            onRetrySync={() => {
              void conversation.retry().catch(conversation.reportError);
            }}
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
