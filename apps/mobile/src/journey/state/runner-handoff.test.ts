import { describe, expect, it } from 'vitest';
import { createRunnerHandoff } from '@mobile/journey/state/runner-handoff';

describe('runner handoff', () => {
  it('knows nothing before the runner has been placed', () => {
    expect(createRunnerHandoff().last()).toBeNull();
  });

  it('keeps where the running dog stood most recently', () => {
    const handoff = createRunnerHandoff();
    handoff.report({ x: 34, y: 520, size: 64 });
    handoff.report({ x: 34, y: 480, size: 64 });
    expect(handoff.last()).toEqual({ x: 34, y: 480, size: 64 });
  });

  it('forgets the spot once the runner is gone, so a stale spot is never used', () => {
    const handoff = createRunnerHandoff();
    handoff.report({ x: 34, y: 480, size: 64 });
    handoff.report(null);
    expect(handoff.last()).toBeNull();
  });
});
