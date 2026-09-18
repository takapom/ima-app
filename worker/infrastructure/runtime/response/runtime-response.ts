import * as v from 'valibot';
import {
  AssistantResponseSchema,
  type AssistantResponse,
  type EvidenceRef,
  type PhotoInfo,
  type RetentionMetadata as PublicRetentionMetadata,
} from '@ima/contracts';
import {
  type CommittedResponse,
  type LastTrainInfo,
  type OpeningHours,
  type PlaceIdentity,
  type PriceInfo,
  type ValidatedCard,
  type ValidatedEvidenceText,
  type WalkingRoute,
  type RetentionMetadata,
} from '@ima/core';

type CorePhotoInfo = NonNullable<ValidatedCard['photos']>;
type EvidenceLink = ValidatedEvidenceText['evidence'][number];

export type RuntimePublicResponseMetadata = {
  readonly threadId: string;
  readonly turnId: string;
  readonly responseId: string;
  /** Commit receipt revision; the request target revision is kept by photo preparation separately. */
  readonly revision: number;
};

export type RuntimeCardEvidenceResolver = (
  candidateId: string,
  evidenceId: string,
) => EvidenceLink | undefined;

export type RuntimePhotoTokenResolver = (
  candidateId: string,
  internalPhotoRef: string,
) => string | undefined;

export type RuntimePhotoTokenPreparationInput = {
  readonly response: CommittedResponse;
  readonly metadata: RuntimePublicResponseMetadata;
  readonly now: string;
};

/** Issues short-lived photo handles before the synchronous public mapper runs. */
export type RuntimePhotoTokenPreparer = (
  input: RuntimePhotoTokenPreparationInput,
) => Promise<RuntimePhotoTokenResolver | undefined>;

/** Metadata-only failure classification; provider and codec errors never cross this boundary. */
export type RuntimePhotoPreparationFailure = {
  readonly code: 'PHOTO_PREPARATION_FAILED';
};

export type RuntimePhotoPreparationErrorObserver = (
  failure: RuntimePhotoPreparationFailure,
) => void;

export type RuntimePublicResponseOptions = RuntimePublicResponseMetadata & {
  /** The generated text policy; the final contracts schema checks it against every source. */
  readonly textRetention: RetentionMetadata;
  /** Re-resolves committed evidence before publishing cards or grounded messages. */
  readonly resolveCardEvidence?: RuntimeCardEvidenceResolver;
  /** M15 owns server-issued photo handles; Core photo references never cross this boundary. */
  readonly resolvePhotoToken?: RuntimePhotoTokenResolver;
  /** A server-issued card-set ID; message responses always use a null card-set ID. */
  readonly cardSetId?: string;
};

export type RuntimePublicResponseDependencies = Omit<
  RuntimePublicResponseOptions,
  'threadId' | 'turnId' | 'responseId' | 'revision'
> & {
  /** Runs once after Core commit and before mapping; the mapper remains synchronous. */
  readonly preparePhotoTokens?: RuntimePhotoTokenPreparer;
  /** Optional internal audit hook; a failure withholds only the photo field. */
  readonly onPhotoPreparationError?: RuntimePhotoPreparationErrorObserver;
};

export const prepareRuntimePhotoResolver = async (
  dependencies: RuntimePublicResponseDependencies,
  response: CommittedResponse,
  metadata: RuntimePublicResponseMetadata,
  now: string,
): Promise<RuntimePhotoTokenResolver | undefined> => {
  if (dependencies.preparePhotoTokens === undefined) return dependencies.resolvePhotoToken;
  try {
    const prepared = await dependencies.preparePhotoTokens({ response, metadata, now });
    return prepared ?? dependencies.resolvePhotoToken;
  } catch {
    try {
      dependencies.onPhotoPreparationError?.({ code: 'PHOTO_PREPARATION_FAILED' });
    } catch {
      // Telemetry must not turn a photo-only failure into a response failure.
    }
    return undefined;
  }
};

export type RuntimePublicResponseErrorCode =
  | 'CARD_SET_ID_REQUIRED'
  | 'CARD_EVIDENCE_RESOLVER_REQUIRED'
  | 'CARD_EVIDENCE_MISSING'
  | 'PHOTO_TOKEN_RESOLVER_REQUIRED'
  | 'PHOTO_TOKEN_UNAVAILABLE'
  | 'PUBLIC_RESPONSE_INVALID';

