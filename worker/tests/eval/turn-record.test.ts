import * as v from 'valibot';
import {
  LocationSnapshotSchema,
  ThreadTurnRequestSchema,
  type AssistantResponse,
  type PlaceIdentity,
  type RetentionMetadata,
} from '@ima/contracts';
import { describe, expect, it } from 'vitest';
import type { ThreadRuntimeTurnResult } from '@worker/runtime/threads/admission';
import { EvalCaseSchema, EvalTurnRecordSchema } from '../../tooling/eval/eval-contract';
import {
  evalLocationFor,
  evalTurnInput,
  evalTurnRecord,
  responseOf,
  type EvalTurnObservation,
} from '../../tooling/eval/turn-record';

const NOW = '2026-10-10T11:00:00.000Z';
const origin = { lat: 35.658, lng: 139.7016 };

const retention: RetentionMetadata = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-10-10T20:00:00.000Z',
  freshUntil: '2026-10-10T11:30:00.000Z',
  displayUntil: '2026-10-10T20:00:00.000Z',
  retentionUntil: '2026-10-10T20:00:00.000Z',
  deletionScheduledAt: '2026-10-10T20:00:00.000Z',
  attribution: null,
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};

const text = (value: string) => ({ text: value, retention });

const identity: PlaceIdentity = {
  name: '架空 甘味処 こもれび',
  area: '渋谷',
  address: null,
  category: null,
  stationName: null,
  accessText: null,
  businessStatus: 'operational',
  sourceUrl: null,
};

const cardsResponse: AssistantResponse = {
  schemaVersion: 'v1',
  threadId: 'eval-thread',
  turnId: 'eval-turn-1',
  responseId: 'response-1',
  revision: 2,
  message: [text('甘いものなら近くのこちらです。')],
  kind: 'cards',
  presentation: 'replace',
  cardSetId: 'card-set-1',
  cards: {
    hero: {
      candidateId: 'candidate-1',
      facts: {
        identity: {
          status: 'known',
          value: identity,
          evidence: [{ evidenceId: 'evidence-1', attribution: null, retention }],
        },
      },
      why: text('和パフェの掲載があり甘いものに合います'),
    },
    alts: [
      {
        candidateId: 'candidate-2',
        facts: { identity: { status: 'unknown', reason: 'not shown' } },
        why: text('ケーキの掲載があります'),
        diff: text('少し遠い'),
      },
    ],
  },
};

const evalCase = v.parse(EvalCaseSchema, {
  shopSet: 'shibuya-ebisu',
  now: NOW,
  location: 'available',
  turns: ['近くで甘いもの食べたい', 'もう少し静かなところは？'],
});

const observation = (overrides: Partial<EvalTurnObservation> = {}): EvalTurnObservation => ({
  toolCalls: [
    { name: 'search_places', args: { input: { query: 'スイーツ' } }, result: null },
    { name: 'respond', args: { input: { kind: 'propose' } }, result: null },
  ],
  toolResultsMatched: true,
  modelCalls: [],
  respondMissing: [],
  evalError: null,
  outcome: { committed: true, operations: { search_places: 1, respond: 1 }, kind: 'propose' },
  rejections: [],
  ...overrides,
});

const completed = (response: AssistantResponse | null): ThreadRuntimeTurnResult => ({
  status: 'completed',
  requestId: 'request-1',
  response,
});

describe('evalLocationFor', () => {
  it('builds a valid snapshot for every status and shares coordinates only when available', () => {
    for (const status of ['available', 'denied', 'reduced', 'timeout', 'unavailable'] as const) {
      const location = evalLocationFor(status, origin, NOW);
      expect(v.safeParse(LocationSnapshotSchema, location).success).toBe(true);
      expect(location.lat !== null).toBe(status === 'available' || status === 'reduced');
    }
  });
});

