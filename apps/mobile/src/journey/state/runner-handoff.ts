/** Where the running dog stands on screen, in window coordinates. */
export type RunnerSpot = {
  readonly x: number;
  readonly y: number;
  readonly size: number;
};

/** Lets the corner dog start its jump back from where the search runner was standing. */
export type RunnerHandoff = {
  readonly report: (spot: RunnerSpot | null) => void;
  readonly last: () => RunnerSpot | null;
};

export const createRunnerHandoff = (): RunnerHandoff => {
  let spot: RunnerSpot | null = null;
  return {
    report: (next) => {
      spot = next;
    },
    last: () => spot,
  };
};
