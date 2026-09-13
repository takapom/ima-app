import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicPlaceDetailsData, RetentionMetadata } from '@ima/contracts';
import {
  createSavedPlacePreviewController,
  type SavedPlacePreviewController,
} from '../services/saved-places/saved-place-preview-controller';
import { createSavedPlaceListService } from '../services/saved-places/saved-place-list';
import type { SavedPlaceRecord } from '../services/sqlite/types';
import type {
  LocalSavedEntryId,
  ServerSavedPlaceRef,
} from '../services/saved-places/saved-place-types';
import type {
  SavedReferenceRefreshInput,
  SavedReferenceRefreshResult,
  SavedReferenceService,
} from '../services/saved-places/saved-reference-service';

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: () => ({ remove: () => undefined }),
  },
}));

const initialNow = '2026-09-11T03:00:00.000Z';

const asLocal = (value: string): LocalSavedEntryId => value as LocalSavedEntryId;
const asServer = (value: string): ServerSavedPlaceRef => value as ServerSavedPlaceRef;

const retention: RetentionMetadata = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-11T05:00:00.000Z',
  freshUntil: '2026-09-11T04:00:00.000Z',
  displayUntil: '2026-09-11T04:30:00.000Z',
  retentionUntil: '2026-09-11T05:00:00.000Z',
  deletionScheduledAt: '2026-09-11T05:00:00.000Z',
  attribution: null,
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};

const policyWithheldRetention: RetentionMetadata = {
  ...retention,
  policyStatus: 'policy_withheld',
  displayPolicyStatus: 'policy_withheld',
};

const detailsFor = (
  candidateId: string,
  evidenceRetention: RetentionMetadata = retention,
): PublicPlaceDetailsData => ({
  items: [
    {
      candidateId,
      fields: {
        identity: {
          status: 'known',
          value: {
            name: '夜カフェ',
            area: '恵比寿',
            address: null,
            category: 'cafe',
            businessStatus: 'operational',
            sourceUrl: null,
          },
          evidence: [
            {
              evidenceId: 'evidence-1',
              attribution: null,
              retention: evidenceRetention,
            },
          ],
        },
      },
    },
  ],
});

const record = (
  savedPlaceRef: string,
  overrides: Partial<SavedPlaceRecord> = {},
): SavedPlaceRecord => ({
  localSavedEntryId: asLocal(`local-${savedPlaceRef}`),
  serverSavedPlaceRef: asServer(savedPlaceRef),
  name: savedPlaceRef === 'saved-ref-1' ? '夜カフェ' : '別の店',
  area: '恵比寿',
  savedAt: '2026-09-10T12:00:00.000Z',
  starred: true,
  decidedAt: null,
  sessionExpiresAt: '2026-09-11T05:00:00.000Z',
  displayUntil: '2026-09-11T04:30:00.000Z',
  retentionUntil: '2026-09-11T05:00:00.000Z',
  deletionScheduledAt: '2026-09-11T05:00:00.000Z',
  restoreMode: 'full',
  needsRefetch: false,
  ...overrides,
});

const refreshed = (
  savedPlaceRef: ServerSavedPlaceRef,
  evidenceRetention: RetentionMetadata = retention,
): SavedReferenceRefreshResult => ({
  status: 'refreshed',
  savedPlaceRef,
  candidateId: savedPlaceRef === 'saved-ref-1' ? 'candidate-1' : 'candidate-2',
  evidenceIds: ['evidence-1'],
  data: detailsFor(
    savedPlaceRef === 'saved-ref-1' ? 'candidate-1' : 'candidate-2',
    evidenceRetention,
  ),
});

type RefreshCall = {
  readonly input: SavedReferenceRefreshInput;
  readonly resolve: (result: SavedReferenceRefreshResult) => void;
};

const createRefreshService = (calls: RefreshCall[]): Pick<SavedReferenceService, 'refresh'> => ({
  refresh: (input) =>
    new Promise<SavedReferenceRefreshResult>((resolve) => {
      calls.push({ input, resolve });
    }),
});

