import type { EvidenceRef } from '@ima/contracts';

export type AttributionPresentation = {
  readonly label: string;
  readonly sourceLink: string | null;
};

export const collectAttributions = (
  evidenceGroups: readonly (readonly EvidenceRef[])[],
): readonly AttributionPresentation[] => {
  const seen = new Set<string>();
  const attributions: AttributionPresentation[] = [];
  for (const evidence of evidenceGroups) {
    for (const item of evidence) {
      const itemAttributions =
        item.attributions === undefined || item.attributions.length === 0
          ? item.attribution === null
            ? []
            : [item.attribution]
          : item.attributions;
      for (const attribution of itemAttributions) {
        const key = `${attribution.label}|${attribution.sourceLink ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        attributions.push(attribution);
      }
    }
  }
  return attributions;
};
