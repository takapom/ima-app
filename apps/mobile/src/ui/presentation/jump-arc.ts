export type JumpArc = {
  readonly input: number[];
  readonly x: number[];
  readonly y: number[];
};

/**
 * Samples a hop from (0, 0) to (dx, dy) that rises `height` above the higher end.
 * The apex is placed on a sample so interpolation reaches it exactly.
 */
export function jumpArc({
  dx,
  dy,
  height,
  steps,
}: {
  readonly dx: number;
  readonly dy: number;
  readonly height: number;
  readonly steps: number;
}): JumpArc {
  const apex = Math.min(0, dy) - height;
  const rise = Math.sqrt(-apex);
  const fall = Math.sqrt(dy - apex);
  const apexStep = Math.min(Math.max(Math.round((steps * rise) / (rise + fall)), 1), steps - 1);
  const apexAt = apexStep / steps;
  const input = Array.from({ length: steps + 1 }, (_, index) => index / steps);
  const y = input.map((t) =>
    t <= apexAt
      ? apex - apex * ((apexAt - t) / apexAt) ** 2
      : apex + (dy - apex) * ((t - apexAt) / (1 - apexAt)) ** 2,
  );
  return { input, x: input.map((t) => dx * t), y };
}
