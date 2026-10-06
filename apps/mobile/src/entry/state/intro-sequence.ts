export type Playable = {
  readonly start: (callback?: (result: { finished: boolean }) => void) => void;
  readonly stop: () => void;
};

/**
 * Plays the splash motion, then the choices, and reports ready only once the choices have
 * finished appearing, so nothing can be tapped while it is still invisible.
 */
export function playEntryIntro(
  intro: Playable,
  choices: Playable,
  onReady: () => void,
): () => void {
  let active = true;
  intro.start(({ finished }) => {
    if (!finished || !active) return;
    choices.start(({ finished: appeared }) => {
      if (appeared && active) onReady();
    });
  });
  return () => {
    active = false;
    intro.stop();
    choices.stop();
  };
}
