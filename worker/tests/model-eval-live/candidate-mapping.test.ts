import { CandidateObservationRegistry } from '@worker/application/candidate-registry/registry';
import { type ClockPort, type RegistryIdPort } from '@worker/application/ports/context';
import { type CommitPort } from '@worker/application/ports/commit';
import { describe, expect, it } from 'vitest';
import { createPlacesSearchRegistration } from '@worker/adapters/out/providers/places-search/registration';
import { createRuntimeProductionConnectionOptions } from '@worker/composition/runtime-production-factory';
import { invokePublicToolEnvelope } from '@worker/adapters/in/tools';
import {
  createCandidateIdentityCapture,
  resolveCandidateIdentityMapping,
  type RuntimeCandidateIdentity,
} from '../../tooling/model-eval/candidate-mapping';
import { modelFor, type RuntimeGateModelReport } from '../support/runtime-model-fixture';

const NOW = '2026-09-10T12:00:00.000Z';
const scope = { ownerScopeRef: 'model-eval-owner', threadId: 'model-eval-thread' } as const;

class FixedClock implements ClockPort {
  now(): string {
    return NOW;
  }
}

class FixedIds implements RegistryIdPort {
  private candidate = 0;
  private place = 0;

  nextCallId(): string {
    return 'call-model-eval';
  }

  nextCandidateId(): string {
    this.candidate += 1;
    return `runtime-candidate-${this.candidate}`;
  }

  nextObservationId(): string {
    return 'observation-model-eval';
  }

  nextResponseId(): string {
    return 'response-model-eval';
  }

  nextPlaceRef(): string {
    this.place += 1;
    return `place-model-eval-${this.place}`;
  }
}

const expected = [
  {
    provider: 'google_places',
    recordRef: 'eval-place-a',
    evaluationCandidateId: 'candidate-a',
  },
  {
    provider: 'google_places',
    recordRef: 'eval-place-b',
    evaluationCandidateId: 'candidate-b',
  },
] as const;

const fixtureEnv = {
  IMA_RUNTIME_MODE: 'fixture',
  IMA_PROVIDER_OPENAI: 'true',
  IMA_PROVIDER_PLACES: 'true',
  IMA_PROVIDER_ROUTES: 'false',
  IMA_PROVIDER_LAST_TRAIN: 'false',
  IMA_PROVIDER_HOTPEPPER: 'false',
  IMA_KILL_SWITCH: 'false',
} as const;

const fixtureCommit: CommitPort = {
  commit: () => ({
    status: 'conflict',
    conflict: { code: 'STALE_REVISION', message: 'model-eval mapping fixture' },
  }),
};

const registryRecords = () => {
  const registry = new CandidateObservationRegistry(new FixedClock(), new FixedIds());
  return [
    registry.registerCandidate({
      ...scope,
      provider: 'google_places',
      recordRef: 'eval-place-a',
      displayName: '同名カフェ',
      status: 'operational',
    }),
    registry.registerCandidate({
      ...scope,
      provider: 'google_places',
      recordRef: 'eval-place-b',
      displayName: '同名カフェ',
      status: 'operational',
    }),
  ];
};

