import type { ModelContextFieldPolicy, RetentionMetadata } from '@ima/core';
import { ThreadDO as ProductionThreadDO } from '../../src/thread-do';
import { createLiveOpenAIProvider } from '../../src/model/provider';
import { sessionExpiryAt } from '../../src/runtime/runtime-production-support';
import {
  LiveTraceRecorder,
  wrapModelForLiveEvaluation,
  type LiveTraceSnapshot,
} from '../../tooling/model-eval/live';

export const MODEL_EVAL_NOW = '2026-09-10T12:00:00.000Z';

type ModelEvalEnv = Cloudflare.Env & {
  readonly OPENAI_API_KEY?: string;
  readonly MODEL_EVAL_LIVE?: string;
};

const retentionFor = (sessionExpiresAt: string): RetentionMetadata => ({
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt,
  freshUntil: '2026-09-10T18:00:00.000Z',
  displayUntil: '2026-09-10T20:00:00.000Z',
  retentionUntil: '2026-09-10T22:00:00.000Z',
  deletionScheduledAt: '2026-09-10T22:00:00.000Z',
  attribution: { label: 'Google Places', sourceLink: 'https://maps.google.com' },
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
});

const modelPolicy: ModelContextFieldPolicy = {
  evidence: {
    identity: 'allow',
    opening_hours: 'allow',
    price: 'allow',
    photos: 'deny',
    contact: 'deny',
    facilities: 'deny',
    walking_route: 'deny',
    last_train: 'deny',
  },
  history: 'allow',
  cardSet: 'allow',
  displayName: 'allow',
};

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

const placeBody = (place: FixturePlace): Record<string, unknown> => ({
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
    openNow: true,
  },
  timeZone: { id: 'Asia/Tokyo' },
  attributions: [{ provider: 'Google Maps', providerUri: 'https://maps.google.com' }],
  priceLevel: place.priceLevel,
});

export const fixedPlacesFetcher =
  (trace: LiveTraceRecorder): typeof fetch =>
  (input, init) => {
    trace.upstreamCall();
    const request = new Request(input, init);
    if (request.url.endsWith('/v1/places:searchText')) {
      return Promise.resolve(
        new Response(JSON.stringify({ places: fixturePlaces.map(placeBody) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    const id = decodeURIComponent(request.url.split('/').at(-1) ?? '');
    const place = fixturePlaces.find((candidate) => candidate.id === id);
    return Promise.resolve(
      place === undefined
        ? new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
        : new Response(JSON.stringify(placeBody(place)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
    );
  };

export class ModelEvalThreadDO extends ProductionThreadDO {
  override maxSteps = 6;
  private readonly liveEnv: ModelEvalEnv;
  private readonly liveTrace = new LiveTraceRecorder();
  private liveModel = 'unknown';

  constructor(ctx: DurableObjectState, env: ModelEvalEnv) {
    super(ctx, env);
    this.liveEnv = env;
  }

  getModelEvalTrace(): LiveTraceSnapshot {
    return this.liveTrace.snapshot();
  }

  getModelEvalProfile(): { readonly model: string; readonly promptVersion: string } {
    return { model: this.liveModel, promptVersion: 'm25-production-default-v1' };
  }

  protected override createRuntimeProductionOverrides() {
    const base = super.createRuntimeProductionOverrides();
    const provider = createLiveOpenAIProvider(this.liveEnv);
    this.liveModel = provider.profile.model;
    const sessionExpiresAt = sessionExpiryAt(base.threadCreatedAt ?? MODEL_EVAL_NOW);
    const retention = retentionFor(sessionExpiresAt);
    const policy = () => ({
      freshUntil: retention.freshUntil ?? sessionExpiresAt,
      expiresAt: retention.retentionUntil ?? sessionExpiresAt,
      retention,
    });
    return {
      ...base,
      modelForTurn: wrapModelForLiveEvaluation(provider.model, this.liveTrace),
      fetcher: fixedPlacesFetcher(this.liveTrace),
      googlePlacesApiKey: 'model-eval-fixed-provider-key',
      placesCursorSecret: 'model-eval-fixed-cursor-secret',
      observationPolicy: policy,
      detailsObservationPolicy: policy,
      modelContextFieldPolicy: modelPolicy,
      placesEnabled: true,
      retention,
      clock: () => MODEL_EVAL_NOW,
      monotonicNow: () => performance.now(),
      epochNow: () => Date.parse(MODEL_EVAL_NOW),
    };
  }
}

export default {
  fetch(): Response {
    return new Response('model-eval-live worker', { status: 404 });
  },
};
