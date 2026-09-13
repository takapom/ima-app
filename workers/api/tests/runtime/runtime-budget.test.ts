import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUNTIME_BUDGET,
  RuntimeBudget,
  type RuntimeBudgetConfig,
} from '../../src/runtime/budget/runtime-budget';

const config = (overrides: Partial<RuntimeBudgetConfig> = {}): RuntimeBudgetConfig => ({
  ...DEFAULT_RUNTIME_BUDGET,
  ...overrides,
});

const readRequest = {
  operation: 'search_places' as const,
  costUnits: 1,
  providerHttpRequests: 1,
  routeElements: 0,
};

describe('RuntimeBudget', () => {
  it('reserves model steps before the final response window', () => {
    let now = 0;
    const budget = new RuntimeBudget({
      config: config({ maxModelSteps: 2 }),
      startedAtMs: 0,
      now: () => now,
    });

    expect(budget.reserveModelStep().ok).toBe(true);
    expect(budget.reserveModelStep().ok).toBe(true);
    expect(budget.reserveModelStep()).toMatchObject({
      ok: false,
      denial: { code: 'BUDGET_EXCEEDED' },
    });

    now = 10_000;
    const reserveBlocked = new RuntimeBudget({ startedAtMs: 0, now: () => now });
    expect(reserveBlocked.reserveModelStep()).toMatchObject({
      ok: false,
      denial: { code: 'FINAL_RESERVE' },
    });
    expect(reserveBlocked.reserveModelStep(true).ok).toBe(true);
    now = 12_000;
    expect(reserveBlocked.reserveModelStep(true)).toMatchObject({
      ok: false,
      denial: { code: 'DEADLINE' },
    });
  });

  it('reserves read costs and releases only the concurrency slot', () => {
    const budget = new RuntimeBudget({
      config: config({ maxParallelReads: 2, maxReadCalls: 2, maxCostUnits: 2 }),
      startedAtMs: 0,
      now: () => 1,
    });
    const first = budget.reserveRead(readRequest);
    const second = budget.reserveRead({ ...readRequest, operation: 'get_place_details' });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(budget.reserveRead(readRequest)).toMatchObject({
      ok: false,
      denial: { code: 'PARALLEL_LIMIT' },
    });
    if (!first.ok || !second.ok) throw new Error('read reservation setup failed');

    first.value.release();
    expect(budget.snapshot()).toMatchObject({
      readCalls: 2,
      activeReads: 1,
      providerHttpRequests: 2,
      costUnits: 2,
    });
    expect(budget.reserveRead(readRequest)).toMatchObject({
      ok: false,
      denial: { code: 'BUDGET_EXCEEDED' },
    });
    second.value.release();
    second.value.release();
    expect(budget.snapshot().activeReads).toBe(0);
  });

  it('admits resolver provider work only after a read slot and charges it once', () => {
    const budget = new RuntimeBudget({
      config: config({ maxReadCalls: 1, maxParallelReads: 1, maxCostUnits: 2 }),
      startedAtMs: 0,
      now: () => 1,
    });
    expect(budget.reserveProviderRequest()).toMatchObject({
      ok: false,
      denial: { code: 'BUDGET_EXCEEDED' },
    });

    expect(budget.reserveReadSlot('details-call')).toEqual({ ok: true, value: undefined });
    expect(budget.reserveProviderRequest()).toEqual({ ok: true, value: undefined });
    const reservation = budget.reserveRead({
      callId: 'details-call',
      operation: 'get_place_details',
      costUnits: 0,
      providerHttpRequests: 0,
      routeElements: 0,
    });
    expect(reservation.ok).toBe(true);
    expect(budget.snapshot()).toMatchObject({
      readCalls: 1,
      activeReads: 1,
      providerHttpRequests: 1,
      costUnits: 1,
    });
    if (!reservation.ok) throw new Error('read reservation setup failed');
    reservation.value.release();
    expect(budget.snapshot().activeReads).toBe(0);
  });

  it('bridges cancellation into the resolver read slot and cleans up its signal', () => {
    const external = new AbortController();
    const budget = new RuntimeBudget({ startedAtMs: 0, now: () => 1 });

    expect(budget.reserveReadSlot('details-cancel', external.signal)).toEqual({
      ok: true,
      value: undefined,
    });
    const admissionSignal = budget.readSignalFor('details-cancel');
    expect(admissionSignal?.aborted).toBe(false);

    external.abort();
    expect(admissionSignal?.aborted).toBe(true);
    budget.releaseReadSlot('details-cancel');
    expect(budget.readSignalFor('details-cancel')).toBeUndefined();
    expect(budget.snapshot().activeReads).toBe(0);
  });

  it('reserves retry attempts and rejects non-retryable failures', () => {
    let now = 1_000;
    const budget = new RuntimeBudget({
      config: config({ maxReadRetries: 1, maxProviderHttpRequests: 2 }),
      startedAtMs: 0,
      now: () => now,
    });
    const reservation = budget.reserveRead(readRequest);
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) throw new Error('read reservation setup failed');

    expect(reservation.value.retry('argument')).toMatchObject({
      ok: false,
      denial: { code: 'RETRY_NOT_ALLOWED' },
    });
    expect(reservation.value.retry('transport', 100)).toEqual({ ok: true, delayMs: 100 });
    expect(budget.snapshot()).toMatchObject({
      readRetries: 1,
      providerHttpRequests: 2,
      costUnits: 2,
      routeElements: 0,
    });
    reservation.value.release();
    expect(reservation.value.retry('server')).toMatchObject({
      ok: false,
      denial: { code: 'RETRY_NOT_ALLOWED' },
    });

    now = 9_999;
    const late = new RuntimeBudget({
      config: config({ maxReadRetries: 1 }),
      startedAtMs: 0,
      now: () => now,
    });
    const lateReservation = late.reserveRead(readRequest);
    expect(lateReservation.ok).toBe(true);
    if (!lateReservation.ok) throw new Error('late reservation setup failed');
    expect(lateReservation.value.retry('rate_limited', 2)).toMatchObject({
      ok: false,
      denial: { code: 'FINAL_RESERVE' },
    });
  });

  it('reserves every retry at the original request cost and snapshots mutable input', () => {
    const budget = new RuntimeBudget({
      config: config({
        maxProviderHttpRequests: 6,
        maxCostUnits: 12,
        maxRouteElements: 8,
      }),
      startedAtMs: 0,
      now: () => 1,
    });
    const expensiveRequest = {
      operation: 'search_places' as const,
      costUnits: 4,
      providerHttpRequests: 3,
      routeElements: 2,
    };
    const reservation = budget.reserveRead(expensiveRequest);
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) throw new Error('read reservation setup failed');

    expensiveRequest.costUnits = 0;
    expensiveRequest.providerHttpRequests = 0;
    expensiveRequest.routeElements = 0;
    expect(reservation.value.retry('server')).toEqual({ ok: true, delayMs: 0 });
    expect(budget.snapshot()).toMatchObject({
      providerHttpRequests: 6,
      costUnits: 8,
      routeElements: 4,
      readRetries: 1,
    });

    const overBudget = new RuntimeBudget({
      config: config({ maxProviderHttpRequests: 5 }),
      startedAtMs: 0,
      now: () => 1,
    });
    const overBudgetReservation = overBudget.reserveRead({
      ...expensiveRequest,
      costUnits: 4,
      providerHttpRequests: 3,
      routeElements: 2,
    });
    expect(overBudgetReservation.ok).toBe(true);
    if (!overBudgetReservation.ok) throw new Error('over-budget reservation setup failed');
    expect(overBudgetReservation.value.retry('transport')).toMatchObject({
      ok: false,
      denial: { code: 'BUDGET_EXCEEDED' },
    });
  });

  it('gives the initial submit two repairs and stops after the third attempt', () => {
    const budget = new RuntimeBudget({ startedAtMs: 0, now: () => 1 });
    const first = budget.reserveSubmit();
    const second = budget.reserveSubmit();
    const third = budget.reserveSubmit();
    expect(first).toMatchObject({ ok: true, value: { remainingRepairs: 2 } });
    expect(second).toMatchObject({ ok: true, value: { remainingRepairs: 1 } });
    expect(third).toMatchObject({ ok: true, value: { remainingRepairs: 0 } });
    expect(budget.reserveSubmit()).toMatchObject({
      ok: false,
      denial: { code: 'BUDGET_EXCEEDED' },
    });
  });

  it('propagates abort and stale turn without starting paid work', () => {
    const controller = new AbortController();
    const budget = new RuntimeBudget({ signal: controller.signal, startedAtMs: 0, now: () => 1 });
    controller.abort('user-cancelled');
    expect(budget.reserveRead(readRequest)).toMatchObject({
      ok: false,
      denial: { code: 'CANCELLED' },
    });

    let stale = false;
    const staleBudget = new RuntimeBudget({
      isStale: () => stale,
      startedAtMs: 0,
      now: () => 1,
    });
    stale = true;
    expect(staleBudget.reserveModelStep()).toMatchObject({
      ok: false,
      denial: { code: 'STALE_TURN' },
    });
  });

  it('checks read admission without mutating counters or cancellation state', () => {
    let now = 1;
    const budget = new RuntimeBudget({
      config: config({ wholeTurnMs: 12_000, finalReserveMs: 2_000 }),
      startedAtMs: 0,
      now: () => now,
    });
    const before = budget.snapshot();

    expect(budget.checkAdmission()).toBeUndefined();
    expect(budget.remainingReadTimeMs()).toBe(9_999);
    expect(budget.snapshot()).toEqual(before);

    now = 100;
    expect(budget.remainingReadTimeMs()).toBe(9_900);
    now = 1;
    expect(budget.remainingReadTimeMs()).toBe(9_900);

    now = 10_000;
    expect(budget.checkAdmission()).toMatchObject({ code: 'FINAL_RESERVE' });
    expect(budget.snapshot()).toEqual(before);
  });

  it('denies all further reservations after a committed response', () => {
    const budget = new RuntimeBudget({ startedAtMs: 0, now: () => 1 });
    budget.markCommitted();
    expect(budget.reserveModelStep()).toMatchObject({
      ok: false,
      denial: { code: 'COMMITTED' },
    });
    expect(budget.reserveRead(readRequest)).toMatchObject({
      ok: false,
      denial: { code: 'COMMITTED' },
    });
    expect(budget.reserveSubmit()).toMatchObject({
      ok: false,
      denial: { code: 'COMMITTED' },
    });
  });

  it('rejects unsafe limits instead of allowing an unbounded turn', () => {
    expect(
      () => new RuntimeBudget({ config: config({ wholeTurnMs: Number.POSITIVE_INFINITY }) }),
    ).toThrow('RUNTIME_BUDGET_CONFIGURATION');
    expect(() => new RuntimeBudget({ config: config({ maxRepairAttempts: 3 }) })).toThrow(
      'RUNTIME_BUDGET_CONFIGURATION',
    );
    expect(() => new RuntimeBudget({ config: config({ sdkRetryLimit: 1 }) })).toThrow(
      'RUNTIME_BUDGET_CONFIGURATION',
    );
  });
});
