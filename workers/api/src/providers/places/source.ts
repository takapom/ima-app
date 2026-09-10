import type { SourceRef } from '@ima/core';
import { normalizeGoogleHttpsUri } from './values';
import type { GooglePlaceWire } from './wire';

export type GoogleSourceMetadata = {
  readonly ok: boolean;
  readonly sources: readonly SourceRef[];
};

/**
 * Builds bounded source references for both search and details. Callers choose
 * whether an invalid provider link is a partial result or a withheld value.
 */
export const normalizeGoogleSourceMetadata = (
  place: GooglePlaceWire | undefined,
  recordRef: string,
): GoogleSourceMetadata => {
  if (place === undefined) {
    return {
      ok: true,
      sources: [{ provider: 'google_places', recordRef, attribution: null, publicUrl: null }],
    };
  }
  const mapUrl = normalizeGoogleHttpsUri(place.googleMapsUri);
  const attributions = place.attributions ?? [];
  if (attributions.length === 0) {
    return {
      ok: mapUrl.ok,
      sources: [
        {
          provider: 'google_places',
          recordRef,
          attribution: null,
          publicUrl: mapUrl.ok ? mapUrl.value : null,
        },
      ],
    };
  }

  let ok = mapUrl.ok;
  const sources: SourceRef[] = [];
  for (const attribution of attributions) {
    if (attribution.provider.length > 160) ok = false;
    const providerUrl = normalizeGoogleHttpsUri(attribution.providerUri);
    if (!providerUrl.ok) ok = false;
    sources.push({
      provider: 'google_places',
      recordRef,
      attribution: attribution.provider,
      publicUrl: providerUrl.ok ? providerUrl.value : null,
    });
  }
  return { ok, sources };
};

export const googleSourceMetadataIsValid = (place: GooglePlaceWire | undefined): boolean =>
  normalizeGoogleSourceMetadata(place, 'source-validation').ok;
