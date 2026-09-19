import { describe, expect, it } from 'vitest';
import type { Preferences } from '@ima/contracts';
import type { JourneyApiController } from '@mobile/journey/services/thread-session/journey-controller-types';
import {
  createNativeJourneyPersistence,
  type NativeJourneyPersistenceScheduler,
  type NativeJourneyPersistenceStorage,
} from '@mobile/composition/persistence/native-journey-persistence';
import type { ThreadRecord } from '@mobile/platform/sqlite/types';

const thread = (id: string, expiresAt = '2026-09-10T19:00:00.000Z'): ThreadRecord => ({
  id,
  createdAt: '2026-09-10T18:00:00.000Z',
  expiresAt,
});

const storageFor = (
  listThreads: () => readonly ThreadRecord[],
): NativeJourneyPersistenceStorage => ({
  listThreads,
  readPreferences: (): null => null,
  savePreferences: (_preferences: Preferences): void => undefined,
});

type SourceHarness = {
  readonly controller: Pick<JourneyApiController, 'subscribe'>;
  readonly subscribeForeground: (listener: (status: string) => void) => () => void;
  readonly emitController: () => void;
  readonly emitControllerAt: (index: number) => void;
  readonly emitForeground: (status: string) => void;
  readonly emitForegroundAt: (index: number, status: string) => void;
  readonly controllerUnsubscribed: () => boolean;
  readonly foregroundUnsubscribed: () => boolean;
};

const sourceHarness = (): SourceHarness => {
  const controllerListeners: (() => void)[] = [];
  const foregroundListeners: ((status: string) => void)[] = [];
  let controllerWasUnsubscribed = false;
  let foregroundWasUnsubscribed = false;
  return {
    controller: {
      subscribe: (listener) => {
        controllerListeners.push(listener);
        return () => {
          controllerWasUnsubscribed = true;
        };
      },
    },
    subscribeForeground: (listener) => {
      foregroundListeners.push(listener);
      return () => {
        foregroundWasUnsubscribed = true;
      };
    },
    emitController: () => controllerListeners.at(-1)?.(),
    emitControllerAt: (index) => controllerListeners[index]?.(),
    emitForeground: (status) => foregroundListeners.at(-1)?.(status),
    emitForegroundAt: (index, status) => foregroundListeners[index]?.(status),
    controllerUnsubscribed: () => controllerWasUnsubscribed,
    foregroundUnsubscribed: () => foregroundWasUnsubscribed,
  };
};

const schedulerFor = (): {
  readonly scheduler: NativeJourneyPersistenceScheduler;
  readonly delays: number[];
  readonly fire: (handle: number) => void;
  readonly activeTimers: () => number;
} => {
  let nextHandle = 0;
  const timers = new Map<number, () => void>();
  const callbacks = new Map<number, () => void>();
  const delays: number[] = [];
  return {
    scheduler: {
      schedule: (callback, delayMilliseconds) => {
        const handle = nextHandle;
        nextHandle += 1;
        timers.set(handle, callback);
        callbacks.set(handle, callback);
        delays.push(delayMilliseconds);
        return handle;
      },
      cancel: (handle) => {
        if (typeof handle === 'number') timers.delete(handle);
      },
    },
    delays,
    fire: (handle) => {
      timers.delete(handle);
      callbacks.get(handle)?.();
    },
    activeTimers: () => timers.size,
  };
};

