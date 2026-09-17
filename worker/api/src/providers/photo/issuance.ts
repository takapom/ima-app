import {
  PhotoTokenError,
  PhotoTokenInputSchema,
  type PhotoTokenCodec,
} from '@api/providers/photo/types';
import { IsoTimestampSchema, OpaqueIdSchema } from '@ima/contracts';
import {
  PhotoInfoSchema,
  type CandidateObservationRegistryPort,
  type CommittedResponse,
  type ReadonlyStoredObservation,
  type RegistryScope,
} from '@ima/core';
import type { RuntimePhotoTokenPreparer } from '@api/runtime/response/runtime-response';
import {
  runtimePolicyAllows,
  type RuntimeFieldUsePolicy,
  type RuntimePolicyMode,
} from '@api/runtime/context/runtime-field-policy';
import * as v from 'valibot';

export type PhotoTokenObservation = {
  readonly candidateId: string;
  readonly photoRef: string;
  /** The source observation may be projected only while its display policy allows it. */
  readonly displayAllowed: boolean;
  readonly sessionExpiresAt: string;
  readonly displayUntil: string | null;
  readonly providerExpiresAt: string | null;
};

export type PhotoTokenPreissueContext = {
  readonly ownerScopeRef: string;
  readonly threadId: string;
  /** The request turn that produced the response; photo GETs may occur in another UI turn. */
  readonly sourceTurnId: string;
  /** Input target revision; public response metadata is the post-commit revision. */
  readonly sourceRevision: number;
  readonly deviceId: string;
  readonly now: string;
};

export type PreparedPhotoTokens = {
  readonly issuedCount: number;
  readonly withheldCount: number;
  /** Returns only server-issued tokens; provider photo references never escape this lookup. */
  readonly resolve: (candidateId: string, photoRef: string) => string | undefined;
};

/** Inputs for the production boundary that turns committed photo evidence into token requests. */
export type PhotoTokenObservationSource = {
  readonly registry: Pick<CandidateObservationRegistryPort, 'readObservation'>;
  readonly scope: RegistryScope;
  readonly now: string;
  /** Capability is explicit; an omitted/false gate must never issue photo handles. */
  readonly photosEnabled: boolean;
  /** Display policy is resolved per observation and is independent from model/persistence policy. */
  readonly displayPolicyFor: (
    source: ReadonlyStoredObservation,
  ) => PhotoDisplayPolicySnapshot | undefined;
};

export type PhotoDisplayPolicySnapshot = {
  readonly policy: RuntimeFieldUsePolicy;
  readonly mode: RuntimePolicyMode;
};

export type PhotoTokenPreparerDependencies = Omit<PhotoTokenObservationSource, 'now'> & {
  readonly codec: PhotoTokenCodec;
  readonly deviceId: string;
  /** Identity of the request turn that owns the committed response and its photo references. */
  readonly sourceTurnId: string;
  readonly sourceRevision: number;
};

const isPhotoDisplayWindowOpen = (source: ReadonlyStoredObservation, now: string): boolean => {
  if (source.retention.displayPolicyStatus !== 'available') return false;
  if (source.retention.displayUntil === null) return false;
  const nowMilliseconds = Date.parse(now);
  const fetchedAtMilliseconds = Date.parse(source.fetchedAt);
  const freshUntilMilliseconds = Date.parse(source.freshUntil);
  const providerExpiresAtMilliseconds = Date.parse(source.expiresAt);
  const sessionExpiresAtMilliseconds = Date.parse(source.retention.sessionExpiresAt);
  const displayUntilMilliseconds = Date.parse(source.retention.displayUntil);
  if (
    !Number.isFinite(nowMilliseconds) ||
    !Number.isFinite(fetchedAtMilliseconds) ||
    !Number.isFinite(freshUntilMilliseconds) ||
    !Number.isFinite(providerExpiresAtMilliseconds) ||
    !Number.isFinite(sessionExpiresAtMilliseconds) ||
    !Number.isFinite(displayUntilMilliseconds)
  ) {
    return false;
  }
  return (
    fetchedAtMilliseconds <= nowMilliseconds &&
    nowMilliseconds < freshUntilMilliseconds &&
    nowMilliseconds < providerExpiresAtMilliseconds &&
    nowMilliseconds < sessionExpiresAtMilliseconds &&
    nowMilliseconds < displayUntilMilliseconds
  );
};

