import { describe, expect, it } from 'vitest';
import { runWithinDeadline } from './deadline';

describe('runWithinDeadline', () => {
  it('consumes a delayed rejection when the signal was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const work = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('late failure')), 5);
    });

    await expect(runWithinDeadline(work, Date.now() + 100, controller.signal)).resolves.toEqual({
      kind: 'aborted',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
