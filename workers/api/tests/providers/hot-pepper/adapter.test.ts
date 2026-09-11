import { describe, expect, it, vi } from 'vitest';
import {
  createConfiguredHotPepperAdapter,
  createHotPepperAdapter,
} from '../../../src/providers/hot-pepper/adapter';
import {
  HOT_PEPPER_PROVIDER,
  type HotPepperCandidateReference,
  type HotPepperField,
  type HotPepperFieldPolicy,
  type HotPepperPolicyUse,
  type HotPepperProviderInputPolicy,
} from '../../../src/providers/hot-pepper/types';
import type { HotPepperTransport } from '../../../src/providers/hot-pepper/transport';
import type { RuntimeProviderTransportCompletion } from '../../../src/providers/telemetry/runtime-provider-trace-contract';
import {
  parseHotPepperResponse,
  type HotPepperShopWire,
} from '../../../src/providers/hot-pepper/wire';

const candidate: HotPepperCandidateReference = {
  candidateId: 'candidate-1',
  name: 'カフェ恵比寿',
  lat: 35.6467,
  lng: 139.71,
};

const shop = (overrides: Record<string, unknown> = {}): HotPepperShopWire => {
  const parsed = parseHotPepperResponse({
    results: {
      shop: [
        {
          id: 'hp-1',
          name: 'カフェ恵比寿',
          lat: 35.6468,
          lng: 139.71,
          open: '17:00〜翌0:00（料理L.O. 23:00）',
          close: '無休',
          budget: { name: '2001〜3000円', average: '2500円' },
          urls: { pc: 'https://www.hotpepper.jp/strJ000000001' },
          wifi: 'あり',
          non_smoking: 'なし',
          private_room: '一部',
          parking: false,
          ...overrides,
        },
      ],
    },
  });
  const value = parsed.shops[0];
  if (value === undefined) throw new Error('fixture shop is missing');
  return value;
};

const transportFor = (value: HotPepperShopWire): HotPepperTransport => ({
  search: () => Promise.resolve({ shops: [value], resultsAvailable: 1, resultsStart: 1 }),
});

const fixturePolicy =
  (fields: readonly HotPepperField[], uses: readonly HotPepperPolicyUse[]): HotPepperFieldPolicy =>
  (field, use) => ({
    decision:
      (field === 'source' && use === 'attribution') ||
      (fields.includes(field) && uses.includes(use))
        ? 'allow'
        : 'deny',
    activation: 'fixture_only',
  });

const displayPolicy = fixturePolicy(['opening_hours', 'price', 'facilities'], ['display']);

const fixtureInputPolicy: HotPepperProviderInputPolicy = () => ({
  decision: 'allow',
  activation: 'fixture_only',
});

