import { describe, expect, it } from 'vitest';
import type { GetPlaceDetailsInput, PlaceDetailsPort } from '@ima/core';
import { createHotPepperAdapter } from '../../../src/providers/hot-pepper/adapter';
import {
  createHotPepperDetailsOverlay,
  createHotPepperReuseFilter,
  type HotPepperDetailsOverlayOptions,
} from '../../../src/providers/hot-pepper/composition';
import type { PlacesDetailsObservationPolicy } from '../../../src/providers/places-details/adapter-types';
import type {
  HotPepperField,
  HotPepperFieldPolicy,
  HotPepperPolicyUse,
  HotPepperProviderInputPolicy,
} from '../../../src/providers/hot-pepper/types';
import type { HotPepperTransport } from '../../../src/providers/hot-pepper/transport';
import {
  parseHotPepperResponse,
  type HotPepperSearchPage,
  type HotPepperShopWire,
} from '../../../src/providers/hot-pepper/wire';
import { reprojectHotPepperField } from '../../../src/providers/hot-pepper/policy-projection';
import {
  context,
  execution,
  makeFixture,
  place,
  readInput,
  SCOPE,
} from '../places-details/adapter-fixtures';

const shopFor = (id: string): HotPepperShopWire => {
  const parsed = parseHotPepperResponse({
    results: {
      shop: [
        {
          id: `hp-${id}`,
          name: `候補 ${id}`,
          lat: 35.6595,
          lng: 139.7005,
          open: '11:00〜22:00',
          close: '無休',
          budget: { name: '昼 1000円', average: '夜 3000円' },
          urls: { pc: 'https://www.hotpepper.jp/strJ000000001' },
          wifi: 'あり',
          non_smoking: 'なし',
          private_room: '一部',
          parking: 'あり',
        },
      ],
    },
  });
  const shop = parsed.shops[0];
  if (shop === undefined) throw new Error('Hot Pepper fixture shop is missing');
  return shop;
};

const hpFieldPolicy: HotPepperFieldPolicy = (field: HotPepperField, use: HotPepperPolicyUse) => ({
  decision:
    (field === 'source' && use === 'attribution') ||
    (['price', 'facilities'].includes(field) && use === 'llm_input')
      ? 'allow'
      : 'deny',
  activation: 'fixture_only',
});

const hpInputPolicy: HotPepperProviderInputPolicy = () => ({
  decision: 'allow',
  activation: 'fixture_only',
});

const hpObservationPolicy: PlacesDetailsObservationPolicy = () => ({
  freshUntil: '2026-09-10T12:00:00.000Z',
  expiresAt: '2026-09-10T23:00:00.000Z',
  retention: {
    retentionDecision: 'allow',
    retentionMode: 'provider_limited',
    sessionExpiresAt: '2026-09-11T00:00:00.000Z',
    freshUntil: '2026-09-10T12:00:00.000Z',
    displayUntil: '2026-09-10T18:00:00.000Z',
    retentionUntil: '2026-09-10T23:00:00.000Z',
    deletionScheduledAt: '2026-09-10T23:00:00.000Z',
    attribution: { label: 'ホットペッパー', sourceLink: 'https://www.hotpepper.jp' },
    restoreMode: 'full',
    policyStatus: 'available',
    displayPolicyStatus: 'available',
  },
});

type OverlayFixture = {
  readonly candidateId: string;
  readonly calls: HotPepperSearchPage[];
  readonly hotPepperObservationCount: () => number;
  readonly read: (input: GetPlaceDetailsInput) => ReturnType<PlaceDetailsPort['read']>;
  readonly exclude: () => void;
};

