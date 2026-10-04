export type WorkingSkeletonCard = {
  readonly key: string;
  readonly nameWidth: `${number}%`;
  /** Access, listed opening hours and budget, in the candidate card's order. */
  readonly factWidths: readonly [`${number}%`, `${number}%`, `${number}%`];
};

/** A proposal holds at most three cards, so the search reserves the same three slots. */
export const WORKING_SKELETON_CARDS: readonly WorkingSkeletonCard[] = [
  { key: 'skeleton-1', nameWidth: '78%', factWidths: ['64%', '82%', '40%'] },
  { key: 'skeleton-2', nameWidth: '62%', factWidths: ['72%', '58%', '46%'] },
  { key: 'skeleton-3', nameWidth: '70%', factWidths: ['56%', '76%', '36%'] },
];

export type WorkingSkeletonMotion = 'pulse' | 'still';

/** Stays still until the reduced-motion setting is known, and whenever it is on. */
export const workingSkeletonMotion = (reduceMotion: boolean | null): WorkingSkeletonMotion =>
  reduceMotion === false ? 'pulse' : 'still';
