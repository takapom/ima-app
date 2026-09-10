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
      if (item.attribution === null) continue;
      const key = `${item.attribution.label}|${item.attribution.sourceLink ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      attributions.push(item.attribution);
    }
  }
  return attributions;
};
