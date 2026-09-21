import { AppState } from 'react-native';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ConversationController } from '@mobile/journey/services/conversations/conversation-controller';
import type {
  JourneyApiControllerBinding,
  JourneyApiSubmitContext,
} from '@mobile/journey/services/thread-session/journey-api-binding';
import { prepareJourneyLocation } from '@mobile/journey/hooks/journey-location-operation';
import { conversationMessageDeadline } from '@mobile/journey/services/conversations/conversation-retention';

export type ConversationBinding = JourneyApiControllerBinding & {
  readonly conversations: NonNullable<JourneyApiControllerBinding['conversations']>;
};
export const useConversations = (binding: ConversationBinding) => {
  const controller = useMemo(
    () => new ConversationController(binding.conversations),
    [binding.conversations],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const preparing = useRef<AbortController | null>(null);
  const [locating, setLocating] = useState(false);
  const stopPreparing = () => {
    preparing.current?.abort();
    preparing.current = null;
    setLocating(false);
  };
  useEffect(() => {
    void controller.activate().catch(controller.reportError);
    const subscription = AppState.addEventListener('change', (value) => {
      if (value !== 'active') return;
      controller.expire();
      void controller.refreshList().catch(controller.reportError);
      const selected = controller.getSnapshot().selected;
      if (selected !== null)
        void controller.select(selected.conversationId).catch(controller.reportError);
    });
    return () => {
      preparing.current?.abort();
      subscription.remove();
      controller.dispose();
    };
  }, [controller]);
  useEffect(() => {
    const deadlines = state.messages
      .map(conversationMessageDeadline)
      .filter((value): value is number => value !== null);
    if (deadlines.length === 0) return;
    const timer = setTimeout(
      () => controller.expire(),
      Math.max(
        1,
        Math.min(2_147_483_647, Math.min(...deadlines) - Date.parse(binding.conversations.now())),
      ),
    );
    return () => clearTimeout(timer);
  }, [binding.conversations, controller, state.messages]);
  const submit = async (text: string, context: JourneyApiSubmitContext) => {
    if (preparing.current !== null || state.pending || state.loading) return;
    const abort = new AbortController();
    preparing.current = abort;
    setLocating(true);
    try {
      const location = await prepareJourneyLocation(binding.location, abort.signal);
      if (location.kind === 'cancelled' || preparing.current !== abort) return;
      const snapshot = controller.getSnapshot();
      const threadRequest = binding.requests.turn({
        threadId: snapshot.run?.threadId ?? 'conversation-new',
        turnId: null,
        revision: 1,
        query: text,
        context,
        location: location.snapshot,
      });
      const { turnId, revision, ...fields } = threadRequest;
      await controller.submit({
        ...fields,
        expectedRevision: snapshot.selected?.revision ?? revision,
        clientMessageId: turnId ?? binding.conversations.id(),
      });
    } catch {
      if (preparing.current === abort) controller.reportError();
    } finally {
      if (preparing.current === abort) {
        preparing.current = null;
        setLocating(false);
      }
    }
  };
  return {
    state,
    reportError: controller.reportError,
    locating,
    submit,
    select: (id: string) => {
      stopPreparing();
      return controller.select(id);
    },
    newConversation: () => {
      stopPreparing();
      controller.newConversation();
    },
    retry: () => controller.retry(),
    older: () => controller.older(),
    loadMore: () => controller.refreshList(true),
    refresh: () => controller.refreshList(),
    remove: (id: string) => controller.remove(id),
    cancel: () => {
      stopPreparing();
      return controller.cancel();
    },
  };
};
