/** Stable application identities shared by action contracts and persistence adapters. */
export type LocalSavedEntryId = string & { readonly __brand: 'LocalSavedEntryId' };
export type ServerSavedPlaceRef = string & { readonly __brand: 'ServerSavedPlaceRef' };