/** Reads only the committed cards' photo evidence; provider references stay inside this boundary. */
export const collectPhotoTokenObservations = (
  response: CommittedResponse,
  input: PhotoTokenObservationSource,
): PhotoTokenObservation[] => {
  if (!input.photosEnabled || response.presentation === 'keep') return [];
  const observations: PhotoTokenObservation[] = [];
  for (const card of [response.hero, ...response.alts]) {
    if (card.photos === null) continue;
    for (const evidenceId of card.evidenceIds) {
      const source = input.registry.readObservation(input.scope, evidenceId);
      if (
        source === undefined ||
        source.candidateId !== card.candidateId ||
        source.field !== 'photos'
      ) {
        continue;
      }
      const parsed = v.safeParse(PhotoInfoSchema, source.value);
      if (!parsed.success) continue;
      const observedRefs = new Set(parsed.output.photos.map((photo) => photo.photoRef));
      const displayPolicy = input.displayPolicyFor(source);
      const displayAllowed =
        displayPolicy !== undefined &&
        runtimePolicyAllows(displayPolicy.policy, 'display', displayPolicy.mode) &&
        isPhotoDisplayWindowOpen(source, input.now);
      for (const photo of card.photos.photos) {
        if (!observedRefs.has(photo.photoRef)) continue;
        observations.push({
          candidateId: card.candidateId,
          photoRef: photo.photoRef,
          displayAllowed,
          sessionExpiresAt: source.retention.sessionExpiresAt,
          displayUntil: source.retention.displayUntil,
          providerExpiresAt: source.expiresAt,
        });
      }
    }
  }
  return observations;
};

/** Binds one thread's registry and device scope to the runtime's post-commit hook. */
export const createPhotoTokenPreparer =
  (dependencies: PhotoTokenPreparerDependencies): RuntimePhotoTokenPreparer =>
  async ({ response, metadata, now }) => {
    if (
      metadata.threadId !== dependencies.scope.threadId ||
      metadata.turnId !== dependencies.sourceTurnId
    ) {
      throw new PhotoTokenError('INVALID_INPUT');
    }
    const observations = collectPhotoTokenObservations(response, {
      registry: dependencies.registry,
      scope: dependencies.scope,
      now,
      photosEnabled: dependencies.photosEnabled,
      displayPolicyFor: dependencies.displayPolicyFor,
    });
    const prepared = await preparePhotoTokens(dependencies.codec, observations, {
      ownerScopeRef: dependencies.scope.ownerScopeRef,
      threadId: dependencies.scope.threadId,
      sourceTurnId: dependencies.sourceTurnId,
      sourceRevision: dependencies.sourceRevision,
      deviceId: dependencies.deviceId,
      now,
    });
    return prepared.resolve;
  };

const keyFor = (candidateId: string, photoRef: string): string =>
  JSON.stringify([candidateId, photoRef]);

const PhotoTokenContextSchema = v.strictObject({
  ownerScopeRef: PhotoTokenInputSchema.entries.ownerScopeRef,
  threadId: PhotoTokenInputSchema.entries.threadId,
  sourceTurnId: PhotoTokenInputSchema.entries.turnId,
  sourceRevision: PhotoTokenInputSchema.entries.revision,
  deviceId: PhotoTokenInputSchema.entries.deviceId,
  now: IsoTimestampSchema,
});

const PhotoTokenObservationSchema = v.strictObject({
  candidateId: OpaqueIdSchema,
  photoRef: PhotoTokenInputSchema.entries.photoRef,
  displayAllowed: v.boolean(),
  sessionExpiresAt: IsoTimestampSchema,
  displayUntil: v.nullable(IsoTimestampSchema),
  providerExpiresAt: v.nullable(IsoTimestampSchema),
});

