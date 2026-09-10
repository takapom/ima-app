import type { LiveTraceRecorder } from '../../tooling/model-eval/live';

export const MODEL_EVAL_NOW = '2026-09-10T12:00:00.000Z';
/** Context-seed profile runs at 19:00 JST so every fixture candidate is still open. */
export const MODEL_EVAL_CONTEXT_NOW = '2026-09-10T10:00:00.000Z';

type FixturePlace = {
  readonly id: string;
  readonly name: string;
  readonly priceLevel: 'PRICE_LEVEL_INEXPENSIVE' | 'PRICE_LEVEL_MODERATE';
  readonly closeHour: number;
};

const fixturePlaces: readonly FixturePlace[] = [
  { id: 'eval-place-a', name: '青葉カフェ', priceLevel: 'PRICE_LEVEL_MODERATE', closeHour: 22 },
  { id: 'eval-place-b', name: '川辺食堂', priceLevel: 'PRICE_LEVEL_INEXPENSIVE', closeHour: 21 },
  { id: 'eval-place-c', name: '駅前ベーカリー', priceLevel: 'PRICE_LEVEL_MODERATE', closeHour: 20 },
];

/** The evaluator joins these provider record identities to dataset IDs exactly. */
export const MODEL_EVAL_FIXTURE_CANDIDATE_IDENTITIES = [
  { provider: 'google_places', recordRef: 'eval-place-a', evaluationCandidateId: 'candidate-a' },
  { provider: 'google_places', recordRef: 'eval-place-b', evaluationCandidateId: 'candidate-b' },
  { provider: 'google_places', recordRef: 'eval-place-c', evaluationCandidateId: 'candidate-c' },
] as const;

const localHourFor = (now: string): number => {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(now)),
  );
  return Number.isInteger(hour) ? hour : 0;
};

const placeBody = (place: FixturePlace, now: string): Record<string, unknown> => ({
  id: place.id,
  displayName: { text: place.name },
  formattedAddress: '東京都渋谷区',
  primaryType: 'cafe',
  businessStatus: 'OPERATIONAL',
  googleMapsUri: `https://maps.google.com/?cid=${place.id}`,
  currentOpeningHours: {
    periods: [
      {
        open: { date: { year: 2026, month: 9, day: 10 }, hour: 9, minute: 0 },
        close: {
          date: { year: 2026, month: 9, day: 10 },
          hour: place.closeHour,
          minute: 0,
        },
      },
    ],
    weekdayDescriptions: [`毎日 9:00–${place.closeHour}:00`],
    openNow: place.closeHour > localHourFor(now),
  },
  timeZone: { id: 'Asia/Tokyo' },
  attributions: [{ provider: 'Google Maps', providerUri: 'https://maps.google.com' }],
  priceLevel: place.priceLevel,
});

export const fixedPlacesFetcher =
  (trace: LiveTraceRecorder, now = MODEL_EVAL_NOW): typeof fetch =>
  (input, init) => {
    trace.upstreamCall();
    const request = new Request(input, init);
    if (request.url.endsWith('/v1/places:searchText')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ places: fixturePlaces.map((place) => placeBody(place, now)) }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
    }
    const id = decodeURIComponent(new URL(request.url).pathname.split('/').at(-1) ?? '');
    const place = fixturePlaces.find((candidate) => candidate.id === id);
    return Promise.resolve(
      place === undefined
        ? new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
        : new Response(JSON.stringify(placeBody(place, now)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
    );
  };
