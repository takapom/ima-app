import { presentGeneratedText } from '@mobile/journey/components/candidates/candidate-card-model';
import type { FocusedCard } from '@mobile/journey/state/card-set-focus';

export type CompanionSpeech = {
  readonly text: string;
  readonly position: string | null;
  readonly relation: '今回の提案' | '前の提案';
};

/** What the dog says about the card in view; the generated reason is never reworded. */
export const companionSpeech = (focused: FocusedCard | null): CompanionSpeech | null =>
  focused === null
    ? null
    : {
        text: presentGeneratedText(focused.card.why).text,
        position: focused.count > 1 ? `${focused.index + 1} / ${focused.count}` : null,
        relation: focused.latest ? '今回の提案' : '前の提案',
      };