describe('model-eval candidate identity mapping', () => {
  it('captures Core registry records and joins same-name places by recordRef', () => {
    const capture = createCandidateIdentityCapture();
    for (const record of registryRecords()) capture.observe(record);

    const mapping = resolveCandidateIdentityMapping(capture.snapshot(), expected);
    expect(mapping.ok).toBe(true);
    if (!mapping.ok) return;
    expect(mapping.pairs).toEqual([
      {
        provider: 'google_places',
        recordRef: 'eval-place-a',
        runtimeCandidateId: 'runtime-candidate-1',
        evaluationCandidateId: 'candidate-a',
      },
      {
        provider: 'google_places',
        recordRef: 'eval-place-b',
        runtimeCandidateId: 'runtime-candidate-2',
        evaluationCandidateId: 'candidate-b',
      },
    ]);
    expect(mapping.byRuntimeCandidateId.get('runtime-candidate-1')).toBe('candidate-a');
    expect(mapping.byRuntimeCandidateId.get('runtime-candidate-2')).toBe('candidate-b');
  });

  it('keeps malformed or ambiguous host observations unverified', () => {
    const capture = createCandidateIdentityCapture();
    capture.observe({
      provider: 'google_places',
      recordRef: 'eval-place-a',
      candidateId: 'runtime-a',
    });
    capture.observe({
      provider: 'google_places',
      recordRef: 'eval-place-a',
      candidateId: 'runtime-b',
    });
    expect(capture.isUsable()).toBe(false);

    const malformed = resolveCandidateIdentityMapping(
      [{ provider: 'google_places', recordRef: 'eval-place-a', candidateId: '' }],
      expected,
    );
    expect(malformed).toEqual({ ok: false, code: 'CANDIDATE_ID_MAPPING_CONFLICT' });
  });

  it('does not infer a missing record from a matching display name', () => {
    const capture = createCandidateIdentityCapture();
    capture.observe({
      provider: 'google_places',
      recordRef: 'unrelated-place',
      candidateId: 'runtime-a',
    });
    const mapping = resolveCandidateIdentityMapping(capture.snapshot(), [expected[0]]);
    expect(mapping).toEqual({ ok: false, code: 'CANDIDATE_ID_MAPPING_UNAVAILABLE' });
  });

  it('captures the real registration boundary without exposing provider display fields', () => {
    const registry = new CandidateObservationRegistry(new FixedClock(), new FixedIds());
    const observed: RuntimeCandidateIdentity[] = [];
    const registration = createPlacesSearchRegistration({
      registry,
      clock: new FixedClock(),
      observationPolicy: () => undefined,
      observeCandidate: (record) => observed.push(record),
    });
    const record = registration.registerCandidate({
      ...scope,
      provider: 'google_places',
      recordRef: 'eval-place-a',
      displayName: '観測対象の表示名',
      status: 'operational',
    });
    expect(record).toBeDefined();
    expect(observed).toHaveLength(1);
    const capture = createCandidateIdentityCapture();
    capture.observe(observed[0]);
    expect(capture.snapshot()).toEqual([
      {
        provider: 'google_places',
        recordRef: 'eval-place-a',
        candidateId: 'runtime-candidate-1',
      },
    ]);
  });

  it('does not turn an observer exception into a registration failure', () => {
    const registry = new CandidateObservationRegistry(new FixedClock(), new FixedIds());
    const registration = createPlacesSearchRegistration({
      registry,
      clock: new FixedClock(),
      observationPolicy: () => undefined,
      observeCandidate: () => {
        throw new Error('trace sink unavailable');
      },
    });
    const record = registration.registerCandidate({
      ...scope,
      provider: 'google_places',
      recordRef: 'eval-place-a',
      displayName: '同名カフェ',
      status: 'operational',
    });
    if (record === undefined) throw new Error('candidate registration unexpectedly failed');
    expect(record.candidateId).toBe('runtime-candidate-1');
  });

  it('captures factory registration identities and maps them without an OpenAI key', async () => {
    const report: RuntimeGateModelReport = { calls: 0, requests: [] };
    const observed: RuntimeCandidateIdentity[] = [];
    const options = createRuntimeProductionConnectionOptions({
      env: fixtureEnv,
      commit: fixtureCommit,
      overrides: {
        modelForTurn: modelFor('search', report),
        hotPepperApiKey: 'fixture-places-key',
        placesCursorSecret: 'fixture-cursor-secret-16',
        placesEnabled: true,
        candidateIdentityObserver: (record) => observed.push(record),
        fetcher: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                places: [
                  {
                    id: 'eval-place-a',
                    displayName: { text: '同名カフェ' },
                    formattedAddress: '東京都渋谷区',
                    primaryType: 'cafe',
                    businessStatus: 'OPERATIONAL',
                    googleMapsUri: 'https://maps.google.com/?cid=eval-place-a',
                  },
                ],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          ),
        clock: () => NOW,
        monotonicNow: () => 0,
        epochNow: () => Date.parse(NOW),
      },
    });
    if (options === undefined) throw new Error('fixture production options unavailable');
    const composition = await options.buildTurn({
      ownerScopeRef: scope.ownerScopeRef,
      threadId: scope.threadId,
      turnId: 'model-eval-turn-1',
      revision: 1,
      messages: [],
      runtimeInput: {
        schemaVersion: 'v1',
        requestId: 'model-eval-request-1',
        turnId: 'model-eval-turn-1',
        revision: 1,
        text: 'カフェを探して',
        clientNow: NOW,
        location: {
          status: 'unavailable',
          lat: null,
          lng: null,
          accuracyMeters: null,
          precise: false,
          capturedAt: null,
        },
        prefs: {
          homeStationRef: null,
          maxWalkMinutes: null,
          minimumStayMinutes: 20,
          areaText: '渋谷',
          budget: 'normal',
        },
        savedPlaceRefs: [],
        excludeCandidateIds: [],
        mode: 'search',
        idempotencyKey: 'model-eval-idempotency-1',
      },
      serverNow: NOW,
    });
    const result = await invokePublicToolEnvelope(
      'search_places',
      {
        input: {
          mode: 'search',
          query: 'カフェ',
          area: { kind: 'named_area', name: '渋谷' },
          openNow: false,
          limit: 1,
          excludeCandidateIds: [],
        },
        metadata: {},
      },
      composition.turn.dependencies,
      { toolCallId: 'model-eval-search-1' },
    );
    expect(result.status).toBe('ok');
    expect(observed).toHaveLength(1);
    const mapping = resolveCandidateIdentityMapping(observed, [expected[0]]);
    expect(mapping.ok).toBe(true);
    if (mapping.ok) {
      const runtimeCandidateId = (result.status === 'ok' ? result.data.candidates[0] : undefined)
        ?.candidateId;
      if (runtimeCandidateId === undefined) throw new Error('runtime candidate missing');
      expect(mapping.byRuntimeCandidateId.get(runtimeCandidateId)).toBe('candidate-a');
    }
    composition.dispose();
  });
});
