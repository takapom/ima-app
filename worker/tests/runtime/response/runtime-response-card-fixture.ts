import type {
  EvidenceLink,
  ValidatedCard,
} from '@worker/application/use-cases/submit-response/validation/submit-cards-evidence';

const now = '2026-09-10T12:00:00Z';

/** Shared card fixtures for the Core-to-public DTO mapping tests. */
export const retention = {
  retentionDecision: 'deny' as const,
  retentionMode: 'session_only' as const,
  sessionExpiresAt: '2026-09-10T23:00:00Z',
  freshUntil: '2026-09-10T13:00:00Z',
  displayUntil: '2026-09-10T22:00:00Z',
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: { label: 'Fixture', sourceLink: null },
  restoreMode: 'reference_only' as const,
  policyStatus: 'available' as const,
  displayPolicyStatus: 'available' as const,
};

export const evidenceLink = (
  observationId: string,
  field: EvidenceLink['field'],
): EvidenceLink => ({
  observationId,
  candidateId: 'candidate-1',
  field,
  sources: [
    {
      provider: 'fixture',
      recordRef: `record-${observationId}`,
      attribution: 'Fixture',
      publicUrl: null,
    },
  ],
  retention,
});

export const responseMetadata = {
  threadId: 'thread-final',
  turnId: 'turn-final',
  responseId: 'response-final',
  revision: 2,
  textRetention: retention,
};

export const identity = {
  name: '店A',
  area: '恵比寿',
  address: null,
  category: 'cafe',
  stationName: null,
  accessText: null,
  businessStatus: 'operational' as const,
  sourceUrl: null,
};

export const openingHours = {
  timeZone: 'UTC',
  intervals: [{ startAt: '2026-09-10T11:00:00Z', endAt: '2026-09-10T15:00:00Z' }],
  weeklyText: ['11:00-15:00'],
  evaluatedAt: now,
  listedOpenAtEvaluation: true,
  nextBoundaryAt: '2026-09-10T15:00:00Z',
  lastOrderAt: '2026-09-10T14:00:00Z',
  lastOrderRaw: '14:00',
};

export const cardEvidenceLinks = new Map([
  ['obs-identity', evidenceLink('obs-identity', 'identity')],
  ['obs-opening', evidenceLink('obs-opening', 'opening_hours')],
  ['obs-photos', evidenceLink('obs-photos', 'photos')],
  ['obs-facilities', evidenceLink('obs-facilities', 'facilities')],
]);

export const requireCardEvidenceLink = (evidenceId: string): EvidenceLink => {
  const link = cardEvidenceLinks.get(evidenceId);
  if (link === undefined) throw new Error('card evidence fixture is incomplete');
  return link;
};

export const card: ValidatedCard = {
  candidateId: 'candidate-1',
  identity,
  openingHours,
  price: null,
  facilities: null,
  photos: {
    photos: [
      {
        photoRef: 'photo-internal-token',
        attributions: [{ displayName: 'Fixture source', uri: null }],
        sourceUrl: null,
      },
    ],
  },
  evidenceIds: ['obs-identity', 'obs-opening', 'obs-photos'],
  why: '営業中の候補です',
  diff: null,
};
