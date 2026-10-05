import { describe, expect, it, vi } from 'vitest';
import { playEntryIntro, type Playable } from '@mobile/entry/state/intro-sequence';

type FakeAnimation = Playable & {
  readonly started: () => boolean;
  readonly stopped: () => boolean;
  readonly finish: (finished: boolean) => void;
};

function fakeAnimation(): FakeAnimation {
  let callback: ((result: { finished: boolean }) => void) | undefined;
  let started = false;
  let stopped = false;
  return {
    start: (next) => {
      started = true;
      callback = next;
    },
    stop: () => {
      stopped = true;
    },
    started: () => started,
    stopped: () => stopped,
    finish: (finished) => callback?.({ finished }),
  };
}

describe('entry intro sequence', () => {
  it('shows the choices after the splash motion and reports ready only once they have appeared', () => {
    const intro = fakeAnimation();
    const choices = fakeAnimation();
    const onReady = vi.fn();
    playEntryIntro(intro, choices, onReady);

    expect(intro.started()).toBe(true);
    expect(choices.started()).toBe(false);

    intro.finish(true);
    expect(choices.started()).toBe(true);
    expect(onReady).not.toHaveBeenCalled();

    choices.finish(true);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('does not show the choices when the splash motion is interrupted', () => {
    const intro = fakeAnimation();
    const choices = fakeAnimation();
    const onReady = vi.fn();
    playEntryIntro(intro, choices, onReady);

    intro.finish(false);
    expect(choices.started()).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
  });

  it('does not report ready when the choices are interrupted while appearing', () => {
    const intro = fakeAnimation();
    const choices = fakeAnimation();
    const onReady = vi.fn();
    playEntryIntro(intro, choices, onReady);

    intro.finish(true);
    choices.finish(false);
    expect(onReady).not.toHaveBeenCalled();
  });

  it('stops both animations and ignores late completions once cancelled', () => {
    const intro = fakeAnimation();
    const choices = fakeAnimation();
    const onReady = vi.fn();
    const cancel = playEntryIntro(intro, choices, onReady);

    intro.finish(true);
    cancel();
    choices.finish(true);

    expect(intro.stopped()).toBe(true);
    expect(choices.stopped()).toBe(true);
    expect(onReady).not.toHaveBeenCalled();
  });
});
