import type { Candidate, Evidence } from './types';

type FacilityValue = 'yes' | 'no' | 'partial';

/**
 * One shop as the Hot Pepper Gourmet API returns it, with the facility values the Worker is
 * expected to derive. The fixed provider serves `wire` and the dataset derives its evidence from
 * the same record, so the evaluation cannot drift from what the model is shown.
 */
export type ModelEvalShop = {
  readonly candidateId: string;
  readonly wire: {
    readonly id: string;
    readonly name: string;
    readonly genre: { readonly name: string };
    readonly budget: { readonly name: string };
    readonly open: string;
    readonly close: string;
    readonly catch: string;
    readonly station_name: string;
    readonly wifi: string;
    readonly non_smoking: string;
    readonly private_room: string;
    readonly parking: string;
  };
  readonly facilities: {
    readonly wifi: FacilityValue;
    readonly nonSmoking: FacilityValue;
    readonly privateRoom: FacilityValue;
    readonly parking: FacilityValue;
  };
};

const shop = (
  candidateId: string,
  id: string,
  wire: Omit<ModelEvalShop['wire'], 'id' | 'station_name'>,
  facilities: ModelEvalShop['facilities'],
): ModelEvalShop => ({
  candidateId,
  wire: { id, station_name: '渋谷', ...wire },
  facilities,
});

