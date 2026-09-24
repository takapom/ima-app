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

/** True once a details result for the candidate reached the model (the item carries `fields`). */
export const detailsShownFor = (prompt: string, candidateId: string): boolean => {
  let shown = false;
  const visit = (value: unknown): void => {
    if (shown) return;
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
    if (record.candidateId === candidateId && typeof record.fields === 'object') shown = true;
    Object.values(record).forEach(visit);
  };
  try {
    visit(JSON.parse(prompt));
  } catch {
    return false;
  }
  return shown;
};

const placeFor = (id: string) => ({
  id,
  name: LLM_INPUT_CANARY,
  address: '東京都渋谷区',
  lat: 35.6595,
  lng: 139.7005,
  genre: { name: 'カフェ' },
  open: DENIED_FIELD_CANARY,
  close: '無休',
  urls: { pc: `https://www.hotpepper.jp/str${id}/` },
});

export const fetcherForProduction =
  (report: ProductionProviderFixtureReport, scenario: () => ProductionScenario): typeof fetch =>
  (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    report.fetchUrls.push(
      `${url.origin}${url.pathname}${url.searchParams.has('id') ? `?id=${url.searchParams.get('id')}` : ''}`,
    );
    if (
      request.method !== 'GET' ||
      url.origin !== 'https://webservice.recruit.co.jp' ||
      url.pathname !== '/hotpepper/gourmet/v1/'
    ) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    const id = url.searchParams.get('id');
    const shops =
      id !== null
        ? [placeFor(id)]
        : scenario() === 'zero-results'
          ? []
          : scenario() === 'two-results'
            ? [placeFor('m16-production-place-1'), placeFor('m16-production-place-2')]
            : [placeFor('m16-production-place')];
    if (id === null) report.searchResultCounts.push(shops.length);
    return Promise.resolve(
      Response.json({
        results: { shop: shops, results_available: shops.length, results_start: 1 },
      }),
    );
  };
