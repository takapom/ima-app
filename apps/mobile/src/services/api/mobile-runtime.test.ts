import { describe, expect, it } from 'vitest';
import { parseSearchRequest, parseThreadTurnRequest } from '@ima/contracts';
import {
  createJourneyApiRequestFactory,
  createMobileJourneyRuntime,
  JourneyApiRequestFactoryError,
  mobileJourneyRuntimeMessage,
} from './mobile-runtime';

const baseEnv = {
  EXPO_PUBLIC_API_MODE: 'fixture',
  EXPO_PUBLIC_API_BASE_URL: 'http://localhost:8787',
  EXPO_PUBLIC_FIXTURE_APP_TOKEN: 'local-fixture-token',
  EXPO_PUBLIC_FIXTURE_DEVICE_ID: 'simulator-1',
  EXPO_PUBLIC_FIXTURE_OWNER_CREDENTIAL: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

const context = {
  conditions: {
    stationLabel: '新宿',
    stationSupport: 'supported' as const,
    maxWalkMinutes: 12,
    budget: 'normal' as const,
  },
  removedChipLabels: [],
  cardSetId: 'card-set-1',
  promotedCandidateId: 'candidate-2',
  selectedCandidateId: 'candidate-2',
  candidateOrder: ['candidate-2', 'candidate-1'],
  excludeCandidateIds: ['candidate-3'],
};

describe('mobile journey runtime composition', () => {
  it('selects fixture explicitly and builds a public-contract request', () => {
    let sequence = 0;
    const requests = createJourneyApiRequestFactory({
      now: () => '2026-09-10T10:00:00.000Z',
      idFactory: (prefix) => `${prefix}-${++sequence}`,
    });
    const request = requests.search({
      threadId: 'thread-1',
      revision: 1,
      query: '駅の近くで静かな店',
      context,
    });

    expect(parseSearchRequest(request).success).toBe(true);
    expect(request.text).toBe('駅の近くで静かな店');
    expect(request.prefs).toMatchObject({ maxWalkMinutes: 12, budget: 'normal' });
    expect(request.prefs.homeStationRef).toBeNull();
    expect(request.cardSetId).toBe('card-set-1');
    expect(request.promotedCandidateId).toBe('candidate-2');
    expect(request.selectedCandidateId).toBe('candidate-2');
    expect(request.candidateOrder).toEqual(['candidate-2', 'candidate-1']);
    expect(request.savedPlaceRefs).toEqual([]);
    expect(request.excludeCandidateIds).toEqual(['candidate-3']);
  });

  it('propagates explicit saved references without mapping them to candidate IDs', () => {
    const requests = createJourneyApiRequestFactory({
      now: () => '2026-09-10T10:00:00.000Z',
      idFactory: (prefix) => `${prefix}-saved`,
    });
    const input = {
      threadId: 'thread-1',
      revision: 2,
      query: '保存した候補を確認',
      context: {
        ...context,
        savedPlaceRefs: ['saved-place-a', 'saved-place-b'],
      },
    };
    const search = requests.search(input);
    const turn = requests.turn({ ...input, turnId: 'turn-1' });

    expect(parseSearchRequest(search).success).toBe(true);
    expect(parseThreadTurnRequest(turn).success).toBe(true);
    expect(search.savedPlaceRefs).toEqual(['saved-place-a', 'saved-place-b']);
    expect(turn.savedPlaceRefs).toEqual(['saved-place-a', 'saved-place-b']);
    expect(search.selectedCandidateId).toBe('candidate-2');
    expect(search.candidateOrder).toEqual(['candidate-2', 'candidate-1']);
  });

  it('rejects invalid saved reference input instead of truncating or deduplicating it', () => {
    const requests = createJourneyApiRequestFactory({
      now: () => '2026-09-10T10:00:00.000Z',
      idFactory: (prefix) => `${prefix}-saved-invalid`,
    });
    const expectIssue = (
      savedPlaceRefs: readonly string[],
      issue: JourneyApiRequestFactoryError['issue'],
    ): void => {
      let thrown: unknown;
      try {
        requests.search({
          threadId: 'thread-1',
          revision: 1,
          query: '保存候補',
          context: { ...context, savedPlaceRefs },
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(JourneyApiRequestFactoryError);
      expect(thrown).toMatchObject({ code: 'INVALID_SAVED_PLACE_REFS', issue });
    };

    expectIssue(['saved-place-a', 'saved-place-a'], 'duplicate');
    expectIssue(['saved place with spaces'], 'invalid_ref');
    expectIssue(
      Array.from({ length: 51 }, (_, index) => `saved-place-${index}`),
      'too_many',
    );
  });

  it('does not claim a runtime when mode or credentials are absent', () => {
    expect(createMobileJourneyRuntime({ env: {} })).toMatchObject({
      mode: 'unconfigured',
      binding: null,
      reason: 'mode_missing',
    });
    expect(
      createMobileJourneyRuntime({
        env: { EXPO_PUBLIC_API_MODE: 'live', EXPO_PUBLIC_API_BASE_URL: 'https://api.example.test' },
      }),
    ).toMatchObject({ mode: 'unconfigured', reason: 'live_credentials_unavailable' });
    expect(mobileJourneyRuntimeMessage('live_credentials_unavailable')).toContain('接続設定');
  });

  it('creates a fixture binding only when the explicit local credentials are supplied', () => {
    const runtime = createMobileJourneyRuntime({ env: baseEnv });
    expect(runtime.mode).toBe('fixture');
    expect(runtime.binding).not.toBeNull();
    expect(runtime.reason).toBeNull();
    expect(
      createMobileJourneyRuntime({ env: { ...baseEnv, EXPO_PUBLIC_ENVIRONMENT: 'production' } }),
    ).toMatchObject({ mode: 'unconfigured', reason: 'fixture_requires_dev' });
  });

  it('keeps live restricted to HTTPS and allows injected credentials at the boundary', () => {
    const credentials = {
      appToken: 'injected-live-token',
      deviceId: 'device-1',
      ownerCredential: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    };
    expect(
      createMobileJourneyRuntime({
        env: { EXPO_PUBLIC_API_MODE: 'live', EXPO_PUBLIC_API_BASE_URL: 'http://localhost:8787' },
        credentials,
      }),
    ).toMatchObject({ mode: 'unconfigured', reason: 'endpoint_invalid' });
    const live = createMobileJourneyRuntime({
      env: { EXPO_PUBLIC_API_MODE: 'live', EXPO_PUBLIC_API_BASE_URL: 'https://api.example.test' },
      credentials,
    });
    expect(live.mode).toBe('live');
    expect(live.binding).not.toBeNull();
    expect(live.reason).toBeNull();
    expect(
      createMobileJourneyRuntime({
        env: {
          ...baseEnv,
          EXPO_PUBLIC_API_MODE: 'live',
          EXPO_PUBLIC_API_BASE_URL: 'https://api.example.test',
        },
      }),
    ).toMatchObject({ mode: 'unconfigured', reason: 'live_credentials_unavailable' });
  });

  it('projects the Expo default environment through static public names', () => {
    const names = [
      'EXPO_PUBLIC_ENVIRONMENT',
      'EXPO_PUBLIC_API_MODE',
      'EXPO_PUBLIC_API_BASE_URL',
      'EXPO_PUBLIC_FIXTURE_APP_TOKEN',
      'EXPO_PUBLIC_FIXTURE_DEVICE_ID',
      'EXPO_PUBLIC_FIXTURE_OWNER_CREDENTIAL',
    ] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    process.env.EXPO_PUBLIC_ENVIRONMENT = 'production';
    process.env.EXPO_PUBLIC_API_MODE = 'fixture';
    process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:8787';
    process.env.EXPO_PUBLIC_FIXTURE_APP_TOKEN = 'fixture-token';
    process.env.EXPO_PUBLIC_FIXTURE_DEVICE_ID = 'device-1';
    process.env.EXPO_PUBLIC_FIXTURE_OWNER_CREDENTIAL =
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    try {
      expect(createMobileJourneyRuntime()).toMatchObject({
        mode: 'unconfigured',
        reason: 'fixture_requires_dev',
      });
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
