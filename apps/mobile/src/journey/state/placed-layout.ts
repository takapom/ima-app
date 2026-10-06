export type PlacedLayoutReactions = {
  /** Measure the view again whenever the transcript says its content moved. */
  readonly measureOnMove: boolean;
  /** Tell the transcript its content moved whenever this view reports a new size. */
  readonly announceResize: boolean;
};

/**
 * Web onLayout fires only when a view resizes, and the transcript's own size can stay fixed while
 * its content is shorter than the screen, so a resize must ask the views around it to measure
 * again. Native onLayout already fires when only the position changes.
 */
export const placedLayoutReactions = (platform: string): PlacedLayoutReactions => {
  const web = platform === 'web';
  return { measureOnMove: web, announceResize: web };
};
