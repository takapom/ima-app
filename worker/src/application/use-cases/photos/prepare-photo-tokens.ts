import * as v from 'valibot';
import { IsoTimestampSchema, OpaqueIdSchema, RevisionSchema } from '@worker/domain/primitives';
import type { PhotoTokenIssuer } from '@worker/application/ports/photo-token-issuer';
export class PhotoTokenPreparationError extends Error {
  constructor() {
    super('Invalid photo token context');
    this.name = 'PhotoTokenPreparationError';
  }
}
export type PhotoTokenObservation = {
  readonly candidateId: string;
  readonly photoRef: string;
  /** The source observation may be projected only while its display policy allows it. */
  readonly displayAllowed: boolean;
  readonly persistUntil?: string | null;
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
  /** Only tokens whose reference mappings were approved for durable storage. */
  readonly resolvePersistent: (candidateId: string, photoRef: string) => string | undefined;
};

const keyFor = (candidateId: string, photoRef: string): string =>
  JSON.stringify([candidateId, photoRef]);

const PhotoTokenContextSchema = v.strictObject({
  ownerScopeRef: v.pipe(v.string(), v.minLength(1), v.maxLength(160)),
  threadId: OpaqueIdSchema,
  sourceTurnId: OpaqueIdSchema,
  sourceRevision: RevisionSchema,
  deviceId: v.pipe(v.string(), v.minLength(1), v.maxLength(160)),
  now: IsoTimestampSchema,
});

const PhotoTokenObservationSchema = v.strictObject({
  candidateId: OpaqueIdSchema,
  photoRef: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  displayAllowed: v.boolean(),
  persistUntil: v.optional(v.nullable(IsoTimestampSchema), null),
  sessionExpiresAt: IsoTimestampSchema,
  displayUntil: v.nullable(IsoTimestampSchema),
  providerExpiresAt: v.nullable(IsoTimestampSchema),
});

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
  readonly persist: boolean;
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
  if (parsed.output.persistUntil !== null) bounds.push(Date.parse(parsed.output.persistUntil));
  if (bounds.some((bound) => bound === undefined)) return null;
  const expiresAtMilliseconds = Math.min(
    ...bounds.filter((bound): bound is number => bound !== undefined),
  );
  if (expiresAtMilliseconds <= nowMilliseconds) return null;
  return {
    candidateId: parsed.output.candidateId,
    photoRef: parsed.output.photoRef,
    expiresAtMilliseconds,
    persist: parsed.output.persistUntil !== null,
  };
};

/** Issues all currently observed photos before the synchronous public DTO mapper runs. */
export const preparePhotoTokens = async (
  issuer: PhotoTokenIssuer,
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
  if (!parsedContext.success) throw new PhotoTokenPreparationError();

  const tokens = new Map<string, string>();
  const persistentTokens = new Map<string, string>();
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
      persist: previous.persist && next.persist,
      expiresAtMilliseconds: Math.min(previous.expiresAtMilliseconds, next.expiresAtMilliseconds),
    });
  }
  let withheldCount = 0;
  for (const [key, observation] of prepared) {
    if (observation === null) {
      withheldCount += 1;
      continue;
    }
    const result = await issuer.issue(
      {
        ownerScopeRef: context.ownerScopeRef,
        threadId: context.threadId,
        turnId: context.sourceTurnId,
        revision: context.sourceRevision,
        deviceId: context.deviceId,
        photoRef: observation.photoRef,
        ...(observation.persist ? { persist: true } : {}),
        expiresAt: new Date(observation.expiresAtMilliseconds).toISOString(),
      },
      context.now,
    );
    if (result.status === 'issued') {
      tokens.set(key, result.token);
      if (observation.persist) persistentTokens.set(key, result.token);
    } else withheldCount += 1;
  }

  return {
    issuedCount: tokens.size,
    withheldCount,
    resolve: (candidateId, photoRef) => tokens.get(keyFor(candidateId, photoRef)),
    resolvePersistent: (candidateId, photoRef) =>
      persistentTokens.get(keyFor(candidateId, photoRef)),
  };
};
