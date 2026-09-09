import * as v from 'valibot';
import type { Observation, SourceRef } from './evidence';
import type { ObservationContext, RegistryScope } from './freshness';
import type { RetentionMetadata } from './retention';
import { OpaqueIdSchema, Text } from './primitives';
import type { CandidateId, IsoTimestamp, ObservationId, OpaqueId } from './primitives';

export const CandidateStatusSchema = v.picklist([
  'operational',
  'temporarily_closed',
  'permanently_closed',
  'unknown',
]);
export type CandidateStatus = v.InferOutput<typeof CandidateStatusSchema>;

export const ProviderRecordIdentitySchema = v.strictObject({
  provider: Text(80),
  recordRef: Text(512),
});
export type ProviderRecordIdentity = v.InferOutput<typeof ProviderRecordIdentitySchema>;

export const CandidateRegistrationSchema = v.strictObject({
  ownerScopeRef: OpaqueIdSchema,
  threadId: OpaqueIdSchema,
  provider: Text(80),
  recordRef: Text(512),
  displayName: Text(160),
  status: CandidateStatusSchema,
});
export type CandidateRegistration = v.InferOutput<typeof CandidateRegistrationSchema>;

export type CandidateRecord = CandidateRegistration & {
  candidateId: CandidateId;
  placeRef: OpaqueId;
  excluded: boolean;
};

export type RegistryJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly RegistryJsonValue[]
  | { readonly [key: string]: RegistryJsonValue };

export type StoredObservation = Observation<RegistryJsonValue> & {
  freshUntil: IsoTimestamp;
  context: ObservationContext;
};
export type ReadonlyStoredObservation = Readonly<StoredObservation>;

export type ObservationRegistration = {
  scope: RegistryScope;
  candidateId: CandidateId;
  field: string;
  value: RegistryJsonValue;
  basis: 'provider_reported' | 'computed';
  sourceUpdatedAt: string | null;
  freshUntil: string;
  expiresAt: string;
  context: ObservationContext;
  sources: readonly SourceRef[];
  retention: RetentionMetadata;
};

export type ObservationReuseQuery = {
  scope: RegistryScope;
  candidateId: CandidateId;
  field: string;
  context: ObservationContext;
  observationId?: ObservationId;
};

export type ObservationReuseResult =
  | {
      status: 'reusable';
      observation: ReadonlyStoredObservation;
    }
  | { status: 'missing' | 'expired' | 'context_mismatch' }
  | {
      status: 'conflict';
      observations: readonly ReadonlyStoredObservation[];
    };

export type RegistryErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_CLOCK'
  | 'INVALID_ID'
  | 'DUPLICATE_ID'
  | 'OWNER_SCOPE_MISMATCH'
  | 'THREAD_SCOPE_MISMATCH'
  | 'UNKNOWN_CANDIDATE'
  | 'INVALID_OBSERVATION';

export class RegistryError extends Error {
  readonly code: RegistryErrorCode;

  constructor(code: RegistryErrorCode, message: string) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
  }
}
