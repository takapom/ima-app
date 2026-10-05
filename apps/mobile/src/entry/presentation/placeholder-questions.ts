export type PlaceholderQuestion = {
  readonly id: string;
  readonly title: string;
  readonly options: readonly string[];
};

/** Stand-in steps for the question route; answers are not sent to the chat yet. */
export const PLACEHOLDER_QUESTIONS: readonly PlaceholderQuestion[] = [
  { id: 'party', title: '誰といく？', options: ['家族', 'カップル', '友人', '仕事仲間'] },
  { id: 'food', title: '何を食べたい？', options: ['和食', '洋食', '中華', 'エスニック'] },
  {
    id: 'budget',
    title: '予算はどのくらい？',
    options: ['〜2,000円', '〜4,000円', '〜7,000円', 'いくらでも'],
  },
];

export function questionProgress(answered: number, total: number): boolean[] {
  const filled = Math.min(Math.max(answered, 0), total);
  return Array.from({ length: total }, (_, index) => index < filled);
}