describe('Hot Pepper adapter', () => {
  it('keeps the optional provider disabled by default and does not block Places setup', () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
    expect(
      createConfiguredHotPepperAdapter(
        {
          IMA_RUNTIME_MODE: 'live',
          IMA_PROVIDER_HOTPEPPER: 'true',
          HOTPEPPER_API_KEY: undefined,
        },
        { fetcher },
      ),
    ).toBeUndefined();
    expect(
      createConfiguredHotPepperAdapter(
        {
          IMA_RUNTIME_MODE: 'live',
          IMA_PROVIDER_HOTPEPPER: 'false',
          HOTPEPPER_API_KEY: 'key-never-logged',
        },
        { fetcher },
      ),
    ).toBeUndefined();
    expect(
      createConfiguredHotPepperAdapter(
        { IMA_RUNTIME_MODE: 'fixture', IMA_PROVIDER_HOTPEPPER: 'true' },
        { policy: displayPolicy },
      ),
    ).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not send candidate data when provider-input policy is omitted', async () => {
    const search = vi.fn<HotPepperTransport['search']>(() =>
      Promise.resolve({ shops: [], resultsAvailable: 0, resultsStart: 1 }),
    );
    const adapter = createHotPepperAdapter({ transport: { search }, mode: 'fixture' });
    await expect(adapter.read(candidate, 'display')).resolves.toMatchObject({
      status: 'unsupported',
    });
    expect(search).not.toHaveBeenCalled();
  });

  it('requires an explicit fixture transport and keeps fixture policy out of live mode', async () => {
    const fixture = createConfiguredHotPepperAdapter(
      { IMA_RUNTIME_MODE: 'fixture', IMA_PROVIDER_HOTPEPPER: 'true' },
      {
        transport: transportFor(shop()),
        policy: displayPolicy,
        providerInputPolicy: fixtureInputPolicy,
      },
    );
    expect(fixture?.provider).toBe(HOT_PEPPER_PROVIDER);
    expect(fixture?.mode).toBe('fixture');
    const live = createConfiguredHotPepperAdapter(
      {
        IMA_RUNTIME_MODE: 'live',
        IMA_PROVIDER_HOTPEPPER: 'true',
        HOTPEPPER_API_KEY: 'key-never-logged',
      },
      {
        transport: transportFor(shop()),
        policy: displayPolicy,
        providerInputPolicy: fixtureInputPolicy,
      },
    );
    expect(live?.mode).toBe('live');
    const result = await live?.read(candidate, 'display');
    expect(result).toMatchObject({ status: 'unsupported' });
  });

  it('forwards an observer to the configured live transport', async () => {
    const completed: RuntimeProviderTransportCompletion[] = [];
    const observer = {
      begin: () => ({
        complete: (completion: RuntimeProviderTransportCompletion) => completed.push(completion),
      }),
    };
    const allowLive: HotPepperFieldPolicy = () => ({
      decision: 'allow',
      activation: 'live_verified',
    });
    const allowLiveInput: HotPepperProviderInputPolicy = () => ({
      decision: 'allow',
      activation: 'live_verified',
    });
    const adapter = createConfiguredHotPepperAdapter(
      {
        IMA_RUNTIME_MODE: 'live',
        IMA_PROVIDER_HOTPEPPER: 'true',
        HOTPEPPER_API_KEY: 'key-never-logged',
      },
      {
        policy: allowLive,
        providerInputPolicy: allowLiveInput,
        observer,
        fetcher: () =>
          Promise.resolve(new Response(JSON.stringify({ results: { shop: [shop()] } }))),
      },
    );
    if (adapter === undefined) throw new Error('live adapter was not configured');
    await expect(adapter.read(candidate, 'display')).resolves.toMatchObject({ status: 'ok' });
    expect(completed).toEqual([{ status: 'ok' }]);
  });

  it('applies field and attribution policy without leaking a known value', async () => {
    const denied = createHotPepperAdapter({
      transport: transportFor(shop()),
      providerInputPolicy: fixtureInputPolicy,
      mode: 'fixture',
    });
    const deniedResult = await denied.read(candidate, 'display');
    expect(deniedResult).toEqual({
      status: 'unsupported',
      reason: 'Hot Pepper attribution is withheld by provider policy',
    });

    const allowed = createHotPepperAdapter({
      transport: transportFor(shop()),
      policy: displayPolicy,
      providerInputPolicy: fixtureInputPolicy,
      mode: 'fixture',
    });
    const result = await allowed.read(candidate, 'display');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.source).toMatchObject({
      provider: HOT_PEPPER_PROVIDER,
      attribution: 'ホットペッパー',
    });
    expect(result.value.openingHours).toMatchObject({ status: 'known' });
    expect(result.value.price).toMatchObject({ status: 'known' });
    expect(result.value.facilities).toMatchObject({ status: 'known' });
  });

  it('keeps LLM and display decisions independent', async () => {
    const policy = fixturePolicy(['opening_hours'], ['llm_input']);
    const adapter = createHotPepperAdapter({
      transport: transportFor(shop()),
      policy,
      providerInputPolicy: fixtureInputPolicy,
      mode: 'fixture',
    });
    const display = await adapter.read(candidate, 'display');
    expect(display).toMatchObject({
      status: 'ok',
      value: { openingHours: { status: 'unsupported' } },
    });
    const model = await adapter.read(candidate, 'llm_input');
    expect(model).toMatchObject({ status: 'ok', value: { openingHours: { status: 'known' } } });
    if (model.status !== 'ok') return;
    expect(model.value.price).toMatchObject({ status: 'unsupported' });
    expect(model.value.facilities).toMatchObject({ status: 'unsupported' });
  });

  it('does not treat close as a closing time and withholds an unparseable LO', async () => {
    const normal = createHotPepperAdapter({
      transport: transportFor(shop({ open: '17:00〜翌0:00（料理L.O. 23:00）', close: '火曜日' })),
      policy: displayPolicy,
      providerInputPolicy: fixtureInputPolicy,
      mode: 'fixture',
    });
    const normalResult = await normal.read(candidate, 'display');
    expect(normalResult).toMatchObject({
      status: 'ok',
      value: {
        openingHours: {
          status: 'known',
          value: {
            regularHolidayText: '火曜日',
            lastOrderRaw: '料理L.O. 23:00',
            lastOrderAt: null,
          },
        },
      },
    });

    const closeOnly = createHotPepperAdapter({
      transport: transportFor(shop({ open: undefined, last_order: undefined, close: '23:00' })),
      policy: displayPolicy,
      providerInputPolicy: fixtureInputPolicy,
      mode: 'fixture',
    });
    const closeResult = await closeOnly.read(candidate, 'display');
    expect(closeResult).toMatchObject({
      status: 'ok',
      value: { openingHours: { value: { regularHolidayText: '23:00', lastOrderRaw: null } } },
    });

    const malformed = createHotPepperAdapter({
      transport: transportFor(shop({ open: '料理L.O. 不明', close: undefined })),
      policy: displayPolicy,
      providerInputPolicy: fixtureInputPolicy,
      mode: 'fixture',
    });
    const malformedResult = await malformed.read(candidate, 'display');
    expect(malformedResult).toMatchObject({
      status: 'ok',
      value: { openingHours: { status: 'unknown' } },
    });
  });

  it('retains provider price labels without inventing currency or a unit', async () => {
    const adapter = createHotPepperAdapter({
      transport: transportFor(shop({ budget: { name: '昼 1000円', average: '夜 3000円' } })),
      policy: displayPolicy,
      providerInputPolicy: fixtureInputPolicy,
      mode: 'fixture',
    });
    const result = await adapter.read(candidate, 'display');
    expect(result).toMatchObject({
      status: 'ok',
      value: {
        price: {
          status: 'known',
          value: { budgetLabel: '昼 1000円', averageLabel: '夜 3000円', unit: 'unknown' },
        },
      },
    });
  });

  it('normalizes only explicit facility values and rejects missing attribution', async () => {
    const adapter = createHotPepperAdapter({
      transport: transportFor(
        shop({ wifi: '不明', non_smoking: 'あり', private_room: 'なし', parking: '一部' }),
      ),
      policy: displayPolicy,
      providerInputPolicy: fixtureInputPolicy,
      mode: 'fixture',
    });
    const result = await adapter.read(candidate, 'display');
    expect(result).toMatchObject({
      status: 'ok',
      value: {
        facilities: {
          status: 'known',
          value: { wifi: 'unknown', nonSmoking: 'yes', privateRoom: 'no', parking: 'partial' },
        },
      },
    });

    const noSource = createHotPepperAdapter({
      transport: transportFor(shop({ urls: undefined })),
      policy: displayPolicy,
      providerInputPolicy: fixtureInputPolicy,
      mode: 'fixture',
    });
    const noSourceResult = await noSource.read(candidate, 'display');
    expect(noSourceResult).toMatchObject({
      status: 'error',
      error: { code: 'MISSING_ATTRIBUTION' },
    });

    const conflictingSource = createHotPepperAdapter({
      transport: transportFor(
        shop({ urls: { pc: 'https://attacker.invalid/shop?token=must-not-pass' } }),
      ),
      policy: displayPolicy,
      providerInputPolicy: fixtureInputPolicy,
      mode: 'fixture',
    });
    await expect(conflictingSource.read(candidate, 'display')).resolves.toMatchObject({
      status: 'error',
      error: { code: 'SOURCE_CONFLICT' },
    });
  });

  it('returns typed upstream failures and validates candidates before transport', async () => {
    const failing: HotPepperTransport = {
      search: () => Promise.reject(new Error('provider secret body')),
    };
    const adapter = createHotPepperAdapter({
      transport: failing,
      policy: displayPolicy,
      providerInputPolicy: fixtureInputPolicy,
      mode: 'fixture',
    });
    const failure = await adapter.read(candidate, 'display');
    expect(failure).toMatchObject({ status: 'error', error: { code: 'UPSTREAM_UNAVAILABLE' } });
    expect(JSON.stringify(failure)).not.toContain('provider secret body');

    const search = vi.fn<HotPepperTransport['search']>(() =>
      Promise.resolve({ shops: [], resultsAvailable: 0, resultsStart: 1 }),
    );
    const invalid = createHotPepperAdapter({
      transport: { search },
      policy: displayPolicy,
      providerInputPolicy: fixtureInputPolicy,
      mode: 'fixture',
    });
    const invalidResult = await invalid.read({ ...candidate, lat: 91 }, 'display');
    expect(invalidResult).toMatchObject({ status: 'error', error: { code: 'INVALID_REQUEST' } });
    expect(search).not.toHaveBeenCalled();
  });
});
