import type {
  CandidateRecord,
  CandidateObservationRegistryPort,
  ClockPort,
  HarnessContext,
  ObservationRegistration,
  ToolExecutionContext,
} from '@ima/core';
import type { GooglePlaceDetailsTransport } from './types';
import type { SavedReferenceDetailsHandoff } from './handoff';

export type PlacesDetailsObservationInput = Omit<
  ObservationRegistration,
  'freshUntil' | 'expiresAt' | 'retention'
>;

/** The Host applies the active retention policy immediately before registration. */
export type PlacesDetailsObservationPolicy = (input: {
  readonly now: string;
  readonly observation: PlacesDetailsObservationInput;
}) => Pick<ObservationRegistration, 'freshUntil' | 'expiresAt' | 'retention'> | undefined;

export type PlacesDetailsAreaLabel = (
  candidate: Readonly<CandidateRecord>,
  context: HarnessContext,
) => string;

export type PlacesDetailsAdapterOptions = {
  readonly transport: GooglePlaceDetailsTransport;
  readonly registry: CandidateObservationRegistryPort;
  readonly clock: ClockPort;
  /** Undefined policy means provider data must remain unregistered and withheld. */
  readonly observationPolicy?: PlacesDetailsObservationPolicy;
  /** Area is Host supplied; the adapter never derives it from an address. */
  readonly areaLabelFor: PlacesDetailsAreaLabel;
  /** Runtime may bridge its cancellation signal to the provider fetch. */
  readonly signalFor?: (execution: ToolExecutionContext) => AbortSignal | undefined;
  /** Current-origin route evidence shares its structured context with detail evidence. */
  readonly originRefFor?: (context: HarnessContext) => string | undefined;
  /** A saved-reference provider response may be consumed once without another HTTP request. */
  readonly savedReferenceHandoff?: SavedReferenceDetailsHandoff;
};
