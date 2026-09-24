import type { LiveTraceRecorder } from '../../tooling/model-eval/live';
import { MODEL_EVAL_SHOPS, type ModelEvalShop } from '../../tooling/model-eval/fixture-shops';
import { MODEL_EVAL_STORE_INSTRUCTION_TEXT } from './model-eval-prompt-injection';

export const MODEL_EVAL_NOW = '2026-09-10T12:00:00.000Z';
/** Context-seed profile runs at 19:00 JST so every fixture candidate is still open. */
export const MODEL_EVAL_CONTEXT_NOW = '2026-09-10T10:00:00.000Z';

export type ModelEvalPlacesResponseMode =
  'normal' | 'empty' | 'upstream-failure' | 'schema-failure';
export type ModelEvalPlaceDisplayNameMode = 'normal' | 'duplicate';
export type ModelEvalPlacePayloadMode = 'normal' | 'store-instruction';

export const MODEL_EVAL_PRIVATE_UPSTREAM_BODY_SENTINEL = 'M25_FIXTURE_PRIVATE_UPSTREAM_BODY';

/** The evaluator joins these provider record identities to dataset IDs exactly. */
export const MODEL_EVAL_FIXTURE_CANDIDATE_IDENTITIES = MODEL_EVAL_SHOPS.map((shop) => ({
  provider: 'hotpepper' as const,
  recordRef: shop.wire.id,
  evaluationCandidateId: shop.candidateId,
}));

/** The catalogue shop as the Gourmet Search API returns it; only the listing copy can vary. */
const shopBody = (
  shop: ModelEvalShop,
  displayName: string,
  payloadMode: ModelEvalPlacePayloadMode,
): Record<string, unknown> => ({
  ...shop.wire,
  name: displayName,
  catch:
    payloadMode === 'store-instruction' && shop.wire.id === 'eval-place-b'
      ? `${shop.wire.catch}（${MODEL_EVAL_STORE_INSTRUCTION_TEXT}）`
      : shop.wire.catch,
  address: '東京都渋谷区',
  lat: 35.6595,
  lng: 139.7005,
  urls: { pc: `https://www.hotpepper.jp/str${shop.wire.id}/` },
});

const pageOf = (url: URL): { readonly start: number; readonly count: number } => {
  const start = Number(url.searchParams.get('start') ?? '1');
  const count = Number(url.searchParams.get('count') ?? '10');
  return {
    start: Number.isSafeInteger(start) && start >= 1 ? start : 1,
    count: Number.isSafeInteger(count) && count >= 1 ? count : 10,
  };
};

export const fixedPlacesFetcher =
  (
    trace: LiveTraceRecorder,
    observeSearchQuery?: (query: string) => void,
    responseMode: ModelEvalPlacesResponseMode = 'normal',
    displayNameMode: ModelEvalPlaceDisplayNameMode = 'normal',
    payloadMode: ModelEvalPlacePayloadMode = 'normal',
  ): typeof fetch =>
  (input, init) => {
    trace.upstreamCall();
    const url = new URL(new Request(input, init).url);
    if (
      url.origin !== 'https://webservice.recruit.co.jp' ||
      url.pathname !== '/hotpepper/gourmet/v1/'
    ) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    const id = url.searchParams.get('id');
    if (id === null) observeSearchQuery?.(url.searchParams.get('keyword') ?? '');
    if (responseMode === 'upstream-failure')
      return Promise.resolve(
        Response.json({ error: MODEL_EVAL_PRIVATE_UPSTREAM_BODY_SENTINEL }, { status: 503 }),
      );
    if (responseMode === 'schema-failure')
      return Promise.resolve(Response.json({ results: { shop: 'invalid' } }));
    const ids = id?.split(',') ?? null;
    const matched =
      responseMode === 'empty'
        ? []
        : MODEL_EVAL_SHOPS.filter((shop) => ids === null || ids.includes(shop.wire.id));
    // Search honors the requested page like the API; a details read names its shops.
    const { start, count } = pageOf(url);
    const places = ids === null ? matched.slice(start - 1, start - 1 + count) : matched;
    return Promise.resolve(
      Response.json({
        results: {
          results_available: matched.length,
          results_start: start,
          shop: places.map((shop) =>
            shopBody(
              shop,
              displayNameMode === 'duplicate' && shop.wire.id === 'eval-place-b'
                ? (MODEL_EVAL_SHOPS[0]?.wire.name ?? shop.wire.name)
                : shop.wire.name,
              payloadMode,
            ),
          ),
        },
      }),
    );
  };
