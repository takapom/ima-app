export type EntryQuestionOption = {
  readonly label: string;
  /** How the answer reads inside the chat message sent to the conversation. */
  readonly phrase: string;
};

export type EntryQuestion = {
  readonly id: string;
  readonly title: string;
  readonly options: readonly EntryQuestionOption[];
};

/** Only conditions the conversation can search with; walking time and last trains stay out (#55). */
export const ENTRY_QUESTIONS: readonly EntryQuestion[] = [
  {
    id: 'party',
    title: '誰といく？',
    options: [
      { label: '家族', phrase: '家族と' },
      { label: 'カップル', phrase: '恋人と' },
      { label: '友人', phrase: '友だちと' },
      { label: '仕事仲間', phrase: '仕事仲間と' },
    ],
  },
  {
    id: 'food',
    title: '何を食べたい？',
    options: [
      { label: '和食', phrase: '和食がいい' },
      { label: '洋食', phrase: '洋食がいい' },
      { label: '中華', phrase: '中華がいい' },
      { label: 'エスニック', phrase: 'エスニックがいい' },
    ],
  },
  {
    id: 'budget',
    title: '予算はどのくらい？',
    options: [
      { label: '〜2,000円', phrase: '予算は2,000円くらいまで' },
      { label: '〜4,000円', phrase: '予算は4,000円くらいまで' },
      { label: '〜7,000円', phrase: '予算は7,000円くらいまで' },
      { label: 'いくらでも', phrase: '予算は気にしない' },
    ],
  },
];

/** Answers keyed by question id, holding the chosen option label. */
export type EntryAnswers = Readonly<Record<string, string>>;

/** Writes the answers as one message in the same short style as the chat examples. */
export function composeQuestionQuery(answers: EntryAnswers): string {
  return ENTRY_QUESTIONS.flatMap((question) => {
    const option = question.options.find((candidate) => candidate.label === answers[question.id]);
    return option === undefined ? [] : [`${option.phrase}。`];
  }).join('');
}

export function questionProgress(answered: number, total: number): boolean[] {
  const filled = Math.min(Math.max(answered, 0), total);
  return Array.from({ length: total }, (_, index) => index < filled);
}
