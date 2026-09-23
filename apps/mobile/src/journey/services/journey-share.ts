export type JourneyShareCandidate = {
  readonly name: string;
  /** A trusted HTTPS map link; this module does not geocode or invent one. */
  readonly mapUrl: string | null;
  readonly attributions: readonly JourneyShareAttribution[];
};

export type JourneyShareAttribution = {
  readonly label: string;
  readonly sourceLink: string | null;
};

export type SharePreparation =
  | { readonly status: 'ready'; readonly message: string }
  | { readonly status: 'unavailable'; readonly reason: 'name_missing' | 'map_link_missing' };

export type ShareSheetResult =
  | { readonly status: 'opened' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly reason: 'share_unavailable' };

export type JourneyShareService = {
  readonly openShareSheet: (input: { readonly message: string }) => Promise<ShareSheetResult>;
};

const isHttpsUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0;
  } catch {
    return false;
  }
};

export const prepareJourneyShare = (candidate: JourneyShareCandidate): SharePreparation => {
  const name = candidate.name.trim();
  if (name.length === 0) return { status: 'unavailable', reason: 'name_missing' };
  if (candidate.mapUrl === null || !isHttpsUrl(candidate.mapUrl)) {
    return { status: 'unavailable', reason: 'map_link_missing' };
  }

  const lines = [name, candidate.mapUrl];
  const seenAttributions = new Set<string>();
  for (const attribution of candidate.attributions) {
    const key = `${attribution.label}|${attribution.sourceLink ?? ''}`;
    if (seenAttributions.has(key)) continue;
    seenAttributions.add(key);
    lines.push(
      attribution.sourceLink === null
        ? `出典: ${attribution.label}`
        : `出典: ${attribution.label} ${attribution.sourceLink}`,
    );
  }
  return { status: 'ready', message: lines.join('\n') };
};

/**
 * `opened` means the native share sheet opened. It does not claim delivery to
 * LINE or any other recipient; cancellation and native failure stay distinct.
 */
export const shareJourneyCandidate = async (
  service: JourneyShareService,
  candidate: JourneyShareCandidate,
): Promise<SharePreparation | ShareSheetResult> => {
  const prepared = prepareJourneyShare(candidate);
  if (prepared.status !== 'ready') return prepared;
  try {
    return await service.openShareSheet({ message: prepared.message });
  } catch {
    return { status: 'failed', reason: 'share_unavailable' };
  }
};
