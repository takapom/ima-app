import { spacing } from '@mobile/ui/theme/tokens';

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
