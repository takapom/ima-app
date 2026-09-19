import * as v from 'valibot';
import {
  CapabilityVersionSchema,
  OpaqueIdSchema,
  SafeIntegerSchema,
  Text,
  ThreadIdSchema,
} from '@worker/domain/primitives';

export const LocationRevisionSchema = v.pipe(SafeIntegerSchema, v.minValue(0));
export type LocationRevision = v.InferOutput<typeof LocationRevisionSchema>;

/** Values that make an observation safe to reuse for one owner and thread. */
export const ObservationContextSchema = v.strictObject({
  ownerScopeRef: OpaqueIdSchema,
  threadId: ThreadIdSchema,
  capabilityVersion: CapabilityVersionSchema,
  locationRevision: LocationRevisionSchema,
  originRef: v.nullable(OpaqueIdSchema),
  homeStationRef: v.nullable(OpaqueIdSchema),
  minimumStayMinutes: v.nullable(v.pipe(SafeIntegerSchema, v.minValue(1), v.maxValue(180))),
  timeContext: Text(160),
});
export type ObservationContext = v.InferOutput<typeof ObservationContextSchema>;

export const RegistryScopeSchema = v.strictObject({
  ownerScopeRef: OpaqueIdSchema,
  threadId: ThreadIdSchema,
});
export type RegistryScope = v.InferOutput<typeof RegistryScopeSchema>;

export type ObservationFreshness = 'fresh' | 'expired';

function contextValues(context: ObservationContext, field: string): readonly string[] {
  return [
    'v1',
    field,
    context.ownerScopeRef,
    context.threadId,
    context.capabilityVersion,
    String(context.locationRevision),
    context.originRef ?? '',
    context.homeStationRef ?? '',
    context.minimumStayMinutes === null ? '' : String(context.minimumStayMinutes),
    context.timeContext,
  ];
}

function hash32(value: string, seed: number): number {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function contextKeyForObservation(context: ObservationContext, field: string): string {
  const canonical = JSON.stringify(contextValues(context, field));
  // This bounded hash is only an index key; access decisions compare the structured context.
  const left = hash32(canonical, 2_166_136_261).toString(16).padStart(8, '0');
  const right = hash32(canonical, 2_654_435_761).toString(16).padStart(8, '0');
  return `v1-${left}-${right}`;
}

export function matchesObservationContext(
  actual: ObservationContext,
  expected: ObservationContext,
): boolean {
  const actualValues = contextValues(actual, 'context');
  const expectedValues = contextValues(expected, 'context');
  return actualValues.every((value, index) => value === expectedValues[index]);
}

export function observationFreshness(
  observation: { freshUntil: string; expiresAt: string },
  now: string,
): ObservationFreshness {
  return Date.parse(now) < Date.parse(observation.freshUntil) &&
    Date.parse(now) < Date.parse(observation.expiresAt)
    ? 'fresh'
    : 'expired';
}
