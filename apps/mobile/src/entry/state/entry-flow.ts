export type EntryStage = 'splash' | 'choosing' | 'questions' | 'complete' | 'chat';
export type EntryRoute = 'chat' | 'questions';
export type EntryEvent =
  | { readonly type: 'splashFinished' }
  | { readonly type: 'choose'; readonly route: EntryRoute }
  | { readonly type: 'questionsBack' }
  | { readonly type: 'questionsFinished' }
  | { readonly type: 'completionFinished' };

/** Whether the chat underneath can take over once the entry gets out of the way. */
export type ChatReadiness = 'preparing' | 'ready' | 'unavailable';

export function chatReadiness({
  connected,
  status,
}: {
  readonly connected: boolean;
  readonly status: 'loading' | 'ready' | 'error';
}): ChatReadiness {
  if (connected) return 'ready';
  return status === 'loading' ? 'preparing' : 'unavailable';
}

/** The connection and error screens are shown as they are, without the splash or the choice. */
export function entryCovers(stage: EntryStage, readiness: ChatReadiness): boolean {
  return readiness !== 'unavailable' && stage !== 'chat';
}

/** The splash stays still while the chat is preparing and moves on only once it is ready. */
export function introMayStart(readiness: ChatReadiness): boolean {
  return readiness === 'ready';
}

/** Every launch starts on the splash; the choice is not remembered between launches. */
export const initialEntryStage: EntryStage = 'splash';

export function reduceEntryStage(stage: EntryStage, event: EntryEvent): EntryStage {
  switch (stage) {
    case 'splash':
      return event.type === 'splashFinished' ? 'choosing' : stage;
    case 'choosing':
      return event.type === 'choose' ? event.route : stage;
    case 'questions':
      if (event.type === 'questionsBack') return 'choosing';
      return event.type === 'questionsFinished' ? 'complete' : stage;
    case 'complete':
      return event.type === 'completionFinished' ? 'chat' : stage;
    case 'chat':
      return stage;
  }
}