const fixtureFor = (
  options: {
    readonly policy?: HotPepperFieldPolicy;
    readonly providerInputPolicy?: HotPepperProviderInputPolicy;
    readonly mode?: 'fixture' | 'live';
    readonly transport?: HotPepperTransport;
    readonly googlePrice?: boolean;
    readonly reserveProviderRequest?: () => boolean;
    readonly signalFor?: HotPepperDetailsOverlayOptions['signalFor'];
  } = {},
): OverlayFixture => {
  const fixture = makeFixture();
  const candidateId = fixture.candidateIds[0];
  if (candidateId === undefined) throw new Error('candidate fixture is missing');
  if (options.googlePrice === false) {
    fixture.setBody((id) => {
      const body = place(id);
      delete body.priceLevel;
      return body;
    });
  }
  const pages: HotPepperSearchPage[] = [];
  const configuredTransport =
    options.transport ??
    ({
      search: () => {
        return Promise.resolve({
          shops: [shopFor('place-a')],
          resultsAvailable: 1,
          resultsStart: 1,
        });
      },
    } satisfies HotPepperTransport);
  const transport: HotPepperTransport = {
    search: async (request, signal) => {
      const page = await configuredTransport.search(request, signal);
      pages.push(page);
      return page;
    },
  };
  const adapter = createHotPepperAdapter({
    transport,
    mode: options.mode ?? 'fixture',
    policy: options.policy ?? hpFieldPolicy,
    providerInputPolicy: options.providerInputPolicy ?? hpInputPolicy,
  });
  const overlay = createHotPepperDetailsOverlay({
    inner: fixture.adapter,
    adapter,
    registry: fixture.registry,
    clock: fixture.clock,
    observationPolicy: hpObservationPolicy,
    fieldPolicy: options.policy ?? hpFieldPolicy,
    candidateReferenceFor: (candidate) => ({
      candidateId: candidate.candidateId,
      name: candidate.displayName,
      lat: 35.6595,
      lng: 139.7005,
    }),
    reserveProviderRequest: options.reserveProviderRequest ?? (() => true),
    ...(options.signalFor === undefined ? {} : { signalFor: options.signalFor }),
  });
  return {
    candidateId,
    calls: pages,
    hotPepperObservationCount: () =>
      fixture.registry
        .listObservations(SCOPE, candidateId)
        .filter((observation) =>
          observation.sources.some((source) => source.provider === 'hotpepper'),
        ).length,
    read: (input) => overlay.read(input, context, execution, { isCancelled: () => false }),
    exclude: () => {
      fixture.registry.excludeCandidate(SCOPE, candidateId);
    },
  };
};

