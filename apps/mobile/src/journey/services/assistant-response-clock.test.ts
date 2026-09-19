import { describe, expect, it } from 'vitest';
import {
  advanceAssistantResponseNow,
  createMonotonicAssistantResponseClock,
  subscribeToAssistantResponseResume,
} from '@mobile/journey/services/assistant-response-clock';

describe('assistant response clock', () => {
  it('does not move the production projection clock backward', () => {
    expect(advanceAssistantResponseNow('2026-09-10T00:00:00Z', '2026-09-09T23:59:59Z')).toBe(
      '2026-09-10T00:00:00Z',
    );
    expect(advanceAssistantResponseNow('2026-09-10T00:00:00Z', '2026-09-10T00:00:01Z')).toBe(
      '2026-09-10T00:00:01Z',
    );
  });

  it('keeps the highest observed source time when the system clock moves backward', () => {
    const samples = ['2026-09-10T00:00:00Z', '2026-09-10T00:00:02Z', '2026-09-10T00:00:01Z'];
    let lastSample = '2026-09-10T00:00:01Z';
    const clock = createMonotonicAssistantResponseClock(() => {
      const nextSample = samples.shift();
      if (nextSample !== undefined) lastSample = nextSample;
      return lastSample;
    });

    expect(clock()).toBe('2026-09-10T00:00:00Z');
    expect(clock()).toBe('2026-09-10T00:00:02Z');
    expect(clock()).toBe('2026-09-10T00:00:02Z');
  });

  it('refreshes immediately on active and removes the resume listener on cleanup', () => {
    const listeners: ((status: string) => void)[] = [];
    let unsubscribed = false;
    let refreshed = 0;
    const unsubscribe = subscribeToAssistantResponseResume(
      (nextListener) => {
        listeners.push(nextListener);
        return () => {
          unsubscribed = true;
        };
      },
      () => {
        refreshed += 1;
      },
    );

    const registeredListener = listeners[0];
    if (registeredListener === undefined) throw new Error('resume listener was not registered');
    registeredListener('background');
    registeredListener('active');
    expect(refreshed).toBe(1);

    unsubscribe();
    expect(unsubscribed).toBe(true);
  });
});
