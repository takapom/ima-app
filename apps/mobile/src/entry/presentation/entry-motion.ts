import { spacing } from '@mobile/ui/theme/tokens';

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

export type EntryLayout = {
  readonly dogSize: number;
  readonly sidePadding: number;
  readonly choiceHeight: number;
  readonly choiceGap: number;
  readonly choicesTop: number;
  readonly dogStart: { readonly x: number; readonly y: number };
  readonly dogEnd: { readonly x: number; readonly y: number };
  readonly wordmarkShift: number;
};

const DOG_SIZE = 104;
const CHOICE_HEIGHT = 64;
const CHOICE_GAP = 10;

export function entryLayout({
  width,
  height,
  bottomInset,
}: {
  readonly width: number;
  readonly height: number;
  readonly bottomInset: number;
}): EntryLayout {
  const choicesTop = height - bottomInset - 24 - CHOICE_HEIGHT * 2 - CHOICE_GAP;
  return {
    dogSize: DOG_SIZE,
    sidePadding: spacing.canvas,
    choiceHeight: CHOICE_HEIGHT,
    choiceGap: CHOICE_GAP,
    choicesTop,
    dogStart: { x: (width - DOG_SIZE) / 2, y: height - bottomInset - 56 - DOG_SIZE },
    dogEnd: { x: width - spacing.canvas - DOG_SIZE, y: choicesTop - 12 - DOG_SIZE },
    wordmarkShift: -height * 0.24,
  };
}