const isWithholdableTokenFailure = (error: unknown): boolean => error instanceof PhotoTokenError;

const timestampMilliseconds = (value: string): number | undefined => {
  const parsed = v.safeParse(IsoTimestampSchema, value);
  if (!parsed.success) return undefined;
  const milliseconds = Date.parse(parsed.output);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
};

type PreparedObservation = {
  readonly candidateId: string;
  readonly photoRef: string;
  readonly expiresAtMilliseconds: number;
};

const prepareObservation = (
  observation: PhotoTokenObservation,
  nowMilliseconds: number,
): PreparedObservation | null => {
  const parsed = v.safeParse(PhotoTokenObservationSchema, observation);
  if (!parsed.success || !parsed.output.displayAllowed || parsed.output.displayUntil === null) {
    return null;
  }
  const bounds = [
    nowMilliseconds + 30 * 60 * 1_000,
    timestampMilliseconds(parsed.output.sessionExpiresAt),
    timestampMilliseconds(parsed.output.displayUntil),
  ];
  if (parsed.output.providerExpiresAt !== null) {
    const providerExpiry = timestampMilliseconds(parsed.output.providerExpiresAt);
    if (providerExpiry === undefined) return null;
    bounds.push(providerExpiry);
  }
  if (bounds.some((bound) => bound === undefined)) return null;
  const expiresAtMilliseconds = Math.min(
    ...bounds.filter((bound): bound is number => bound !== undefined),
  );
  if (expiresAtMilliseconds <= nowMilliseconds) return null;
  return {
    candidateId: parsed.output.candidateId,
    photoRef: parsed.output.photoRef,
    expiresAtMilliseconds,
  };
};

/** Issues all currently observed photos before the synchronous public DTO mapper runs. */
export const preparePhotoTokens = async (
  codec: PhotoTokenCodec,
  observations: readonly PhotoTokenObservation[],
  context: PhotoTokenPreissueContext,
): Promise<PreparedPhotoTokens> => {
  const parsedContext = v.safeParse(PhotoTokenContextSchema, {
    ownerScopeRef: context.ownerScopeRef,
    threadId: context.threadId,
    sourceTurnId: context.sourceTurnId,
    sourceRevision: context.sourceRevision,
    deviceId: context.deviceId,
    now: context.now,
  });
  if (!parsedContext.success) throw new PhotoTokenError('INVALID_INPUT');

  const tokens = new Map<string, string>();
  const prepared = new Map<string, PreparedObservation | null>();
  const nowMilliseconds = Date.parse(parsedContext.output.now);
  for (const observation of observations) {
    const key = keyFor(observation.candidateId, observation.photoRef);
    const next = prepareObservation(observation, nowMilliseconds);
    if (!prepared.has(key)) {
      prepared.set(key, next);
      continue;
    }
    const previous = prepared.get(key);
    if (previous === undefined || previous === null || next === null) {
      prepared.set(key, null);
      continue;
    }
    prepared.set(key, {
      ...previous,
      expiresAtMilliseconds: Math.min(previous.expiresAtMilliseconds, next.expiresAtMilliseconds),
    });
  }
  let withheldCount = 0;
  for (const [key, observation] of prepared) {
    if (observation === null) {
      withheldCount += 1;
      continue;
    }
    try {
      const token = await codec.issue(
        {
          ownerScopeRef: context.ownerScopeRef,
          threadId: context.threadId,
          turnId: context.sourceTurnId,
          revision: context.sourceRevision,
          deviceId: context.deviceId,
          photoRef: observation.photoRef,
          expiresAt: new Date(observation.expiresAtMilliseconds).toISOString(),
        },
        context.now,
      );
      tokens.set(key, token);
    } catch (error: unknown) {
      if (!isWithholdableTokenFailure(error)) throw error;
      withheldCount += 1;
    }
  }

  return {
    issuedCount: tokens.size,
    withheldCount,
    resolve: (candidateId, photoRef) => tokens.get(keyFor(candidateId, photoRef)),
  };
};