describe('native journey persistence composition', () => {
  it('shares one SQLite projection and distinguishes empty history from failure', () => {
    const rows: ThreadRecord[] = [];
    const sources = sourceHarness();
    let reads = 0;
    const storage = storageFor(() => {
      reads += 1;
      return rows;
    });
    const persistence = createNativeJourneyPersistence({
      sqlite: storage,
      controller: sources.controller,
      subscribeForeground: sources.subscribeForeground,
      scope: 'scope-a',
    });
    const notifications: number[] = [];
    persistence.subscribe(() => notifications.push(reads));
    const deactivate = persistence.activate();
    const preferences = persistence.preferences;

    expect(preferences).toBeDefined();
    expect(preferences?.read().status).toBe('available');
    expect(persistence.getSnapshot()).toMatchObject({
      scope: 'scope-a',
      historyStatus: 'available',
      historyUnavailable: false,
      history: [],
      nextExpiryAt: null,
    });
    expect(reads).toBe(1);

    rows.push(thread('thread-a'));
    sources.emitController();
    expect(persistence.getSnapshot().history.map((item) => item.id)).toEqual(['thread-a']);
    expect(persistence.getSnapshot().historyResult).toMatchObject({
      status: 'available',
      nextExpiryAt: '2026-09-10T19:00:00.000Z',
    });
    expect(persistence.preferences).toBe(preferences);
    expect(notifications).toHaveLength(2);

    deactivate();
    persistence.dispose();
    const failed = createNativeJourneyPersistence({
      sqlite: storageFor(() => {
        throw new Error('read failed');
      }),
      scope: 'scope-a',
    });
    failed.activate();
    expect(failed.getSnapshot()).toMatchObject({
      historyStatus: 'unavailable',
      historyUnavailable: true,
      historyResult: { status: 'unavailable', reason: 'storage_unavailable' },
    });
  });

  it('re-activates after cleanup and refreshes at the earliest row expiry', () => {
    const sources = sourceHarness();
    const scheduled = schedulerFor();
    let current = '2026-09-10T18:00:00.000Z';
    let rows: readonly ThreadRecord[] = [thread('thread-expiring')];
    let reads = 0;
    const persistence = createNativeJourneyPersistence({
      sqlite: storageFor(() => {
        reads += 1;
        return rows;
      }),
      controller: sources.controller,
      subscribeForeground: sources.subscribeForeground,
      now: () => current,
      scheduler: scheduled.scheduler,
    });

    const deactivate = persistence.activate();
    expect(reads).toBe(1);
    expect(scheduled.delays[0]).toBe(60 * 60 * 1000);
    deactivate();
    expect(sources.controllerUnsubscribed()).toBe(true);
    expect(sources.foregroundUnsubscribed()).toBe(true);
    expect(scheduled.activeTimers()).toBe(0);

    const reactivate = persistence.activate();
    expect(reads).toBe(2);
    expect(scheduled.activeTimers()).toBe(1);

    sources.emitForeground('background');
    expect(reads).toBe(2);
    sources.emitForeground('active');
    expect(reads).toBe(3);

    current = '2026-09-10T19:00:00.000Z';
    rows = [];
    scheduled.fire(2);
    expect(reads).toBe(4);
    expect(persistence.getSnapshot()).toMatchObject({
      historyStatus: 'available',
      history: [],
      nextExpiryAt: null,
    });
    expect(scheduled.activeTimers()).toBe(0);
    reactivate();
    persistence.dispose();
  });

  it('ignores stale source callbacks after scope disposal and clears its timer', () => {
    const sources = sourceHarness();
    const scheduled = schedulerFor();
    let reads = 0;
    const persistence = createNativeJourneyPersistence({
      sqlite: storageFor(() => {
        reads += 1;
        return [thread('thread-a', '2026-09-10T20:00:00.000Z')];
      }),
      controller: sources.controller,
      subscribeForeground: sources.subscribeForeground,
      now: () => '2026-09-10T19:30:00.000Z',
      scheduler: scheduled.scheduler,
    });
    persistence.activate();
    const beforeDispose = reads;
    persistence.dispose();
    sources.emitController();
    sources.emitForeground('active');
    expect(reads).toBe(beforeDispose);
    expect(scheduled.activeTimers()).toBe(0);
  });

  it('keeps a reactivated scope safe from queued callbacks of its prior activation', () => {
    const sources = sourceHarness();
    const scheduled = schedulerFor();
    let reads = 0;
    const persistence = createNativeJourneyPersistence({
      sqlite: storageFor(() => {
        reads += 1;
        return [thread('thread-a', '2026-09-10T20:00:00.000Z')];
      }),
      controller: sources.controller,
      subscribeForeground: sources.subscribeForeground,
      now: () => '2026-09-10T19:30:00.000Z',
      scheduler: scheduled.scheduler,
    });
    const deactivate = persistence.activate();
    deactivate();
    persistence.activate();
    expect(reads).toBe(2);
    expect(scheduled.activeTimers()).toBe(1);

    sources.emitControllerAt(0);
    sources.emitForegroundAt(0, 'active');
    scheduled.fire(0);
    expect(reads).toBe(2);
    expect(scheduled.activeTimers()).toBe(1);
    persistence.dispose();
  });
});
