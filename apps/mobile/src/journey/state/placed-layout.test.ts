import { describe, expect, it } from 'vitest';
import { placedLayoutReactions } from '@mobile/journey/state/placed-layout';

describe('placed layout reactions', () => {
  it('on web, measures again when told and tells the others when it resizes', () => {
    expect(placedLayoutReactions('web')).toEqual({ measureOnMove: true, announceResize: true });
  });

  it('on iOS and Android, relies on onLayout, which already reports moves', () => {
    expect(placedLayoutReactions('ios')).toEqual({ measureOnMove: false, announceResize: false });
    expect(placedLayoutReactions('android')).toEqual({
      measureOnMove: false,
      announceResize: false,
    });
  });
});