const responseErrors = new WeakSet<object>();

export class RuntimePublicResponseError extends Error {
  readonly code: RuntimePublicResponseErrorCode;

  constructor(code: RuntimePublicResponseErrorCode) {
    super(`runtime public response denied: ${code}`);
    this.name = 'RuntimePublicResponseError';
    this.code = code;
    responseErrors.add(this);
  }
}

export const isRuntimePublicResponseError = (value: unknown): value is RuntimePublicResponseError =>
  typeof value === 'object' && value !== null && responseErrors.has(value);

const invalid = (code: RuntimePublicResponseErrorCode): never => {
  throw new RuntimePublicResponseError(code);
};

const publicRetention = (retention: RetentionMetadata): PublicRetentionMetadata => ({
  retentionDecision: retention.retentionDecision,
  retentionMode: retention.retentionMode,
  sessionExpiresAt: retention.sessionExpiresAt,
  freshUntil: retention.freshUntil,
  displayUntil: retention.displayUntil,
  retentionUntil: retention.retentionUntil,
  deletionScheduledAt: retention.deletionScheduledAt,
  attribution:
    retention.attribution === null
      ? null
      : { label: retention.attribution.label, sourceLink: retention.attribution.sourceLink },
  restoreMode: retention.restoreMode,
  policyStatus: retention.policyStatus,
  displayPolicyStatus: retention.displayPolicyStatus,
});

type PublicAttribution = NonNullable<EvidenceRef['attribution']>;

