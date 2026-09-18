import { DatabaseSync } from 'node:sqlite';
import type { PublicCard, RetentionMetadata } from '@ima/contracts';
import type { JourneyApiControllerBinding } from '@mobile/services/thread-session/journey-api-binding';
import {
  createMobileJourneyRuntime,
  type MobileJourneySavedReferenceOptions,
  type MobileRuntimeEnvironment,
} from '@mobile/services/runtime/mobile-runtime';
import type { ApiFetch } from '@mobile/services/api/api';
import { createSqliteStore } from '@mobile/services/sqlite/store';
import type {
  LocalSavedEntryId,
  SqliteConnection,
  SqliteValue,
} from '@mobile/services/sqlite/types';

export const environment: MobileRuntimeEnvironment = {
  EXPO_PUBLIC_API_MODE: 'fixture',
  EXPO_PUBLIC_API_BASE_URL: 'http://localhost:8787',
  EXPO_PUBLIC_FIXTURE_APP_TOKEN: 'fixture-token',
  EXPO_PUBLIC_FIXTURE_DEVICE_ID: 'device-1',
  EXPO_PUBLIC_FIXTURE_OWNER_CREDENTIAL: 'A'.repeat(43),
};

export const retention: RetentionMetadata = {
  retentionDecision: 'allow',
  retentionMode: 'identifier_indefinite_owner_scoped',
  sessionExpiresAt: '2026-09-10T13:00:00.000Z',
  freshUntil: null,
  displayUntil: null,
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};

export const referenceRetention: RetentionMetadata = {
  ...retention,
  sessionExpiresAt: '2026-09-10T14:00:00.000Z',
};

export const candidate: PublicCard = {
  candidateId: 'candidate-1',
  facts: {
    identity: {
      status: 'known',
      value: {
        name: '夜カフェ',
        area: '恵比寿',
        address: null,
        category: 'cafe',
        stationName: null,
        accessText: null,
        businessStatus: 'operational',
        sourceUrl: null,
      },
      evidence: [],
    },
  },
  why: {
    text: '静かに話せる',
    evidenceIds: [],
    evidence: [],
    basis: 'conversational',
    retention,
  },
};

export const visibleCandidate: PublicCard = {
  ...candidate,
  facts: {
    ...candidate.facts,
    identity: {
      status: 'known',
      value: {
        name: '夜カフェ',
        area: '恵比寿',
        address: null,
        category: 'cafe',
        stationName: null,
        accessText: null,
        businessStatus: 'operational',
        sourceUrl: null,
      },
      evidence: [{ evidenceId: 'evidence-runtime', attribution: null, retention }],
    },
  },
};

export const nonVisibleCandidate: PublicCard = {
  ...visibleCandidate,
  candidateId: 'candidate-old',
};

export const asLocal = (value: string): LocalSavedEntryId => value as LocalSavedEntryId;

export const openStore = (): {
  readonly database: DatabaseSync;
  readonly store: ReturnType<typeof createSqliteStore>;
} => {
  const database = new DatabaseSync(':memory:');
  const connection: SqliteConnection = {
    exec: (sql) => database.exec(sql),
    prepare: (sql) => {
      const statement = database.prepare(sql);
      return {
        run: (...values: SqliteValue[]) => statement.run(...values),
        get: (...values: SqliteValue[]) => statement.get(...values),
        all: (...values: SqliteValue[]) =>
          statement.all(...values).map((row) => row as Record<string, unknown>),
      };
    },
  };
  return {
    database,
    store: createSqliteStore(connection, {
      clock: { now: () => '2026-09-10T12:00:00.000Z' },
      nextLocalSavedEntryId: () => asLocal('local-1'),
    }),
  };
};

export const json = (value: unknown, status: number): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export const requestBodyFor = (init: RequestInit | undefined): Record<string, unknown> => {
  if (typeof init?.body !== 'string') throw new Error('test request body is missing');
  const parsed: unknown = JSON.parse(init.body);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('test request body is not an object');
  }
  return parsed as Record<string, unknown>;
};

export const stringField = (body: Record<string, unknown>, name: string): string => {
  const value = body[name];
  if (typeof value !== 'string') throw new Error(`test request field ${name} is missing`);
  return value;
};

export const runtimeFor = (
  fetchImpl: ApiFetch,
  savedReference?: MobileJourneySavedReferenceOptions,
  now = (): string => '2026-09-10T12:00:00.000Z',
) =>
  createMobileJourneyRuntime({
    env: environment,
    fetchImpl,
    now,
    requestIdFactory: (() => {
      let sequence = 0;
      return () => `request-${++sequence}`;
    })(),
    idFactory: (prefix) => `${prefix}-id`,
    ...(savedReference === undefined ? {} : { savedReference }),
  });

export const createThreadResponse = (requestId: string) => ({
  schemaVersion: 'v1',
  requestId,
  threadId: 'thread-runtime',
  revision: 1,
  state: 'active',
});

export const searchResponse = (requestId: string, revision = 2) => ({
  requestId,
  response: {
    schemaVersion: 'v1' as const,
    threadId: 'thread-runtime',
    turnId: `turn-runtime-${revision}`,
    responseId: `response-runtime-${revision}`,
    revision,
    kind: 'cards' as const,
    presentation: 'replace' as const,
    cardSetId: 'cardset-runtime',
    cards: { hero: visibleCandidate, alts: [] },
    message: [
      {
        text: '候補を確認しました',
        evidenceIds: [],
        evidence: [],
        basis: 'conversational' as const,
        retention,
      },
    ],
  },
  warnings: [],
});

export const searchRequestFor = (binding: JourneyApiControllerBinding, revision = 1) =>
  binding.requests.search({
    threadId: 'thread-runtime',
    revision,
    query: '静かな店',
    context: {
      conditions: {
        stationLabel: '',
        stationSupport: 'unknown',
        maxWalkMinutes: null,
        budget: 'any',
      },
      removedChipLabels: [],
      cardSetId: null,
      promotedCandidateId: null,
      selectedCandidateId: null,
      candidateOrder: [],
      excludeCandidateIds: [],
    },
  });
