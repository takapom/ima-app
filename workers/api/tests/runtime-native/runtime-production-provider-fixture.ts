export const LLM_INPUT_CANARY = 'M16_LLM_INPUT_CANARY';
export const DENIED_FIELD_CANARY = 'M16_DENIED_FIELD_CANARY';

export type ProductionScenario =
  | 'default'
  | 'photo'
  | 'multiturn'
  | 'follow-up'
  | 'condition-change'
  | 'final-reserve'
  | 'late-tool'
  | 'late-submit'
  | 'exhausted-budget'
  | 'zero-results'
  | 'two-results';

export type ProductionProviderFixtureReport = {
  readonly fetchUrls: string[];
  readonly searchResultCounts: number[];
};

export const productionScenarioFor = (value: unknown): ProductionScenario => {
  if (typeof value !== 'object' || value === null || !('input' in value)) return 'default';
  const input = value.input;
  if (typeof input !== 'object' || input === null || !('text' in input)) return 'default';
  if (typeof input.text !== 'string') return 'default';
  if (input.text.includes('[m16-photo]')) return 'photo';
  if (input.text.includes('[m24-zero-results]')) return 'zero-results';
  if (input.text.includes('[m24-two-results]')) return 'two-results';
  if (input.text.includes('[m16-exhausted-budget]')) return 'exhausted-budget';
  if (input.text.includes('[m16-late-submit]')) return 'late-submit';
  if (input.text.includes('[m16-late-tool]')) return 'late-tool';
  if (input.text.includes('[m16-final-reserve]')) return 'final-reserve';
  if (input.text.includes('[m16-follow-up]')) return 'follow-up';
  if (input.text.includes('[m16-condition-change]')) return 'condition-change';
  if (input.text.includes('[m16-multiturn]')) return 'multiturn';
  return 'default';
};

export const observationIdsForCandidateIn = (prompt: string, candidateId: string): string[] => {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object' || value === null) {
      if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
        try {
          visit(JSON.parse(value));
        } catch {
          // Model text is not necessarily JSON; only envelopes are traversed.
        }
      }
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.candidateId === candidateId && typeof record.observationId === 'string') {
      ids.add(record.observationId);
    }
    Object.values(record).forEach(visit);
  };
  try {
    visit(JSON.parse(prompt));
  } catch {
    return [];
  }
  return [...ids];
};

const placeFor = (id: string, cid: string) => ({
  id,
  displayName: { text: LLM_INPUT_CANARY },
  formattedAddress: '東京都渋谷区',
  primaryType: 'cafe',
  businessStatus: 'OPERATIONAL',
  googleMapsUri: `https://maps.google.com/?cid=${cid}`,
  photos: [
    {
      name: `places/${id}/photos/m16-production-photo`,
      widthPx: 1_200,
      heightPx: 900,
      authorAttributions: [
        {
          displayName: 'Ima fixture photo author',
          uri: 'https://fixture.example/photo-author',
        },
      ],
      googleMapsUri: `https://maps.google.com/?cid=${cid}`,
    },
  ],
  currentOpeningHours: {
    periods: [
      {
        open: { date: { year: 2026, month: 9, day: 10 }, hour: 9, minute: 0 },
        close: { date: { year: 2026, month: 9, day: 10 }, hour: 23, minute: 0 },
      },
    ],
    weekdayDescriptions: [DENIED_FIELD_CANARY],
    nextCloseTime: '2026-09-10T14:00:00.000Z',
    openNow: true,
  },
  timeZone: { id: 'Asia/Tokyo' },
  attributions: [{ provider: 'Google Maps', providerUri: 'https://maps.google.com' }],
});

export const fetcherForProduction =
  (report: ProductionProviderFixtureReport, scenario: () => ProductionScenario): typeof fetch =>
  (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    report.fetchUrls.push(request.url);
    if (
      request.method === 'POST' &&
      url.origin === 'https://places.googleapis.com' &&
      url.pathname === '/v1/places:searchText' &&
      url.search === ''
    ) {
      const places =
        scenario() === 'zero-results'
          ? []
          : scenario() === 'two-results'
            ? [
                placeFor('m16-production-place-1', 'm16-production-1'),
                placeFor('m16-production-place-2', 'm16-production-2'),
              ]
            : [placeFor('m16-production-place', 'm16-production')];
      report.searchResultCounts.push(places.length);
      return Promise.resolve(
        new Response(JSON.stringify({ places }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
    const allowedIds = new Set([
      'm16-production-place',
      'm16-production-place-1',
      'm16-production-place-2',
    ]);
    if (
      request.method !== 'GET' ||
      url.origin !== 'https://places.googleapis.com' ||
      url.search !== '' ||
      !/^\/v1\/places\/[^/]+$/u.test(url.pathname) ||
      !allowedIds.has(id)
    ) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'FIXTURE_ENDPOINT_NOT_FOUND' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    const cid =
      id === 'm16-production-place'
        ? 'm16-production'
        : id.replace('m16-production-place-', 'm16-production-');
    return Promise.resolve(
      new Response(JSON.stringify(placeFor(id, cid)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
