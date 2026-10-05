export type EntryStage = 'splash' | 'choosing' | 'questions' | 'chat';
export type EntryRoute = 'chat' | 'questions';
export type EntryEvent =
  | { readonly type: 'splashFinished' }
  | { readonly type: 'choose'; readonly route: EntryRoute }
  | { readonly type: 'questionsBack' }
  | { readonly type: 'questionsFinished' };

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
      return event.type === 'questionsFinished' ? 'chat' : stage;
    case 'chat':
      return stage;
  }
}