const publicSourceAttributions = (sources: EvidenceLink['sources']): PublicAttribution[] => {
  const seen = new Set<string>();
  const attributions: PublicAttribution[] = [];
  for (const source of sources) {
    if (source.attribution === null) continue;
    const attribution = { label: source.attribution, sourceLink: source.publicUrl };
    const key = `${attribution.label}|${attribution.sourceLink ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    attributions.push(attribution);
  }
  return attributions;
};

const publicEvidence = (link: EvidenceLink): EvidenceRef => {
  const retention = publicRetention(link.retention);
  const singular = retention.attribution;
  const sourceAttributions = publicSourceAttributions(link.sources);
  const attributions =
    sourceAttributions.length > 1
      ? singular === null ||
        sourceAttributions.some(
          (attribution) =>
            attribution.label === singular.label && attribution.sourceLink === singular.sourceLink,
        )
        ? sourceAttributions
        : [...sourceAttributions, singular]
      : undefined;
  return {
    evidenceId: link.observationId,
    attribution: retention.attribution,
    ...(attributions === undefined ? {} : { attributions }),
    retention,
  };
};

const currentEvidenceLinkFor = (
  link: EvidenceLink,
  options: RuntimePublicResponseOptions,
): EvidenceLink => {
  if (options.resolveCardEvidence === undefined) return link;
  const resolved = options.resolveCardEvidence(link.candidateId, link.observationId);
  if (
    resolved === undefined ||
    resolved.observationId !== link.observationId ||
    resolved.candidateId !== link.candidateId ||
    resolved.field !== link.field
  ) {
    return invalid('CARD_EVIDENCE_MISSING');
  }
  return resolved;
};

const publicText = (
  text: ValidatedEvidenceText,
  options: RuntimePublicResponseOptions,
): {
  readonly text: string;
  readonly evidenceIds: string[];
  readonly evidence: EvidenceRef[];
  readonly basis: ValidatedEvidenceText['basis'];
  readonly retention: PublicRetentionMetadata;
} => {
  const evidenceIds = [...text.evidenceIds];
  const links = text.evidence;
  if (new Set(evidenceIds).size !== evidenceIds.length || links.length !== evidenceIds.length) {
    return invalid('PUBLIC_RESPONSE_INVALID');
  }
  const byId = new Map<string, EvidenceRef>();
  for (const link of links) {
    const reference = publicEvidence(currentEvidenceLinkFor(link, options));
    if (byId.has(reference.evidenceId)) return invalid('PUBLIC_RESPONSE_INVALID');
    byId.set(reference.evidenceId, reference);
  }
  const evidence = evidenceIds.map((evidenceId) => {
    const reference = byId.get(evidenceId);
    return reference === undefined ? invalid('PUBLIC_RESPONSE_INVALID') : reference;
  });
  return {
    text: text.text,
    evidenceIds,
    evidence,
    basis: text.basis,
    retention: publicRetention(options.textRetention),
  };
};

const publicIdentity = (value: PlaceIdentity) => ({
  name: value.name,
  area: value.area,
  address: value.address,
  category: value.category,
  stationName: value.stationName,
  accessText: value.accessText,
  businessStatus: value.businessStatus,
  sourceUrl: value.sourceUrl,
});

const publicOpeningHours = (value: OpeningHours) => ({
  timeZone: value.timeZone,
  intervals: value.intervals.map((interval) => ({
    startAt: interval.startAt,
    endAt: interval.endAt,
  })),
  weeklyText: [...value.weeklyText],
  evaluatedAt: value.evaluatedAt,
  listedOpenAtEvaluation: value.listedOpenAtEvaluation,
  nextBoundaryAt: value.nextBoundaryAt,
  lastOrderAt: value.lastOrderAt,
  lastOrderRaw: value.lastOrderRaw,
});

const publicPrice = (value: PriceInfo) => ({
  level: value.level,
  range:
    value.range === null
      ? null
      : {
          currency: value.range.currency,
          min: value.range.min,
          max: value.range.max,
          unit: value.range.unit,
        },
  rawLabel: value.rawLabel,
});

const publicPhotos = (
  value: CorePhotoInfo,
  candidateId: string,
  options: RuntimePublicResponseOptions,
):
  | {
      readonly status: 'known';
      readonly value: PhotoInfo;
    }
  | { readonly status: 'unknown'; readonly reason: string } => {
  const resolvePhotoToken = options.resolvePhotoToken;
  if (value.photos.length === 0) {
    return { status: 'known', value: { photos: [] } };
  }
  if (resolvePhotoToken === undefined) {
    return { status: 'unknown', reason: '写真を表示できません' };
  }
  const photos = [];
  for (const photo of value.photos) {
    const photoToken = resolvePhotoToken(candidateId, photo.photoRef);
    if (photoToken === undefined) continue;
    photos.push({
      photoToken,
      attributions: photo.attributions.map((attribution) => ({
        displayName: attribution.displayName,
        uri: attribution.uri,
      })),
      sourceUrl: photo.sourceUrl,
    });
  }
  if (value.photos.length > 0 && photos.length === 0) {
    return { status: 'unknown', reason: '写真を表示できません' };
  }
  return {
    status: 'known',
    value: {
      photos,
      ...(photos.length < value.photos.length
        ? { partialReason: '一部の写真は表示できません' }
        : {}),
    },
  };
};

const publicWalkingRoute = (value: WalkingRoute) => ({
  originRef: value.originRef,
  destinationCandidateId: value.destinationCandidateId,
  originRevision: value.originRevision,
  evaluatedAt: value.evaluatedAt,
  durationSeconds: value.durationSeconds,
  distanceMeters: value.distanceMeters,
  warnings: value.warnings.map((warning) => ({
    code: warning.code,
    message: warning.message,
  })),
});

const publicLastTrain = (value: LastTrainInfo) => ({
  serviceDate: value.serviceDate,
  fromStationRef: value.fromStationRef,
  homeStationRef: value.homeStationRef,
  journeyRef: value.journeyRef,
  lastDepartureAt: value.lastDepartureAt,
  arrivesHomeAt: value.arrivesHomeAt,
  transfers: value.transfers.map((transfer) => ({
    fromStationRef: transfer.fromStationRef,
    toStationRef: transfer.toStationRef,
    departureAt: transfer.departureAt,
    arrivalAt: transfer.arrivalAt,
  })),
  placeToStationSeconds: value.placeToStationSeconds,
  arrivePlaceAt: value.arrivePlaceAt,
  leaveBy: value.leaveBy,
  availableStaySeconds: value.availableStaySeconds,
  minimumStayMinutes: value.minimumStayMinutes,
  usable: value.usable,
});

const cardEvidence = (
  card: ValidatedCard,
  field: string,
  options: RuntimePublicResponseOptions,
): EvidenceRef[] => {
  if (options.resolveCardEvidence === undefined) {
    return invalid('CARD_EVIDENCE_RESOLVER_REQUIRED');
  }
  if (new Set(card.evidenceIds).size !== card.evidenceIds.length) {
    return invalid('CARD_EVIDENCE_MISSING');
  }
  const links: EvidenceLink[] = [];
  for (const evidenceId of card.evidenceIds) {
    const link = options.resolveCardEvidence(card.candidateId, evidenceId);
    if (
      link === undefined ||
      link.observationId !== evidenceId ||
      link.candidateId !== card.candidateId
    ) {
      return invalid('CARD_EVIDENCE_MISSING');
    }
    links.push(link);
  }
  const evidence = links.filter((link) => link.field === field).map((link) => publicEvidence(link));
  return evidence.length === 0 ? invalid('CARD_EVIDENCE_MISSING') : evidence;
};

const known = <Value>(value: Value, evidence: EvidenceRef[]) => ({
  status: 'known' as const,
  value,
  evidence,
});

const publicPhotoFact = (
  card: ValidatedCard,
  options: RuntimePublicResponseOptions,
):
  | ReturnType<typeof known<PhotoInfo>>
  | { readonly status: 'unknown'; readonly reason: string }
  | undefined => {
  if (card.photos === null) return undefined;
  const projection = publicPhotos(card.photos, card.candidateId, options);
  if (projection.status === 'unknown') return projection;
  try {
    return known(projection.value, cardEvidence(card, 'photos', options));
  } catch (error: unknown) {
    if (isRuntimePublicResponseError(error) && error.code === 'CARD_EVIDENCE_MISSING') {
      return { status: 'unknown', reason: '写真を表示できません' };
    }
    throw error;
  }
};

const publicCard = (card: ValidatedCard, options: RuntimePublicResponseOptions) => {
  const photoFact = publicPhotoFact(card, options);
  const facts = {
    identity: known(publicIdentity(card.identity), cardEvidence(card, 'identity', options)),
    opening_hours: known(
      publicOpeningHours(card.openingHours),
      cardEvidence(card, 'opening_hours', options),
    ),
    ...(card.price === null
      ? {}
      : { price: known(publicPrice(card.price), cardEvidence(card, 'price', options)) }),
    ...(photoFact === undefined ? {} : { photos: photoFact }),
    ...(card.walkingRoute === null
      ? {}
      : {
          walking_route: known(
            publicWalkingRoute(card.walkingRoute),
            cardEvidence(card, 'walking_route', options),
          ),
        }),
    ...(card.lastTrain === null
      ? {}
      : {
          last_train: known(
            publicLastTrain(card.lastTrain),
            cardEvidence(card, 'last_train', options),
          ),
        }),
  };
  return {
    candidateId: card.candidateId,
    facts,
    why: publicText(card.why, options),
    ...(card.diff === null ? {} : { diff: publicText(card.diff, options) }),
  };
};

/** Converts a Core committed response to the public, schema-checked assistant DTO. */
export const mapCommittedResponseToPublic = (
  response: CommittedResponse,
  options: RuntimePublicResponseOptions,
): AssistantResponse => {
  try {
    const base = {
      schemaVersion: 'v1' as const,
      threadId: options.threadId,
      turnId: options.turnId,
      responseId: options.responseId,
      revision: options.revision,
    };
    const dto: unknown =
      response.presentation === 'keep'
        ? {
            ...base,
            kind: 'message' as const,
            presentation: 'keep' as const,
            cardSetId: null,
            message: [publicText(response.message, options)],
          }
        : options.cardSetId === undefined
          ? invalid('CARD_SET_ID_REQUIRED')
          : {
              ...base,
              kind: 'cards' as const,
              presentation: 'replace' as const,
              cardSetId: options.cardSetId,
              cards: {
                hero: publicCard(response.hero, options),
                alts: response.alts.map((card) => publicCard(card, options)),
              },
              message: response.message.map((text) => publicText(text, options)),
            };
    const parsed = v.safeParse(AssistantResponseSchema, dto);
    return parsed.success ? parsed.output : invalid('PUBLIC_RESPONSE_INVALID');
  } catch (error: unknown) {
    if (isRuntimePublicResponseError(error)) throw error;
    return invalid('PUBLIC_RESPONSE_INVALID');
  }
};
