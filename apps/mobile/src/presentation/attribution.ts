import type { EvidenceRef } from '@ima/contracts';

export type AttributionPresentation = {
  readonly label: string;
  readonly sourceLink: string | null;
};

/**
 * One source is cited by several fields at once, so any list that is concatenated from more
 * than one collector has to be deduped before it is keyed for rendering.
 */
export const dedupeAttributions = (
  attributions: readonly AttributionPresentation[],
): readonly AttributionPresentation[] => {
  const seen = new Set<string>();
  const unique: AttributionPresentation[] = [];
  for (const attribution of attributions) {
    const key = `${attribution.label}|${attribution.sourceLink ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(attribution);
  }
  return unique;
};

export const collectAttributions = (
  evidenceGroups: readonly (readonly EvidenceRef[])[],
): readonly AttributionPresentation[] => {
  const attributions: AttributionPresentation[] = [];
  for (const evidence of evidenceGroups) {
    for (const item of evidence) {
      const itemAttributions =
        item.attributions === undefined || item.attributions.length === 0
          ? item.attribution === null
            ? []
            : [item.attribution]
          : item.attributions;
      attributions.push(...itemAttributions);
    }
  }
  return dedupeAttributions(attributions);
};