describe('Hot Pepper Details overlay', () => {
  it('adds HP facilities while retaining Google fields and HP retention metadata', async () => {
    const fixture = fixtureFor();
    const result = await fixture.read(
      readInput(fixture.candidateId, ['identity', 'price', 'facilities']),
    );

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const item = result.data.items[0];
    expect(item?.fields.price).toMatchObject({ status: 'known' });
    expect(item?.fields.facilities).toMatchObject({
      status: 'known',
      observations: [
        {
          value: {
            wifi: 'yes',
            nonSmoking: 'no',
            privateRoom: 'partial',
            parking: 'yes',
          },
          sources: [{ provider: 'hotpepper' }],
          retention: {
            attribution: { label: 'ホットペッパー' },
            retentionDecision: 'deny',
            retentionUntil: null,
            deletionScheduledAt: null,
            restoreMode: 'unavailable',
            policyStatus: 'policy_withheld',
            displayPolicyStatus: 'policy_withheld',
          },
        },
      ],
    });
    expect(item?.fields.identity).toMatchObject({
      status: 'known',
      observations: [{ sources: [{ provider: 'google_places' }] }],
    });
    expect(fixture.calls).toHaveLength(1);
  });

  it('keeps Places results when HP input or llm policy is denied', async () => {
    const inputDenied = fixtureFor({
      providerInputPolicy: () => ({ decision: 'deny', activation: 'fixture_only' }),
    });
    const inputResult = await inputDenied.read(readInput(inputDenied.candidateId, ['facilities']));
    expect(inputResult.status).toBe('partial');
    expect(inputDenied.calls).toHaveLength(0);

    const fieldDenied: HotPepperFieldPolicy = (field, use) => ({
      decision: field === 'source' && use === 'attribution' ? 'allow' : 'deny',
      activation: 'fixture_only',
    });
    const fieldFixture = fixtureFor({ policy: fieldDenied });
    const fieldResult = await fieldFixture.read(
      readInput(fieldFixture.candidateId, ['facilities']),
    );
    expect(fieldResult.status).toBe('partial');
    expect(fieldFixture.calls).toHaveLength(0);
  });

  it('reuses only an HP-only observation and does not call HP again', async () => {
    const fixture = fixtureFor();
    const first = await fixture.read(readInput(fixture.candidateId, ['facilities']));
    expect(first.status).toBe('ok');
    const second = await fixture.read(
      readInput(fixture.candidateId, ['facilities'], 'reuse_valid'),
    );
    expect(second.status).toBe('ok');
    expect(fixture.calls).toHaveLength(1);
    if (second.status !== 'ok') return;
    expect(second.data.items[0]?.fields.facilities).toMatchObject({ status: 'known' });
  });

  it('does not reuse a stored HP value after its LLM policy is withdrawn', async () => {
    let allowed = true;
    const policy: HotPepperFieldPolicy = (field, use) =>
      allowed ? hpFieldPolicy(field, use) : { decision: 'deny', activation: 'fixture_only' };
    const fixture = fixtureFor({ policy });
    const first = await fixture.read(readInput(fixture.candidateId, ['facilities']));
    expect(first.status).toBe('ok');
    allowed = false;

    const second = await fixture.read(
      readInput(fixture.candidateId, ['facilities'], 'reuse_valid'),
    );

    expect(second.status).toBe('partial');
    if (second.status !== 'partial') return;
    expect(second.data.items[0]?.fields.facilities).toMatchObject({ status: 'unsupported' });
    expect(fixture.calls).toHaveLength(1);
  });

  it('keeps the Places result and makes no HP call when the extra budget is exhausted', async () => {
    const fixture = fixtureFor({ reserveProviderRequest: () => false });
    const result = await fixture.read(readInput(fixture.candidateId, ['facilities']));

    expect(result.status).toBe('partial');
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.hotPepperObservationCount()).toBe(0);
  });

  it('uses an HP price label only when the Places price is unknown', async () => {
    const fixture = fixtureFor({ googlePrice: false });
    const result = await fixture.read(readInput(fixture.candidateId, ['price']));

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.items[0]?.fields.price).toMatchObject({
      status: 'known',
      observations: [
        {
          value: { level: null, range: null, rawLabel: '昼 1000円 / 夜 3000円' },
          sources: [{ provider: 'hotpepper' }],
        },
      ],
    });
    expect(fixture.calls).toHaveLength(1);
  });

  it('does not register a late HP response after the candidate is excluded', async () => {
    let resolve: ((page: HotPepperSearchPage) => void) | undefined;
    let signalStarted: () => void = () => undefined;
    const started = new Promise<void>((resolveStarted) => {
      signalStarted = resolveStarted;
    });
    const transport: HotPepperTransport = {
      search: () => {
        signalStarted();
        return new Promise<HotPepperSearchPage>((resolvePage) => {
          resolve = resolvePage;
        });
      },
    };
    const fixture = fixtureFor({ transport });
    const pending = fixture.read(readInput(fixture.candidateId, ['facilities']));
    await started;
    fixture.exclude();
    resolve?.({ shops: [shopFor('place-a')], resultsAvailable: 1, resultsStart: 1 });
    const result = await pending;

    expect(result.status).toBe('partial');
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.hotPepperObservationCount()).toBe(0);
  });

  it('does not use fixture-only policy in a live overlay', async () => {
    const fixture = fixtureFor({ mode: 'live' });
    const result = await fixture.read(readInput(fixture.candidateId, ['facilities']));
    expect(result.status).toBe('partial');
    expect(fixture.calls).toHaveLength(0);
  });

  it('filters a stored HP field when the optional adapter is disabled', async () => {
    const fixture = fixtureFor();
    const first = await fixture.read(readInput(fixture.candidateId, ['facilities']));
    expect(first.status).toBe('ok');
    const googleOnly = createHotPepperReuseFilter(
      {
        read: () => Promise.resolve(first),
      },
      hpFieldPolicy,
      'live',
    );
    const filtered = await googleOnly.read(
      readInput(fixture.candidateId, ['facilities'], 'reuse_valid'),
      context,
      execution,
      { isCancelled: () => false },
    );

    expect(filtered.status).toBe('partial');
    if (filtered.status !== 'partial') return;
    expect(filtered.data.items[0]?.fields.facilities).toMatchObject({ status: 'unsupported' });
    expect(fixture.calls).toHaveLength(1);
  });

  it('withholds a field whose observations mix HP and another provider', () => {
    const policy: HotPepperFieldPolicy = (field, use) => ({
      decision:
        (field === 'source' && use === 'attribution') ||
        (field === 'facilities' && use === 'llm_input')
          ? 'allow'
          : 'deny',
      activation: 'live_verified',
    });
    const mixed = {
      status: 'known',
      observations: [
        { sources: [{ provider: 'hotpepper' }] },
        { sources: [{ provider: 'google_places' }] },
      ],
    };

    expect(reprojectHotPepperField(policy, 'live', 'facilities', mixed)).toMatchObject({
      status: 'unsupported',
    });
  });

  it('reprojects stored HP retention when display or persistence is withdrawn', async () => {
    let allowStorage = true;
    const policy: HotPepperFieldPolicy = (field, use) => ({
      decision:
        (field === 'source' && use === 'attribution') ||
        (['price', 'facilities'].includes(field) && use === 'llm_input') ||
        (allowStorage && (use === 'display' || use === 'persistence'))
          ? 'allow'
          : 'deny',
      activation: 'live_verified',
    });
    const fixture = fixtureFor({ policy });
    const first = await fixture.read(readInput(fixture.candidateId, ['facilities']));
    expect(first.status).toBe('ok');
    allowStorage = false;

    const googleOnly = createHotPepperReuseFilter(
      { read: () => Promise.resolve(first) },
      policy,
      'live',
    );
    const projected = await googleOnly.read(
      readInput(fixture.candidateId, ['facilities'], 'reuse_valid'),
      context,
      execution,
      { isCancelled: () => false },
    );

    expect(projected.status).toBe('ok');
    if (projected.status !== 'ok') return;
    expect(projected.data.items[0]?.fields.facilities).toMatchObject({
      status: 'known',
      observations: [
        {
          retention: {
            retentionDecision: 'deny',
            policyStatus: 'policy_withheld',
            displayPolicyStatus: 'policy_withheld',
            retentionUntil: null,
            deletionScheduledAt: null,
            restoreMode: 'unavailable',
          },
        },
      ],
    });
    expect(fixture.calls).toHaveLength(1);
  });

  it('keeps the sanitized HP field when signal resolution fails after reprojection', async () => {
    let allowLlm = true;
    let allowStorage = true;
    let failSignal = false;
    const policy: HotPepperFieldPolicy = (field, use) => ({
      decision:
        (field === 'source' && use === 'attribution') ||
        (['price', 'facilities'].includes(field) && use === 'llm_input' && allowLlm) ||
        (['price', 'facilities'].includes(field) &&
          (use === 'display' || use === 'persistence') &&
          allowStorage)
          ? 'allow'
          : 'deny',
      activation: 'live_verified',
    });
    const fixture = fixtureFor({
      policy,
      signalFor: () => {
        if (failSignal) throw new Error('signal bridge unavailable');
        return undefined;
      },
    });
    const first = await fixture.read(readInput(fixture.candidateId, ['facilities']));
    expect(first.status).toBe('ok');
    allowLlm = false;
    allowStorage = false;
    failSignal = true;

    const second = await fixture.read(
      readInput(fixture.candidateId, ['facilities'], 'reuse_valid'),
    );

    expect(second.status).toBe('partial');
    if (second.status !== 'partial') return;
    expect(second.data.items[0]?.fields.facilities).toMatchObject({ status: 'unsupported' });
    expect(fixture.calls).toHaveLength(1);
  });
});
