import * as v from 'valibot';
import { PreferencesSchema, type Preferences } from '@ima/contracts';
import { IsoTimestampSchema, OpaqueIdSchema, SavedPlaceRefSchema } from '@worker/domain/primitives';
import {
  SavedPlaceRegistrationSchema,
  SavedPlaceReferenceSchema,
  type SavedPlaceReference,
} from '@worker/domain/candidates/continuity';
import type {
  OwnerDecideInput,
  OwnerDecideResult,
  OwnerPrefsPutInput,
  OwnerPrefsPutResult,
  OwnerPrefsReadResult,
  OwnerRegisterResult,
  OwnerSavedListResult,
  OwnerStore,
} from '@worker/application/ports/owner-store';
import type {
  SavedReferenceDeleteResult,
  SavedReferenceOperationOptions,
  SavedReferenceReadResult,
  SavedReferenceReplayResult,
} from '@worker/application/ports/saved-reference-store';

const MAX_SAVED_LIST = 50;
const ExpectedRevisionSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

type OperationRecord = {
  readonly operation: 'register' | 'remove';
  readonly fingerprint: string | null;
  readonly provider: string | null;
  readonly recordRef: string | null;
  readonly savedPlaceRef: string;
  readonly deleted: boolean;
};

type OwnerBucket = {
  prefs: { readonly revision: number; readonly prefs: Preferences } | undefined;
  readonly references: Map<string, SavedPlaceReference>;
  readonly identity: Map<string, string>;
  readonly operations: Map<string, OperationRecord>;
  readonly decided: Map<string, string>;
  readonly decideOperations: Map<
    string,
    {
      readonly fingerprint: string | null;
      readonly savedPlaceRef: string;
      readonly decidedAt: string;
    }
  >;
};

const parseOwner = (ownerScopeRef: string): string | undefined => {
  const parsed = v.safeParse(OpaqueIdSchema, ownerScopeRef);
  return parsed.success ? parsed.output : undefined;
};

const prefsEqual = (left: Preferences, right: Preferences): boolean =>
  left.areaText === right.areaText && left.budget === right.budget;

const identityKey = (provider: string, recordRef: string): string => `${provider}\0${recordRef}`;

const parsedOperationKey = (
  options: SavedReferenceOperationOptions | undefined,
): string | null | undefined => {
  if (options?.idempotencyKey === undefined) return null;
  const parsed = v.safeParse(OpaqueIdSchema, options.idempotencyKey);
  return parsed.success ? parsed.output : undefined;
};

const parsedFingerprint = (
  options: SavedReferenceOperationOptions | undefined,
): string | null | undefined => {
  if (options?.idempotencyFingerprint === undefined) return null;
  const parsed = v.safeParse(OpaqueIdSchema, options.idempotencyFingerprint);
  return parsed.success ? parsed.output : undefined;
};

const parseOwnerAndRef = (
  ownerScopeRef: string,
  savedPlaceRef: string,
): { readonly ownerScopeRef: string; readonly savedPlaceRef: string } | undefined => {
  const owner = parseOwner(ownerScopeRef);
  const saved = v.safeParse(SavedPlaceRefSchema, savedPlaceRef);
  if (owner === undefined || !saved.success) return undefined;
  return { ownerScopeRef: owner, savedPlaceRef: saved.output };
};

const referenceFrom = (input: {
  readonly savedPlaceRef: string;
  readonly ownerScopeRef: string;
  readonly provider: string;
  readonly recordRef: string;
}): SavedPlaceReference | undefined => {
  const parsed = v.safeParse(SavedPlaceReferenceSchema, input);
  return parsed.success ? parsed.output : undefined;
};

const invalidInput: { readonly ok: false; readonly code: 'INVALID_INPUT' } = {
  ok: false,
  code: 'INVALID_INPUT',
};

/**
 * Process-local OwnerStore. One instance holds every owner, keyed by ownerScopeRef.
 */
