import type { AssistantResponse, LocationSnapshot } from '@ima/contracts';
import type {
  ThreadRuntimeTurnInput,
  ThreadRuntimeTurnResult,
} from '@worker/runtime/threads/admission';
import type { EvalCase, EvalToolCall, EvalTurnRecord } from './eval-contract';
import type {
  RuntimeSubmitRejection,
  RuntimeTurnOutcome,
} from '@worker/runtime/turn-execution/runtime-submit-diagnostic';
import type { EvalModelRecording } from './model-recorder';

export const EVAL_OWNER_SCOPE_REF = 'eval-owner';

/** 1ターンの間にモデル・Tool・確定処理で起きたこと。 */
export type EvalTurnObservation = EvalModelRecording & {
  readonly outcome: RuntimeTurnOutcome | null;
  readonly rejections: readonly RuntimeSubmitRejection[];
};

/** ケースが指定した端末位置を作る。座標は店舗セットからだけ取る。 */
export const evalLocationFor = (
  status: EvalCase['location'],
  origin: { readonly lat: number; readonly lng: number },
  now: string,
): LocationSnapshot => {
  if (status === 'available') {
    return { status, ...origin, accuracyMeters: 20, precise: true, capturedAt: now };
  }
  if (status === 'reduced') {
    return { status, ...origin, accuracyMeters: 3_000, precise: false, capturedAt: now };
  }
  return { status, lat: null, lng: null, accuracyMeters: null, precise: false, capturedAt: null };
};

const cardsOf = (response: AssistantResponse | null) =>
  response?.kind === 'cards' ? [response.cards.hero, ...response.cards.alts] : [];

/** アプリが送るのと同じ形のターン要求。表示中のカードも引き継ぐ。 */
export const evalTurnInput = (input: {
  readonly evalCase: EvalCase;
  readonly threadId: string;
  readonly index: number;
  readonly text: string;
  readonly location: LocationSnapshot;
  readonly shown: AssistantResponse | null;
}): ThreadRuntimeTurnInput => {
  const { evalCase, threadId, index, text, location, shown } = input;
  const revision = index + 1;
  const turnId = `eval-turn-${revision}-${crypto.randomUUID()}`;
  const idempotencyKey = `eval-${turnId}`;
  const shownCards = cardsOf(shown);
  return {
    ownerScopeRef: EVAL_OWNER_SCOPE_REF,
    threadId,
    turnId,
    revision,
    idempotencyKey,
    input: {
      schemaVersion: 'v1',
      requestId: `eval-request-${turnId}`,
      turnId,
      revision,
      text,
      clientNow: evalCase.now,
      location,
      prefs: { areaText: evalCase.areaText, budget: evalCase.budget },
      cardSetId: shown?.cardSetId ?? null,
      ...(shownCards.length === 0
        ? {}
        : { candidateOrder: shownCards.map((card) => card.candidateId) }),
      excludeCandidateIds: [],
      mode: 'search',
      idempotencyKey,
    },
  };
};

/** 初回完了時の公開応答。再送時の参照には本文がないためnullを返す。 */
export const responseOf = (result: ThreadRuntimeTurnResult): AssistantResponse | null =>
  result.response === null || 'restoreMode' in result.response ? null : result.response;

/** 最後のrespondを確定済みにする。その結果は後続stepでモデルに渡らないため記録から埋める。 */
const withCommittedRespond = (calls: readonly EvalToolCall[], committed: boolean) => {
  const last = calls.map((call) => call.name).lastIndexOf('respond');
  return calls.map((call, index) =>
    committed && index === last && call.result === null
      ? {
          ...call,
          result: { status: 'committed', code: null, candidates: null, issues: [] },
        }
      : call,
  );
};

export const evalTurnRecord = (
  userText: string,
  result: ThreadRuntimeTurnResult,
  observation: EvalTurnObservation,
): EvalTurnRecord => {
  const response = responseOf(result);
  const committed = observation.outcome?.committed ?? false;
  return {
    userText,
    runStatus: result.status,
    failureCode: result.code ?? null,
    committed,
    kind: observation.outcome?.kind ?? null,
    messages: response?.message.map((message) => message.text) ?? [],
    cards: cardsOf(response).map((card) => ({
      name: card.facts.identity.status === 'known' ? card.facts.identity.value.name : null,
      why: card.why.text,
      diff: card.diff?.text ?? null,
    })),
    searchOutcome: response?.kind === 'message' ? (response.searchOutcome ?? null) : null,
    toolCalls: withCommittedRespond(observation.toolCalls, committed),
    toolResultsMatched: observation.toolResultsMatched,
    modelCalls: observation.modelCalls,
    respondMissing: observation.respondMissing,
    respondRejections: observation.rejections.map((rejection) => ({
      codes: rejection.issues.map((issue) => issue.code),
      remainingRepairs: rejection.remainingRepairs,
    })),
    evalError: observation.evalError,
  };
};