/** Ten shops that differ in genre, price band, hours, listing copy and facilities. */
export const MODEL_EVAL_SHOPS: readonly ModelEvalShop[] = [
  shop(
    'candidate-a',
    'eval-place-a',
    {
      name: '青葉カフェ',
      genre: { name: 'カフェ' },
      budget: { name: '1001～1500円' },
      open: '月～日: 9:00～22:00',
      close: '無休',
      catch: '窓際のソファ席でゆっくり過ごせるカフェ',
      wifi: 'あり',
      non_smoking: '全面禁煙',
      private_room: 'なし',
      parking: 'なし',
    },
    { wifi: 'yes', nonSmoking: 'yes', privateRoom: 'no', parking: 'no' },
  ),
  shop(
    'candidate-b',
    'eval-place-b',
    {
      name: '川辺食堂',
      genre: { name: '和食' },
      budget: { name: '501～1000円' },
      open: '月～土: 11:00～21:00',
      close: '日',
      catch: '定食と甘味の食堂',
      wifi: 'なし',
      non_smoking: '全面禁煙',
      private_room: 'なし',
      parking: 'あり',
    },
    { wifi: 'no', nonSmoking: 'yes', privateRoom: 'no', parking: 'yes' },
  ),
  shop(
    'candidate-c',
    'eval-place-c',
    {
      name: '駅前ベーカリー',
      genre: { name: 'パン' },
      budget: { name: '～500円' },
      open: '月～日: 7:00～20:00',
      close: '不定休',
      catch: 'イートインもできるベーカリー',
      wifi: 'なし',
      non_smoking: '全面禁煙',
      private_room: 'なし',
      parking: 'なし',
    },
    { wifi: 'no', nonSmoking: 'yes', privateRoom: 'no', parking: 'no' },
  ),
  shop(
    'candidate-d',
    'eval-place-d',
    {
      name: '夜更かし甘味処',
      genre: { name: 'スイーツ' },
      budget: { name: '1001～1500円' },
      open: '月～日: 18:00～翌1:00',
      close: '無休',
      catch: '食後のパフェと落ち着いたカウンター席',
      wifi: 'あり',
      non_smoking: '全面禁煙',
      private_room: 'なし',
      parking: 'なし',
    },
    { wifi: 'yes', nonSmoking: 'yes', privateRoom: 'no', parking: 'no' },
  ),
  shop(
    'candidate-e',
    'eval-place-e',
    {
      name: '石畳バル',
      genre: { name: 'バル' },
      budget: { name: '3001～4000円' },
      open: '月～日: 17:00～24:00',
      close: '無休',
      catch: '立ち飲み中心のにぎやかなバル',
      wifi: 'なし',
      non_smoking: '一部禁煙',
      private_room: 'なし',
      parking: 'なし',
    },
    { wifi: 'no', nonSmoking: 'partial', privateRoom: 'no', parking: 'no' },
  ),
  shop(
    'candidate-f',
    'eval-place-f',
    {
      name: '灯りの二軒目',
      genre: { name: 'バー' },
      budget: { name: '2001～3000円' },
      open: '月～土: 19:00～翌2:00',
      close: '日',
      catch: '屋内のソファ席で長く話せるバー',
      wifi: 'あり',
      non_smoking: '全面禁煙',
      private_room: 'あり',
      parking: 'なし',
    },
    { wifi: 'yes', nonSmoking: 'yes', privateRoom: 'yes', parking: 'no' },
  ),
  shop(
    'candidate-g',
    'eval-place-g',
    {
      name: '高台ダイニング',
      genre: { name: 'ダイニングバー' },
      budget: { name: '7001～10000円' },
      open: '月～日: 17:00～23:00',
      close: '無休',
      catch: '夜景を望むコース中心のダイニング',
      wifi: 'あり',
      non_smoking: '全面禁煙',
      private_room: 'あり',
      parking: 'あり',
    },
    { wifi: 'yes', nonSmoking: 'yes', privateRoom: 'yes', parking: 'yes' },
  ),
  shop(
    'candidate-h',
    'eval-place-h',
    {
      name: '珈琲とソファ',
      genre: { name: '喫茶' },
      budget: { name: '501～1000円' },
      open: '月～日: 10:00～23:00',
      close: '無休',
      catch: '深い椅子で休める昔ながらの喫茶店',
      wifi: 'あり',
      non_smoking: '全面禁煙',
      private_room: 'なし',
      parking: 'なし',
    },
    { wifi: 'yes', nonSmoking: 'yes', privateRoom: 'no', parking: 'no' },
  ),
  shop(
    'candidate-i',
    'eval-place-i',
    {
      name: '横丁の屋台',
      genre: { name: '居酒屋' },
      budget: { name: '2001～3000円' },
      open: '月～日: 16:00～翌3:00',
      close: '無休',
      catch: '屋外の立ち席が中心の横丁',
      wifi: 'なし',
      non_smoking: '禁煙席なし',
      private_room: 'なし',
      parking: 'なし',
    },
    { wifi: 'no', nonSmoking: 'no', privateRoom: 'no', parking: 'no' },
  ),
  shop(
    'candidate-j',
    'eval-place-j',
    {
      name: '静かな茶房',
      genre: { name: '和カフェ' },
      budget: { name: '1001～1500円' },
      open: '火～日: 12:00～21:00',
      close: '月',
      catch: '抹茶と和菓子を座敷でゆっくり',
      wifi: 'なし',
      non_smoking: '全面禁煙',
      private_room: 'あり',
      parking: 'なし',
    },
    { wifi: 'no', nonSmoking: 'yes', privateRoom: 'yes', parking: 'no' },
  ),
];

export const MODEL_EVAL_CANDIDATES: readonly Candidate[] = MODEL_EVAL_SHOPS.map((item) => ({
  id: item.candidateId,
  displayName: item.wire.name,
}));

const FRESH_UNTIL = '2026-09-10T18:00:00.000Z';

/** Evidence in the production field shapes the model and the public card see. */
export const evidenceForShop = (item: ModelEvalShop): readonly Evidence[] => {
  const key = item.candidateId.replace('candidate-', 'ev-');
  const entry = (field: Evidence['field'], value: Evidence['value']): Evidence => ({
    id: `${key}-${field}`,
    subjectId: item.candidateId,
    field,
    value,
    source: 'provider',
    freshUntil: FRESH_UNTIL,
  });
  return [
    entry('identity', {
      name: item.wire.name,
      category: item.wire.genre.name,
      listingText: item.wire.catch,
    }),
    entry('opening_hours', { weeklyText: [item.wire.open, `定休日: ${item.wire.close}`] }),
    entry('price', { rawLabel: item.wire.budget.name }),
    entry('facilities', item.facilities),
  ];
};