describe('saved place preview controller', () => {
  const controllers: SavedPlacePreviewController[] = [];

  afterEach(() => {
    for (const controller of controllers.splice(0)) controller.dispose();
    vi.useRealTimers();
  });

  const create = (
    rows: readonly SavedPlaceRecord[] = [record('saved-ref-1'), record('saved-ref-2')],
    options: {
      readonly now?: () => string;
      readonly refreshService?: Pick<SavedReferenceService, 'refresh'>;
    } = {},
  ) => {
    const listService = createSavedPlaceListService({
      sqlite: { listSavedPlaces: () => rows },
      now: options.now ?? (() => initialNow),
    });
    const controller = createSavedPlacePreviewController({
      listService,
      now: options.now ?? (() => initialNow),
      ...(options.refreshService === undefined ? {} : { refreshService: options.refreshService }),
    });
    controllers.push(controller);
    return controller;
  };

  it('keeps the list unavailable without injected SQLite and refresh services', () => {
    const controller = createSavedPlacePreviewController();
    controllers.push(controller);

    controller.load();
    expect(controller.getState()).toMatchObject({
      status: 'closed',
      list: { status: 'unavailable', reason: 'storage_unavailable' },
    });
    expect(controller.select('saved-ref-1')).toBe(false);
  });

  it('refreshes only the selected opaque reference and exposes the validated payload', async () => {
    const calls: RefreshCall[] = [];
    const rows = [record('saved-ref-1'), record('saved-ref-2')];
    const withRows = create(rows, { refreshService: createRefreshService(calls) });

    withRows.load();
    const list = withRows.getState().list;
    expect(list.status).toBe('available');
    if (list.status !== 'available') throw new Error('expected an available list');
    expect(list.items).toHaveLength(2);
    expect(withRows.select('saved-ref-2')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input.savedPlaceRef).toBe('saved-ref-2');
    expect(withRows.getState()).toMatchObject({
      status: 'loading',
      selected: { serverSavedPlaceRef: 'saved-ref-2' },
    });

    calls[0]?.resolve(refreshed(asServer('saved-ref-2')));
    await vi.waitFor(() => expect(withRows.getState().status).toBe('ready'));
    expect(withRows.getState().payload).toMatchObject({
      savedPlaceRef: 'saved-ref-2',
      candidateId: 'candidate-2',
      evidenceIds: ['evidence-1'],
    });
  });

  it('ignores a refresh that arrives after close and aborts its request', async () => {
    const calls: RefreshCall[] = [];
    const controller = create([record('saved-ref-1')], {
      refreshService: createRefreshService(calls),
    });

    expect(controller.select('saved-ref-1')).toBe(true);
    const signal = calls[0]?.input.signal;
    controller.close();
    expect(signal?.aborted).toBe(true);
    calls[0]?.resolve(refreshed(asServer('saved-ref-1')));
    await Promise.resolve();
    expect(controller.getState()).toMatchObject({
      status: 'closed',
      selected: null,
      payload: null,
    });
  });

  it('keeps a newer selection when an earlier refresh resolves late', async () => {
    const calls: RefreshCall[] = [];
    const controller = create(undefined, { refreshService: createRefreshService(calls) });

    expect(controller.select('saved-ref-1')).toBe(true);
    expect(controller.select('saved-ref-2')).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.input.signal?.aborted).toBe(true);
    calls[0]?.resolve(refreshed(asServer('saved-ref-1')));
    await Promise.resolve();
    expect(controller.getState()).toMatchObject({
      status: 'loading',
      selected: { serverSavedPlaceRef: 'saved-ref-2' },
    });
    calls[1]?.resolve(refreshed(asServer('saved-ref-2')));
    await vi.waitFor(() => expect(controller.getState().status).toBe('ready'));
    expect(controller.getState().payload?.savedPlaceRef).toBe('saved-ref-2');
  });

  it('reports a refresh failure while preserving a non-empty saved list', async () => {
    const controller = create([record('saved-ref-1')], {
      refreshService: {
        refresh: () =>
          Promise.resolve<SavedReferenceRefreshResult>({ status: 'failed', reason: 'api' }),
      },
    });

    expect(controller.select('saved-ref-1')).toBe(true);
    await vi.waitFor(() => expect(controller.getState().status).toBe('failed'));
    expect(controller.getState()).toMatchObject({
      list: { status: 'available', items: [{ serverSavedPlaceRef: 'saved-ref-1' }] },
      failure: { reason: 'api' },
    });
  });

  it('closes a stale preview when the selected display deadline arrives', () => {
    vi.useFakeTimers();
    let current = initialNow;
    const calls: RefreshCall[] = [];
    const controller = create(
      [
        record('saved-ref-1', {
          displayUntil: '2026-09-11T03:01:00.000Z',
          retentionUntil: '2026-09-11T05:00:00.000Z',
        }),
      ],
      {
        now: () => current,
        refreshService: createRefreshService(calls),
      },
    );

    expect(controller.select('saved-ref-1')).toBe(true);
    current = '2026-09-11T03:01:00.000Z';
    vi.advanceTimersByTime(60_000);
    expect(calls[0]?.input.signal?.aborted).toBe(true);
    expect(controller.getState()).toMatchObject({
      status: 'closed',
      list: { status: 'available', items: [] },
    });
  });

  it('rechecks the deadline before displaying a response that arrived late', async () => {
    let current = initialNow;
    const calls: RefreshCall[] = [];
    const controller = create(
      [record('saved-ref-1', { displayUntil: '2026-09-11T03:01:00.000Z' })],
      { now: () => current, refreshService: createRefreshService(calls) },
    );

    expect(controller.select('saved-ref-1')).toBe(true);
    current = '2026-09-11T03:02:00.000Z';
    calls[0]?.resolve(refreshed(asServer('saved-ref-1')));
    await Promise.resolve();
    expect(controller.getState()).toMatchObject({
      status: 'closed',
      list: { status: 'available', items: [] },
    });
  });

  it('uses refreshed field retention to expire a reference-only preview without deleting its ref', async () => {
    vi.useFakeTimers();
    let current = initialNow;
    const calls: RefreshCall[] = [];
    const controller = create(
      [
        record('saved-ref-reference', {
          name: 'must be withheld',
          area: 'must be withheld',
          sessionExpiresAt: '2026-09-11T05:00:00.000Z',
          displayUntil: null,
          retentionUntil: null,
          deletionScheduledAt: null,
          restoreMode: 'reference_only',
          needsRefetch: true,
        }),
      ],
      {
        now: () => current,
        refreshService: createRefreshService(calls),
      },
    );

    expect(controller.select('saved-ref-reference')).toBe(true);
    calls[0]?.resolve(refreshed(asServer('saved-ref-reference')));
    await vi.waitFor(() => expect(controller.getState().status).toBe('ready'));
    current = '2026-09-11T04:30:00.000Z';
    vi.advanceTimersByTime(90 * 60 * 1000);
    expect(controller.getState()).toMatchObject({
      status: 'closed',
      list: { status: 'available', items: [{ serverSavedPlaceRef: 'saved-ref-reference' }] },
    });
  });

  it('withholds a known details payload when its display policy is unavailable', async () => {
    const calls: RefreshCall[] = [];
    const controller = create([record('saved-ref-1')], {
      refreshService: createRefreshService(calls),
    });

    expect(controller.select('saved-ref-1')).toBe(true);
    calls[0]?.resolve(refreshed(asServer('saved-ref-1'), policyWithheldRetention));
    await vi.waitFor(() => expect(controller.getState().status).toBe('failed'));
    expect(controller.getState()).toMatchObject({
      status: 'failed',
      payload: null,
      failure: { reason: 'retention_denied' },
    });
  });

  it('fails closed after a clock rollback and suppresses its late response', async () => {
    let current = initialNow;
    const calls: RefreshCall[] = [];
    const controller = create(
      [record('saved-ref-1', { displayUntil: '2026-09-11T03:01:00.000Z' })],
      { now: () => current, refreshService: createRefreshService(calls) },
    );

    expect(controller.select('saved-ref-1')).toBe(true);
    current = '2026-09-11T02:00:00.000Z';
    controller.recheck();
    expect(controller.getState()).toMatchObject({
      status: 'closed',
      list: { status: 'unavailable', reason: 'clock_unavailable' },
    });
    expect(calls[0]?.input.signal?.aborted).toBe(true);
    calls[0]?.resolve(refreshed(asServer('saved-ref-1')));
    await Promise.resolve();
    expect(controller.getState()).toMatchObject({
      status: 'closed',
      list: { status: 'unavailable', reason: 'clock_unavailable' },
    });
    expect(calls).toHaveLength(1);
  });

  it('fails closed when a raw clock rollback reaches the expiry timer', async () => {
    vi.useFakeTimers();
    let current = initialNow;
    const calls: RefreshCall[] = [];
    const controller = create(
      [record('saved-ref-1', { displayUntil: '2026-09-11T03:01:00.000Z' })],
      { now: () => current, refreshService: createRefreshService(calls) },
    );

    expect(controller.select('saved-ref-1')).toBe(true);
    current = '2026-09-11T02:00:00.000Z';
    vi.advanceTimersByTime(60_000);
    expect(calls[0]?.input.signal?.aborted).toBe(true);
    expect(controller.getState()).toMatchObject({
      status: 'closed',
      list: { status: 'unavailable', reason: 'clock_unavailable' },
    });
    calls[0]?.resolve(refreshed(asServer('saved-ref-1')));
    await Promise.resolve();
    expect(controller.getState()).toMatchObject({
      status: 'closed',
      list: { status: 'unavailable', reason: 'clock_unavailable' },
    });
  });

  it('rechecks a ready preview through the public method when its current deadline passes', async () => {
    let current = initialNow;
    const calls: RefreshCall[] = [];
    const controller = create(
      [record('saved-ref-1', { displayUntil: '2026-09-11T03:30:00.000Z' })],
      { now: () => current, refreshService: createRefreshService(calls) },
    );

    expect(controller.select('saved-ref-1')).toBe(true);
    calls[0]?.resolve(refreshed(asServer('saved-ref-1')));
    await vi.waitFor(() => expect(controller.getState().status).toBe('ready'));
    current = '2026-09-11T03:31:00.000Z';
    controller.recheck();
    expect(controller.getState()).toMatchObject({
      status: 'closed',
      list: { status: 'available', items: [] },
    });
  });

  it('reloads into a closed state so a cancelled loading operation cannot leave it stuck', () => {
    const calls: RefreshCall[] = [];
    const controller = create(undefined, { refreshService: createRefreshService(calls) });

    expect(controller.select('saved-ref-1')).toBe(true);
    controller.reload();
    expect(calls[0]?.input.signal?.aborted).toBe(true);
    expect(controller.getState()).toMatchObject({ status: 'closed' });
  });

  it('rejects an invalid clock and an expired or missing selection without refreshing', () => {
    const calls: RefreshCall[] = [];
    const invalidClock = create([record('saved-ref-1')], {
      now: () => 'not-a-timestamp',
      refreshService: createRefreshService(calls),
    });
    expect(invalidClock.select('saved-ref-1')).toBe(false);
    expect(invalidClock.getState()).toMatchObject({
      status: 'closed',
      list: { status: 'unavailable', reason: 'clock_unavailable' },
    });

    const missing = create([record('saved-ref-1')], {
      refreshService: createRefreshService(calls),
    });
    expect(missing.select('saved-ref-2')).toBe(false);
    expect(missing.getState().status).toBe('closed');
    expect(calls).toHaveLength(0);
  });

  it('turns an external abort into a typed failure and suppresses the late payload', async () => {
    const calls: RefreshCall[] = [];
    const controller = create([record('saved-ref-1')], {
      refreshService: createRefreshService(calls),
    });
    const external = new AbortController();

    expect(controller.select('saved-ref-1', { signal: external.signal })).toBe(true);
    external.abort();
    expect(controller.getState()).toMatchObject({
      status: 'failed',
      failure: { reason: 'aborted' },
    });
    calls[0]?.resolve(refreshed(asServer('saved-ref-1')));
    await Promise.resolve();
    expect(controller.getState().status).toBe('failed');
  });
});