describe('evalTurnInput', () => {
  it('sends a contract-valid first turn without displayed cards', () => {
    const input = evalTurnInput({
      evalCase,
      threadId: 'eval-thread',
      index: 0,
      text: '近くで甘いもの食べたい',
      location: evalLocationFor('available', origin, NOW),
      shown: null,
    });
    expect(input.revision).toBe(1);
    expect(input.input.text).toBe('近くで甘いもの食べたい');
    expect(input.input.cardSetId).toBeNull();
    expect(v.safeParse(ThreadTurnRequestSchema, input.input).success).toBe(true);
  });

  it('carries the displayed cards into the next turn, as the app does', () => {
    const input = evalTurnInput({
      evalCase,
      threadId: 'eval-thread',
      index: 1,
      text: 'もう少し静かなところは？',
      location: evalLocationFor('available', origin, NOW),
      shown: cardsResponse,
    });
    expect(input.revision).toBe(2);
    expect(input.input.text).toBe('もう少し静かなところは？');
    expect(input.input.cardSetId).toBe('card-set-1');
    expect(input.input.candidateOrder).toEqual(['candidate-1', 'candidate-2']);
    expect(v.safeParse(ThreadTurnRequestSchema, input.input).success).toBe(true);
  });
});

describe('evalTurnRecord', () => {
  it('records the committed proposal, its cards and the committed respond', () => {
    const record = evalTurnRecord(
      '近くで甘いもの食べたい',
      completed(cardsResponse),
      observation(),
    );
    expect(v.safeParse(EvalTurnRecordSchema, record).success).toBe(true);
    expect(record).toMatchObject({
      committed: true,
      kind: 'propose',
      evalError: null,
      toolResultsMatched: true,
      messages: ['甘いものなら近くのこちらです。'],
      cards: [
        { name: '架空 甘味処 こもれび', why: '和パフェの掲載があり甘いものに合います', diff: null },
        { name: null, why: 'ケーキの掲載があります', diff: '少し遠い' },
      ],
    });
    expect(record.toolCalls.map((call) => call.result?.status ?? null)).toEqual([
      null,
      'committed',
    ]);
  });

  it('keeps a failed turn uncommitted and never invents a committed respond', () => {
    const record = evalTurnRecord(
      '近くで甘いもの食べたい',
      { status: 'failed', requestId: 'request-1', response: null, code: 'RUNTIME_FAILED' },
      observation({ outcome: { committed: false, operations: { respond: 1 } } }),
    );
    expect(record).toMatchObject({
      runStatus: 'failed',
      failureCode: 'RUNTIME_FAILED',
      committed: false,
      kind: null,
      messages: [],
      cards: [],
    });
    expect(record.toolCalls.every((call) => call.result === null)).toBe(true);
  });

  it('reports the zero-candidate outcome and refused responds', () => {
    const message: AssistantResponse = {
      ...cardsResponse,
      kind: 'message',
      presentation: 'keep',
      cardSetId: null,
      searchOutcome: 'no_candidates',
    };
    const record = evalTurnRecord(
      '札幌でスープカレー',
      completed(message),
      observation({
        outcome: { committed: true, operations: {}, kind: 'answer' },
        rejections: [
          {
            repairable: true,
            remainingRepairs: 1,
            candidates: 0,
            issues: [{ code: 'UNKNOWN_CANDIDATE', path: null, missingFields: [], message: 'x' }],
          },
        ],
      }),
    );
    expect(record.searchOutcome).toBe('no_candidates');
    expect(record.respondRejections).toEqual([
      { codes: ['UNKNOWN_CANDIDATE'], remainingRepairs: 1 },
    ]);
  });

  it('marks a turn whose prompt variant could not be applied', () => {
    const record = evalTurnRecord(
      '近くで甘いもの食べたい',
      { status: 'failed', requestId: 'request-1', response: null, code: 'RUNTIME_FAILED' },
      observation({
        toolCalls: [],
        outcome: null,
        evalError: 'SYSTEM_PROMPT_NOT_FOUND',
        toolResultsMatched: true,
      }),
    );
    expect(record.evalError).toBe('SYSTEM_PROMPT_NOT_FOUND');
    expect(record.committed).toBe(false);
  });

  it('treats a replay reference as having no readable response', () => {
    expect(
      responseOf({
        status: 'completed',
        requestId: null,
        response: {
          turnId: 'eval-turn-1',
          responseId: 'response-1',
          revision: 2,
          kind: 'cards',
          presentation: 'replace',
          cardSetId: 'card-set-1',
          restoreMode: 'reference_only',
        },
      }),
    ).toBeNull();
  });
});
