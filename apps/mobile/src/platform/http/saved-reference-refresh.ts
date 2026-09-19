import {
  parseSavedReferenceResponse,
  type ParseResult,
  type SavedReferenceResponse,
} from '@ima/contracts';

/**
 * Public details returned by the threadless saved-reference refresh route.
 * The provider record never crosses this boundary.
 */
export type SavedReferenceRefreshResponse = SavedReferenceResponse;

const issue = (message: string): ParseResult<SavedReferenceRefreshResponse> => ({
  success: false,
  issues: [message],
});

const detailsEvidenceIds = (
  data: SavedReferenceResponse['data'],
  candidateId: string,
): ReadonlySet<string> => {
  const item = data.items.find((entry) => entry.candidateId === candidateId);
  if (item === undefined) return new Set();

  const evidenceIds = new Set<string>();
  for (const field of Object.values(item.fields)) {
    if (field?.status !== 'known') continue;
    for (const evidence of field.evidence) evidenceIds.add(evidence.evidenceId);
  }
  return evidenceIds;
};

/**
 * Validate the shared response schema and the cross-object references that the contract schema
 * cannot express: the returned candidate must be present in `data.items`, and its evidence IDs
 * must belong to that candidate's public fields.
 */
export const parseSavedReferenceRefreshResponse = (
  input: unknown,
  expectedSavedPlaceRef?: string,
): ParseResult<SavedReferenceRefreshResponse> => {
  const parsed = parseSavedReferenceResponse(input);
  if (!parsed.success) return parsed;
  const response = parsed.data;
  if (expectedSavedPlaceRef !== undefined && response.savedPlaceRef !== expectedSavedPlaceRef) {
    return issue('response savedPlaceRef does not match the request');
  }
  if (response.data.items.length !== 1) {
    return issue('saved reference refresh must contain exactly one candidate');
  }
  const item = response.data.items.find(
    (entry) => entry.candidateId === response.candidate.candidateId,
  );
  if (item === undefined) return issue('response candidateId is absent from data.items');

  const evidenceIds = detailsEvidenceIds(response.data, response.candidate.candidateId);
  if (response.candidate.evidenceIds.some((evidenceId) => !evidenceIds.has(evidenceId))) {
    return issue('response candidate evidenceIds do not reference data.items evidence');
  }

  return { success: true, data: response };
};
