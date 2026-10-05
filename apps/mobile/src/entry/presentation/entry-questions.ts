export type EntryQuestionOption = {
  readonly label: string;
  /** How the answer reads in the chat message; null when the answer adds nothing. */
  readonly phrase: string | null;
};

export type EntryQuestion = {
  readonly id: EntryQuestionId;
  readonly title: string;
  readonly options: readonly EntryQuestionOption[];
};

export type EntryQuestionId = 'party' | 'food' | 'style' | 'budget' | 'mood';

/** Answers keyed by question id, holding the chosen option label. */
export type EntryAnswers = Readonly<Partial<Record<EntryQuestionId, string>>>;

const option = (label: string, phrase: string | null): EntryQuestionOption => ({ label, phrase });
const NO_PREFERENCE = option('こだわらない', null);

const PARTY: EntryQuestion = {
  id: 'party',
  title: '誰といく？',
  options: [
    option('家族', '家族と'),
    option('カップル', '恋人と'),
    option('友人', '友だちと'),
    option('仕事仲間', '仕事仲間と'),
    option('ひとり', 'ひとりで'),
  ],
};

const FOODS = [
  {
    food: option('和食', '和食がいい'),
    styleTitle: '和食の系統は？',
    styles: [
      option('定食', '和食の定食がいい'),
      option('居酒屋', '和食の居酒屋がいい'),
      option('うどん・そば', 'うどんかそばがいい'),
      option('寿司', '寿司がいい'),
    ],
  },
  {
    food: option('洋食', '洋食がいい'),
    styleTitle: '洋食の系統は？',
    styles: [
      option('イタリアン', 'イタリアンがいい'),
      option('フレンチ', 'フレンチがいい'),
      option('ハンバーグ・洋食屋', 'ハンバーグとか洋食屋がいい'),
      option('バル', 'バルがいい'),
    ],
  },
  {
    food: option('中華', '中華がいい'),
    styleTitle: '中華の系統は？',
    styles: [
      option('ラーメン', 'ラーメンがいい'),
      option('町中華', '町中華がいい'),
      option('点心・飲茶', '点心や飲茶がいい'),
      option('四川・辛いもの', '辛い四川料理がいい'),
    ],
  },
  {
    food: option('エスニック', 'エスニックがいい'),
    styleTitle: 'どこの料理がいい？',
    styles: [
      option('タイ', 'タイ料理がいい'),
      option('インド・カレー', 'インド料理かカレーがいい'),
      option('韓国', '韓国料理がいい'),
      option('ベトナム', 'ベトナム料理がいい'),
    ],
  },
  {
    food: option('カフェ・甘いもの', 'カフェか甘いものがいい'),
    styleTitle: 'どんなお店がいい？',
    styles: [
      option('カフェ', 'カフェがいい'),
      option('ケーキ・スイーツ', 'ケーキかスイーツの店がいい'),
      option('パン', 'パン屋がいい'),
      option('パフェ・和菓子', 'パフェか和菓子がいい'),
    ],
  },
] as const;

export const FOOD_LABELS: readonly string[] = FOODS.map(({ food }) => food.label);

const FOOD: EntryQuestion = {
  id: 'food',
  title: '何を食べたい？',
  options: FOODS.map(({ food }) => food),
};

const BUDGET: EntryQuestion = {
  id: 'budget',
  title: '予算はどのくらい？',
  options: [
    option('〜2,000円', '予算は2,000円くらいまで'),
    option('〜4,000円', '予算は4,000円くらいまで'),
    option('〜7,000円', '予算は7,000円くらいまで'),
    option('いくらでも', '予算は気にしない'),
  ],
};

/** A preference for the conversation to weigh, not a promise about how the place will be. */
const MOOD: EntryQuestion = {
  id: 'mood',
  title: 'お店の雰囲気は？',
  options: [
    option('個室がいい', '個室があるとうれしい'),
    option('落ち着いた店', '落ち着いた雰囲気がいい'),
    option('にぎやかでいい', 'にぎやかでも大丈夫'),
    NO_PREFERENCE,
  ],
};

function styleQuestion(food: string | undefined): EntryQuestion {
  const chosen = FOODS.find((entry) => entry.food.label === food);
  return {
    id: 'style',
    title: chosen?.styleTitle ?? 'お店の系統は？',
    options: chosen === undefined ? [] : [...chosen.styles, NO_PREFERENCE],
  };
}

/**
 * The questions as they stand for the answers so far; the style question follows the food.
 * Only conditions the conversation can search with; walking time and last trains stay out (#55).
 */
export function questionsFor(answers: EntryAnswers): readonly EntryQuestion[] {
  return [PARTY, FOOD, styleQuestion(answers.food), BUDGET, MOOD];
}

/** Writes the answers as one message in the same short style as the chat examples. */
export function composeQuestionQuery(answers: EntryAnswers): string {
  const phraseOf = (question: EntryQuestion): string | null =>
    question.options.find((candidate) => candidate.label === answers[question.id])?.phrase ?? null;
  const [party, food, style, budget, mood] = questionsFor(answers).map(phraseOf);
  return [party, style ?? food, budget, mood]
    .filter((phrase): phrase is string => phrase !== null && phrase !== undefined)
    .map((phrase) => `${phrase}。`)
    .join('');
}

export type ProgressSegment = 'done' | 'current' | 'todo';

export function progressSegments(answered: number, total: number): ProgressSegment[] {
  const done = Math.min(Math.max(answered, 0), total);
  return Array.from({ length: total }, (_, index) =>
    index < done ? 'done' : index === done ? 'current' : 'todo',
  );
}
