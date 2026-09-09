import {
  CandidateObservationRegistry,
  type CardSetIdPort,
  type ClockPort,
  type RegistryIdPort,
  type SavedPlaceIdPort,
} from '@ima/core';

export class FixedClock implements ClockPort {
  constructor(private value: string) {}

  now(): string {
    return this.value;
  }

  set(value: string): void {
    this.value = value;
  }
}

export class FixedIdPort implements RegistryIdPort, SavedPlaceIdPort, CardSetIdPort {
  private call = 0;
  private place = 0;
  private candidate = 0;
  private observation = 0;
  private response = 0;
  private savedPlace = 0;
  private cardSet = 0;

  nextCallId(): string {
    this.call += 1;
    return `eval-call-${this.call}`;
  }

  nextPlaceRef(): string {
    this.place += 1;
    return `eval-place-${this.place}`;
  }

  nextCandidateId(): string {
    this.candidate += 1;
    return `eval-candidate-${this.candidate}`;
  }

  nextObservationId(): string {
    this.observation += 1;
    return `eval-observation-${this.observation}`;
  }

  nextResponseId(): string {
    this.response += 1;
    return `eval-response-${this.response}`;
  }

  nextSavedPlaceRef(): string {
    this.savedPlace += 1;
    return `eval-saved-${this.savedPlace}`;
  }

  nextCardSetId(): string {
    this.cardSet += 1;
    return `eval-card-set-${this.cardSet}`;
  }
}

export type RegistryFixture = {
  clock: FixedClock;
  ids: FixedIdPort;
  registry: CandidateObservationRegistry;
};

export function createRegistryFixture(now = '2026-09-09T12:00:00Z'): RegistryFixture {
  const clock = new FixedClock(now);
  const ids = new FixedIdPort();
  return { clock, ids, registry: new CandidateObservationRegistry(clock, ids) };
}
