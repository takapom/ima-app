import * as v from 'valibot';
import { RegistryScopeSchema, type RegistryScope } from '../domain/freshness';
import {
  SavedPlaceCandidateDetailsSchema,
  SavedPlaceRegistrationSchema,
  type SavedPlaceCandidateDetails,
  type SavedPlaceReference,
  type SavedPlaceRegistration,
} from '../domain/continuity';
import { RegistryError, type CandidateRecord } from '../domain/registry';
import {
  OpaqueIdSchema,
  SavedPlaceRefSchema,
  type OpaqueId,
  type SavedPlaceRef,
} from '../domain/primitives';
import type { CandidateObservationRegistryPort } from '../ports/registry';
import type { SavedPlaceIdPort } from '../ports/context';
import type { SavedPlaceReferencePort } from '../ports/continuity';

const identityKey = (ownerScopeRef: string, provider: string, recordRef: string): string =>
  JSON.stringify([ownerScopeRef, provider, recordRef]);

const assertGeneratedRef = (value: string, used: ReadonlySet<string>): SavedPlaceRef => {
  const parsed = v.safeParse(SavedPlaceRefSchema, value);
  if (!parsed.success)
    throw new RegistryError('INVALID_ID', 'savedPlaceRef generator returned an invalid ID');
  if (used.has(parsed.output))
    throw new RegistryError('DUPLICATE_ID', 'savedPlaceRef generator returned a duplicate ID');
  return parsed.output;
};

/** Stores an explicit owner-scoped provider reference and imports it only on request. */
export class SavedPlaceReferenceRegistry implements SavedPlaceReferencePort {
  private readonly references = new Map<SavedPlaceRef, Readonly<SavedPlaceReference>>();
  private readonly referencesByIdentity = new Map<string, SavedPlaceRef>();

  constructor(
    private readonly ids: SavedPlaceIdPort,
    private readonly candidates: CandidateObservationRegistryPort,
  ) {}

  registerSavedPlace(input: SavedPlaceRegistration): Readonly<SavedPlaceReference> {
    const parsed = v.safeParse(SavedPlaceRegistrationSchema, input);
    if (!parsed.success)
      throw new RegistryError('INVALID_ARGUMENT', 'saved place registration is invalid');
    const registration = parsed.output;
    const key = identityKey(
      registration.ownerScopeRef,
      registration.provider,
      registration.recordRef,
    );
    const existingRef = this.referencesByIdentity.get(key);
    if (existingRef !== undefined) {
      const existing = this.references.get(existingRef);
      if (existing !== undefined) return existing;
      this.referencesByIdentity.delete(key);
    }

    const savedPlaceRef = assertGeneratedRef(
      this.ids.nextSavedPlaceRef(),
      new Set(this.references.keys()),
    );
    const reference = Object.freeze({ ...registration, savedPlaceRef });
    this.references.set(savedPlaceRef, reference);
    this.referencesByIdentity.set(key, savedPlaceRef);
    return reference;
  }

  readSavedPlace(
    ownerScopeRef: OpaqueId,
    savedPlaceRef: SavedPlaceRef,
  ): Readonly<SavedPlaceReference> | undefined {
    if (!v.safeParse(OpaqueIdSchema, ownerScopeRef).success) return undefined;
    if (!v.safeParse(SavedPlaceRefSchema, savedPlaceRef).success) return undefined;
    const reference = this.references.get(savedPlaceRef);
    return reference?.ownerScopeRef === ownerScopeRef ? reference : undefined;
  }

  deleteSavedPlace(ownerScopeRef: OpaqueId, savedPlaceRef: SavedPlaceRef): boolean {
    const reference = this.readSavedPlace(ownerScopeRef, savedPlaceRef);
    if (reference === undefined) return false;
    this.references.delete(savedPlaceRef);
    this.referencesByIdentity.delete(
      identityKey(reference.ownerScopeRef, reference.provider, reference.recordRef),
    );
    return true;
  }

  importSavedPlace(
    scope: RegistryScope,
    savedPlaceRef: SavedPlaceRef,
    details: SavedPlaceCandidateDetails,
  ): Readonly<CandidateRecord> | undefined {
    if (!v.safeParse(RegistryScopeSchema, scope).success) {
      throw new RegistryError('INVALID_ARGUMENT', 'saved place import scope is invalid');
    }
    const parsedDetails = v.safeParse(SavedPlaceCandidateDetailsSchema, details);
    if (!parsedDetails.success) {
      throw new RegistryError('INVALID_ARGUMENT', 'saved place import details are invalid');
    }
    const reference = this.readSavedPlace(scope.ownerScopeRef, savedPlaceRef);
    if (reference === undefined) return undefined;
    return this.candidates.registerCandidate({
      ...scope,
      provider: reference.provider,
      recordRef: reference.recordRef,
      ...parsedDetails.output,
    });
  }
}