export const createMemoryOwnerStore = (ids?: {
  readonly nextSavedPlaceRef: () => string;
}): OwnerStore => {
  const nextSavedPlaceRef =
    ids === undefined ? () => `saved-${crypto.randomUUID()}` : ids.nextSavedPlaceRef;
  const buckets = new Map<string, OwnerBucket>();
  const usedRefs = new Set<string>();

  const bucketFor = (owner: string): OwnerBucket => {
    const existing = buckets.get(owner);
    if (existing !== undefined) return existing;
    const created: OwnerBucket = {
      prefs: undefined,
      references: new Map(),
      identity: new Map(),
      operations: new Map(),
      decided: new Map(),
      decideOperations: new Map(),
    };
    buckets.set(owner, created);
    return created;
  };

  const readPrefs = (ownerScopeRef: string): Promise<OwnerPrefsReadResult> =>
    Promise.resolve().then(() => {
      const owner = parseOwner(ownerScopeRef);
      if (owner === undefined) return invalidInput;
      const bucket = buckets.get(owner);
      if (bucket === undefined || bucket.prefs === undefined) {
        return { ok: true, revision: 0, prefs: null };
      }
      return { ok: true, revision: bucket.prefs.revision, prefs: bucket.prefs.prefs };
    });

  const putPrefs = (
    ownerScopeRef: string,
    input: OwnerPrefsPutInput,
  ): Promise<OwnerPrefsPutResult> =>
    Promise.resolve().then(() => {
      const owner = parseOwner(ownerScopeRef);
      const expected = v.safeParse(ExpectedRevisionSchema, input.expectedRevision);
      const prefs = v.safeParse(PreferencesSchema, input.prefs);
      if (owner === undefined || !expected.success || !prefs.success) return invalidInput;
      const bucket = bucketFor(owner);
      const currentRevision = bucket.prefs === undefined ? 0 : bucket.prefs.revision;
      const currentPrefs = bucket.prefs === undefined ? null : bucket.prefs.prefs;
      if (expected.output === currentRevision) {
        if (currentPrefs !== null && prefsEqual(currentPrefs, prefs.output)) {
          return { ok: true, revision: currentRevision, replayed: true };
        }
        const revision = currentRevision + 1;
        bucket.prefs = { revision, prefs: prefs.output };
        return { ok: true, revision, replayed: false };
      }
      if (
        expected.output === currentRevision - 1 &&
        currentPrefs !== null &&
        prefsEqual(currentPrefs, prefs.output)
      ) {
        return { ok: true, revision: currentRevision, replayed: true };
      }
      return { ok: false, code: 'REVISION_CONFLICT' };
    });

  const listSaved = (ownerScopeRef: string): Promise<OwnerSavedListResult> =>
    Promise.resolve().then(() => {
      const owner = parseOwner(ownerScopeRef);
      if (owner === undefined) return invalidInput;
      const bucket = buckets.get(owner);
      if (bucket === undefined) return { ok: true, references: [], decided: [] };
      const references = [...bucket.references.values()].slice(0, MAX_SAVED_LIST);
      return {
        ok: true,
        references,
        decided: references.flatMap((reference) => {
          const decidedAt = bucket.decided.get(reference.savedPlaceRef);
          return decidedAt === undefined
            ? []
            : [{ savedPlaceRef: reference.savedPlaceRef, decidedAt }];
        }),
      };
    });

  const rememberOperation = (
    bucket: OwnerBucket,
    input: {
      readonly idempotencyKey: string;
      readonly operation: 'register' | 'remove';
      readonly fingerprint: string | null;
      readonly provider: string | null;
      readonly recordRef: string | null;
      readonly savedPlaceRef: string;
      readonly deleted: boolean;
    },
  ): void => {
    bucket.operations.set(input.idempotencyKey, {
      operation: input.operation,
      fingerprint: input.fingerprint,
      provider: input.provider,
      recordRef: input.recordRef,
      savedPlaceRef: input.savedPlaceRef,
      deleted: input.deleted,
    });
  };

  const scrubIdentity = (bucket: OwnerBucket, savedPlaceRef: string): void => {
    for (const [key, prior] of bucket.operations) {
      if (prior.savedPlaceRef !== savedPlaceRef) continue;
      bucket.operations.set(key, { ...prior, provider: null, recordRef: null });
    }
  };

  const register = (
    ownerScopeRef: string,
    input: { readonly provider: string; readonly recordRef: string },
    options?: SavedReferenceOperationOptions,
  ): Promise<OwnerRegisterResult> =>
    Promise.resolve().then(() => {
      const owner = parseOwner(ownerScopeRef);
      if (owner === undefined) return invalidInput;
      const parsed = v.safeParse(SavedPlaceRegistrationSchema, {
        ...input,
        ownerScopeRef: owner,
      });
      if (!parsed.success) return invalidInput;
      const idempotencyKey = parsedOperationKey(options);
      if (idempotencyKey === undefined) return invalidInput;
      const fingerprint = parsedFingerprint(options);
      if (fingerprint === undefined) return invalidInput;
      if (idempotencyKey === null && fingerprint !== null) return invalidInput;
      const registration = parsed.output;
      const bucket = bucketFor(owner);
      if (idempotencyKey !== null) {
        const prior = bucket.operations.get(idempotencyKey);
        if (prior !== undefined) {
          if (
            prior.operation !== 'register' ||
            prior.fingerprint !== fingerprint ||
            prior.provider !== registration.provider ||
            prior.recordRef !== registration.recordRef
          ) {
            return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
          }
          const replayed = bucket.references.get(prior.savedPlaceRef);
          return replayed === undefined
            ? { ok: false, code: 'REFERENCE_CONFLICT' }
            : { ok: true, created: false, reference: replayed };
        }
      }
      const existingRef = bucket.identity.get(
        identityKey(registration.provider, registration.recordRef),
      );
      if (existingRef !== undefined) {
        const reference = bucket.references.get(existingRef);
        if (reference === undefined) return { ok: false, code: 'CORRUPT_ROW' };
        if (idempotencyKey !== null) {
          rememberOperation(bucket, {
            idempotencyKey,
            operation: 'register',
            fingerprint,
            provider: registration.provider,
            recordRef: registration.recordRef,
            savedPlaceRef: reference.savedPlaceRef,
            deleted: false,
          });
        }
        return { ok: true, created: false, reference };
      }
      const generated = v.safeParse(SavedPlaceRefSchema, nextSavedPlaceRef());
      if (!generated.success) return { ok: false, code: 'INVALID_GENERATED_ID' };
      if (usedRefs.has(generated.output)) return { ok: false, code: 'REFERENCE_CONFLICT' };
      const reference = referenceFrom({
        savedPlaceRef: generated.output,
        ownerScopeRef: registration.ownerScopeRef,
        provider: registration.provider,
        recordRef: registration.recordRef,
      });
      if (reference === undefined) return { ok: false, code: 'CORRUPT_ROW' };
      usedRefs.add(reference.savedPlaceRef);
      bucket.references.set(reference.savedPlaceRef, reference);
      bucket.identity.set(
        identityKey(reference.provider, reference.recordRef),
        reference.savedPlaceRef,
      );
      if (idempotencyKey !== null) {
        rememberOperation(bucket, {
          idempotencyKey,
          operation: 'register',
          fingerprint,
          provider: reference.provider,
          recordRef: reference.recordRef,
          savedPlaceRef: reference.savedPlaceRef,
          deleted: false,
        });
      }
      return { ok: true, created: true, reference };
    });

  const replay = (
    ownerScopeRef: string,
    idempotencyKey: unknown,
    idempotencyFingerprint: unknown,
  ): Promise<SavedReferenceReplayResult> =>
    Promise.resolve().then(() => {
      const owner = parseOwner(ownerScopeRef);
      const key = v.safeParse(OpaqueIdSchema, idempotencyKey);
      const fingerprint = v.safeParse(OpaqueIdSchema, idempotencyFingerprint);
      if (owner === undefined || !key.success || !fingerprint.success) return invalidInput;
      const prior = buckets.get(owner)?.operations.get(key.output);
      if (prior === undefined) return { ok: true, found: false };
      if (prior.operation !== 'register' || prior.fingerprint !== fingerprint.output) {
        return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
      }
      const reference = buckets.get(owner)?.references.get(prior.savedPlaceRef);
      return reference === undefined
        ? { ok: false, code: 'REFERENCE_CONFLICT' }
        : { ok: true, found: true, reference };
    });

  const read = (ownerScopeRef: string, savedPlaceRef: string): Promise<SavedReferenceReadResult> =>
    Promise.resolve().then(() => {
      const parsed = parseOwnerAndRef(ownerScopeRef, savedPlaceRef);
      if (parsed === undefined) return invalidInput;
      const reference = buckets.get(parsed.ownerScopeRef)?.references.get(parsed.savedPlaceRef);
      return { ok: true, reference: reference === undefined ? null : reference };
    });

  const remove = (
    ownerScopeRef: string,
    savedPlaceRef: string,
    options?: SavedReferenceOperationOptions,
  ): Promise<SavedReferenceDeleteResult> =>
    Promise.resolve().then(() => {
      const parsed = parseOwnerAndRef(ownerScopeRef, savedPlaceRef);
      if (parsed === undefined) return invalidInput;
      const idempotencyKey = parsedOperationKey(options);
      if (idempotencyKey === undefined) return invalidInput;
      const fingerprint = parsedFingerprint(options);
      if (fingerprint === undefined) return invalidInput;
      if (idempotencyKey === null && fingerprint !== null) return invalidInput;
      const bucket = bucketFor(parsed.ownerScopeRef);
      if (idempotencyKey !== null) {
        const prior = bucket.operations.get(idempotencyKey);
        if (prior !== undefined) {
          return prior.operation === 'remove' &&
            prior.savedPlaceRef === parsed.savedPlaceRef &&
            prior.fingerprint === fingerprint
            ? { ok: true, deleted: prior.deleted }
            : { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
        }
      }
      const reference = bucket.references.get(parsed.savedPlaceRef);
      if (reference === undefined) {
        if (idempotencyKey !== null) {
          rememberOperation(bucket, {
            idempotencyKey,
            operation: 'remove',
            fingerprint,
            provider: null,
            recordRef: null,
            savedPlaceRef: parsed.savedPlaceRef,
            deleted: false,
          });
        }
        return { ok: true, deleted: false };
      }
      bucket.references.delete(parsed.savedPlaceRef);
      bucket.identity.delete(identityKey(reference.provider, reference.recordRef));
      bucket.decided.delete(parsed.savedPlaceRef);
      scrubIdentity(bucket, parsed.savedPlaceRef);
      if (idempotencyKey !== null) {
        rememberOperation(bucket, {
          idempotencyKey,
          operation: 'remove',
          fingerprint,
          provider: null,
          recordRef: null,
          savedPlaceRef: parsed.savedPlaceRef,
          deleted: true,
        });
      }
      return { ok: true, deleted: true };
    });

  const decide = (
    ownerScopeRef: string,
    input: OwnerDecideInput,
    options?: SavedReferenceOperationOptions,
  ): Promise<OwnerDecideResult> =>
    Promise.resolve().then(() => {
      const owner = parseOwner(ownerScopeRef);
      const decidedAt = v.safeParse(IsoTimestampSchema, input.decidedAt);
      if (owner === undefined || !decidedAt.success) return invalidInput;
      const parsed = v.safeParse(SavedPlaceRegistrationSchema, {
        ownerScopeRef: owner,
        provider: input.provider,
        recordRef: input.recordRef,
      });
      if (!parsed.success) return invalidInput;
      const idempotencyKey = parsedOperationKey(options);
      if (idempotencyKey === undefined) return invalidInput;
      const fingerprint = parsedFingerprint(options);
      if (fingerprint === undefined) return invalidInput;
      if (idempotencyKey === null && fingerprint !== null) return invalidInput;
      const bucket = bucketFor(owner);
      if (idempotencyKey !== null) {
        const prior = bucket.decideOperations.get(idempotencyKey);
        if (prior !== undefined) {
          if (prior.fingerprint !== fingerprint) {
            return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
          }
          const reference = bucket.references.get(prior.savedPlaceRef);
          return reference === undefined
            ? { ok: false, code: 'REFERENCE_CONFLICT' }
            : {
                ok: true,
                created: false,
                replayed: true,
                reference,
                decidedAt: prior.decidedAt,
              };
        }
      }
      const existingRef = bucket.identity.get(
        identityKey(parsed.output.provider, parsed.output.recordRef),
      );
      let created = false;
      let reference = existingRef === undefined ? undefined : bucket.references.get(existingRef);
      if (reference === undefined) {
        const savedPlaceRef = nextSavedPlaceRef();
        if (
          usedRefs.has(savedPlaceRef) ||
          !v.safeParse(SavedPlaceRefSchema, savedPlaceRef).success
        ) {
          return { ok: false, code: 'INVALID_GENERATED_ID' };
        }
        const built = referenceFrom({
          savedPlaceRef,
          ownerScopeRef: owner,
          provider: parsed.output.provider,
          recordRef: parsed.output.recordRef,
        });
        if (built === undefined) return { ok: false, code: 'INVALID_GENERATED_ID' };
        usedRefs.add(savedPlaceRef);
        bucket.references.set(savedPlaceRef, built);
        bucket.identity.set(identityKey(built.provider, built.recordRef), savedPlaceRef);
        reference = built;
        created = true;
      }
      bucket.decided.set(reference.savedPlaceRef, decidedAt.output);
      if (idempotencyKey !== null) {
        bucket.decideOperations.set(idempotencyKey, {
          fingerprint,
          savedPlaceRef: reference.savedPlaceRef,
          decidedAt: decidedAt.output,
        });
      }
      return {
        ok: true,
        created,
        replayed: false,
        reference,
        decidedAt: decidedAt.output,
      };
    });

  return { readPrefs, putPrefs, listSaved, decide, register, replay, read, remove };
};
