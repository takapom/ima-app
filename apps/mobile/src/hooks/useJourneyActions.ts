import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PublicCard } from '@ima/contracts';
import {
  createNativeJourneyMapService,
  createNativeJourneyShareService,
} from '../services/journey-native';
import {
  createUnavailableDecisionHapticsService,
  triggerDecisionHaptics,
  type DecisionHapticsResult,
  type DecisionHapticsService,
} from '../services/journey-haptics';
import type { JourneyMapOpenResult, JourneyMapService } from '../services/journey-map';
import {
  createUnavailableJourneyStorageService,
  saveJourneyCandidate,
  type JourneyStorageService,
} from '../services/journey-storage';
import {
  prepareJourneyShare,
  shareJourneyCandidate,
  type JourneyShareService,
} from '../services/journey-share';
import { journeyShareInputFor } from '../services/journey-share-input';
import {
  createJourneyActionState,
  journeyActionReducer,
  reconcileJourneyActionContext,
  resetJourneyActionContext,
  selectJourneyCandidateOrder,
  type JourneyAction,
  type JourneyActionContext,
  type JourneyActionState,
  type RecoverIntent,
} from '../state/journey-actions';
import type { AssistantResponseState } from '../state/assistant-response';
import {
  canCommitJourneyNotice,
  canCommitJourneyOperation,
  type JourneyOperationToken,
} from '../state/journey-operation-gate';
export type JourneyActionServices = {
  readonly map: JourneyMapService;
  readonly share: JourneyShareService;
  readonly storage: JourneyStorageService;
  readonly haptics: DecisionHapticsService;
};
export type JourneyActionNotice = {
  readonly tone: 'info' | 'success' | 'error';
  readonly text: string;
};
export type UseJourneyActionsOptions = {
  readonly threadId: string;
  readonly responseState: AssistantResponseState;
  readonly query: string;
  readonly actionServices?: JourneyActionServices;
  readonly mapDestinationResolver?: Parameters<typeof createNativeJourneyMapService>[0];
  readonly onPromote?: (candidateId: string) => void;
  readonly onRecover?: (intent: RecoverIntent) => void;
};
export type JourneyActionsController = {
  readonly state: JourneyActionState;
  readonly candidateOrder: readonly string[];
  readonly notice: JourneyActionNotice | null;
  readonly promote: (candidateId: string) => void;
  readonly decide: (candidateId: string) => boolean;
  readonly save: (card: PublicCard) => Promise<void>;
  readonly skipTonight: (candidateId: string) => void;
  readonly recover: (candidateId: string) => RecoverIntent | null;
  readonly openMap: (card: PublicCard) => Promise<void>;
  readonly share: (card: PublicCard) => Promise<void>;
  readonly reportFailure: () => void;
  readonly clearNotice: () => void;
  readonly reset: () => void;
};
const contextKeyFor = (threadId: string, state: AssistantResponseState): string => {
  const display = state.cardSetDisplay;
  const source = display.kind === 'kept' ? display.sourceResponseId : display.responseId;
  return [threadId, state.cardSetId ?? '', source ?? ''].join(':');
};
const rejectionText = (reason: string): string => {
  if (reason === 'candidate_not_found') return 'この候補は現在の検索結果にありません。';
  if (reason === 'already_excluded') return '今夜は候補から外しています。';
  if (reason === 'candidate_not_decided') return '決定した候補を確認してください。';
  return '検索語を確認してもう一度試してください。';
};
const hapticsText = (result: DecisionHapticsResult): JourneyActionNotice | null =>
  result.status === 'performed'
    ? null
    : { tone: 'info', text: '決定しました。触覚フィードバックは利用できません。' };
export const createDefaultJourneyActionServices = (
  resolveDestination: Parameters<typeof createNativeJourneyMapService>[0] = () => null,
): JourneyActionServices => ({
  map: createNativeJourneyMapService(resolveDestination),
  share: createNativeJourneyShareService(),
  storage: createUnavailableJourneyStorageService(),
  haptics: createUnavailableDecisionHapticsService(),
});
export const useJourneyActions = ({
  threadId,
  responseState,
  query,
  actionServices,
  mapDestinationResolver,
  onPromote,
  onRecover,
}: UseJourneyActionsOptions): JourneyActionsController => {
  const contextKey = contextKeyFor(threadId, responseState);
  const contextRef = useRef(contextKey);
  const [actionState, setActionState] = useState(createJourneyActionState);
  const [stateContextKey, setStateContextKey] = useState(contextKey);
  const [notice, setNotice] = useState<JourneyActionNotice | null>(null);
  const inFlight = useRef(new Set<string>());
  const operationGeneration = useRef(0);
  const noticeToken = useRef(0);
  const actionStateRef = useRef(actionState);
  const initialized = useRef(false);
  const mounted = useRef(false);
  const fallbackServices = useMemo(
    () => createDefaultJourneyActionServices(mapDestinationResolver),
    [mapDestinationResolver],
  );
  const services = actionServices ?? fallbackServices;
  const responseCards = responseState.cards;
  const candidateIdKey =
    responseCards === null
      ? null
      : [
          responseCards.hero.candidateId,
          ...responseCards.alts.map((card) => card.candidateId),
        ].join('\u001f');
  const candidateIds = useMemo(
    () => (candidateIdKey === null ? [] : candidateIdKey.split('\u001f')),
    [candidateIdKey],
  );
  const actionContext = useMemo<JourneyActionContext>(
    () => ({ candidateIds, query }),
    [candidateIds, query],
  );
  const effectiveState =
    stateContextKey === contextKey
      ? actionState
      : reconcileJourneyActionContext(actionState, candidateIds);
  useLayoutEffect(() => {
    contextRef.current = contextKey;
    actionStateRef.current = effectiveState;
  }, [contextKey, effectiveState]);
  const isCurrentOperation = useCallback(
    (generation: number): boolean =>
      mounted.current &&
      contextRef.current === contextKey &&
      canCommitJourneyOperation(
        { generation: operationGeneration.current, noticeToken: noticeToken.current },
        { generation, noticeToken: noticeToken.current },
      ),
    [contextKey],
  );
  const currentOperationToken = useCallback(
    (): JourneyOperationToken => ({
      generation: operationGeneration.current,
      noticeToken: noticeToken.current,
    }),
    [],
  );
  useEffect(() => {
    mounted.current = true;
    const activeOperations = inFlight.current;
    return () => {
      mounted.current = false;
      operationGeneration.current += 1;
      noticeToken.current += 1;
      activeOperations.clear();
    };
  }, []);
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      return;
    }
    operationGeneration.current += 1;
    noticeToken.current += 1;
    setStateContextKey(contextKey);
    setActionState((current) => {
      const next = reconcileJourneyActionContext(current, candidateIds);
      actionStateRef.current = next;
      return next;
    });
    setNotice(null);
    inFlight.current.clear();
  }, [candidateIds, contextKey]);
  const reject = useCallback((reason: string): void => {
    setNotice({ tone: 'error', text: rejectionText(reason) });
  }, []);
  const applyPure = useCallback(
    (action: JourneyAction) => {
      if (!mounted.current || contextRef.current !== contextKey) return null;
      const result = journeyActionReducer(actionStateRef.current, action, actionContext);
      if (!result.accepted) {
        noticeToken.current += 1;
        reject(result.reason);
        return null;
      }
      noticeToken.current += 1;
      actionStateRef.current = result.state;
      setActionState(result.state);
      return result;
    },
    [actionContext, contextKey, reject],
  );
  const promote = useCallback(
    (candidateId: string): void => {
      if (applyPure({ type: 'promote', candidateId }) === null) return;
      onPromote?.(candidateId);
      setNotice({ tone: 'success', text: '主提案を入れ替えました。' });
    },
    [applyPure, onPromote],
  );
  const decide = useCallback(
    (candidateId: string): boolean => {
      if (applyPure({ type: 'decide', candidateId }) === null) return false;
      setNotice({ tone: 'success', text: 'この候補に決めました。' });
      const generation = operationGeneration.current;
      const token = currentOperationToken();
      void triggerDecisionHaptics(services.haptics)
        .then((result) => {
          if (
            !isCurrentOperation(generation) ||
            !canCommitJourneyNotice(currentOperationToken(), token)
          ) {
            return;
          }
          const hapticNotice = hapticsText(result);
          if (hapticNotice !== null) setNotice(hapticNotice);
        })
        .catch(() => {
          if (
            isCurrentOperation(generation) &&
            canCommitJourneyNotice(currentOperationToken(), token)
          ) {
            setNotice({ tone: 'info', text: '決定しました。触覚フィードバックは利用できません。' });
          }
        });
      return true;
    },
    [applyPure, currentOperationToken, isCurrentOperation, services.haptics],
  );
  const skipTonight = useCallback(
    (candidateId: string): void => {
      if (applyPure({ type: 'skipTonight', candidateId }) === null) return;
      setNotice({ tone: 'info', text: '今夜の候補から外しました。' });
    },
    [applyPure],
  );
  const recover = useCallback(
    (candidateId: string): RecoverIntent | null => {
      const result = applyPure({ type: 'recover', candidateId });
      if (result === null || result.effect.type !== 'recover') return null;
      onRecover?.(result.effect.intent);
      setNotice({ tone: 'info', text: '同じ検索語で別の候補を探します。' });
      return result.effect.intent;
    },
    [applyPure, onRecover],
  );

  const save = useCallback(
    async (card: PublicCard): Promise<void> => {
      const operationKey = `save:${contextKey}:${card.candidateId}`;
      if (
        !mounted.current ||
        contextRef.current !== contextKey ||
        inFlight.current.has(operationKey)
      ) {
        return;
      }
      if (actionStateRef.current.savedCandidateIds.includes(card.candidateId)) {
        noticeToken.current += 1;
        setNotice({ tone: 'info', text: 'この候補は保存済みです。' });
        return;
      }
      inFlight.current.add(operationKey);
      const generation = operationGeneration.current;
      noticeToken.current += 1;
      const token = currentOperationToken();
      setNotice({ tone: 'info', text: '保存しています…' });
      const result = await saveJourneyCandidate(services.storage, card);
      inFlight.current.delete(operationKey);
      if (!isCurrentOperation(generation)) return;
      if (result.status === 'saved' || result.status === 'already_saved') {
        setActionState((current) => {
          const next = journeyActionReducer(
            current,
            { type: 'save', candidateId: card.candidateId },
            actionContext,
          );
          const resolved = next.accepted ? next.state : current;
          actionStateRef.current = resolved;
          return resolved;
        });
        if (canCommitJourneyNotice(currentOperationToken(), token)) {
          setNotice({
            tone: 'success',
            text: result.status === 'saved' ? '候補を保存しました。' : 'この候補は保存済みです。',
          });
        }
      } else {
        if (canCommitJourneyNotice(currentOperationToken(), token)) {
          setNotice({ tone: 'error', text: '保存できませんでした。保存内容は変更していません。' });
        }
      }
    },
    [actionContext, contextKey, currentOperationToken, isCurrentOperation, services.storage],
  );

  const openMap = useCallback(
    async (card: PublicCard): Promise<void> => {
      const operationKey = `map:${contextKey}:${card.candidateId}`;
      if (
        !mounted.current ||
        contextRef.current !== contextKey ||
        inFlight.current.has(operationKey)
      ) {
        return;
      }
      inFlight.current.add(operationKey);
      const generation = operationGeneration.current;
      noticeToken.current += 1;
      const token = currentOperationToken();
      setNotice({ tone: 'info', text: '地図を開いています…' });
      let result: JourneyMapOpenResult;
      try {
        result = await services.map.openWalkingMap(card);
      } catch {
        result = { status: 'failed', reason: 'native_unavailable' };
      }
      inFlight.current.delete(operationKey);
      if (
        !isCurrentOperation(generation) ||
        !canCommitJourneyNotice(currentOperationToken(), token)
      ) {
        return;
      }
      if (result.status === 'opened') {
        setNotice({ tone: 'success', text: '地図を開きました。' });
      } else if (result.status === 'unavailable') {
        setNotice({ tone: 'error', text: '徒歩地図を開ける情報がありません。' });
      } else {
        setNotice({ tone: 'error', text: '地図を開けませんでした。' });
      }
    },
    [contextKey, currentOperationToken, isCurrentOperation, services.map],
  );

  const share = useCallback(
    async (card: PublicCard): Promise<void> => {
      const operationKey = `share:${contextKey}:${card.candidateId}`;
      if (
        !mounted.current ||
        contextRef.current !== contextKey ||
        inFlight.current.has(operationKey)
      ) {
        return;
      }
      inFlight.current.add(operationKey);
      const generation = operationGeneration.current;
      noticeToken.current += 1;
      const token = currentOperationToken();
      let shareInput: ReturnType<typeof journeyShareInputFor>;
      try {
        shareInput = journeyShareInputFor(card);
      } catch {
        inFlight.current.delete(operationKey);
        if (isCurrentOperation(generation)) {
          noticeToken.current += 1;
          setNotice({ tone: 'error', text: '共有に必要な情報を読み取れませんでした。' });
        }
        return;
      }
      const prepared = prepareJourneyShare(shareInput);
      if (prepared.status !== 'ready') {
        inFlight.current.delete(operationKey);
        setNotice({ tone: 'error', text: '共有に必要な地図リンクがありません。' });
        return;
      }
      setNotice({ tone: 'info', text: '共有シートを開いています…' });
      const result = await shareJourneyCandidate(services.share, shareInput);
      inFlight.current.delete(operationKey);
      if (
        !isCurrentOperation(generation) ||
        !canCommitJourneyNotice(currentOperationToken(), token)
      ) {
        return;
      }
      if (result.status === 'opened') {
        setNotice({
          tone: 'success',
          text: '共有シートを開きました。配送完了は確認していません。',
        });
      } else if (result.status === 'cancelled') {
        setNotice({ tone: 'info', text: '共有をキャンセルしました。' });
      } else {
        setNotice({ tone: 'error', text: '共有シートを開けませんでした。' });
      }
    },
    [contextKey, currentOperationToken, isCurrentOperation, services.share],
  );

  const candidateOrder = selectJourneyCandidateOrder(
    actionContext.candidateIds,
    effectiveState.promotedCandidateId,
    effectiveState.tonightExcludedCandidateIds,
  );
  const clearNotice = useCallback(() => {
    noticeToken.current += 1;
    setNotice(null);
  }, []);
  const reportFailure = useCallback(() => {
    if (!mounted.current || contextRef.current !== contextKey) return;
    noticeToken.current += 1;
    setNotice({ tone: 'error', text: '操作を完了できませんでした。もう一度試してください。' });
  }, [contextKey]);
  const reset = useCallback(() => {
    operationGeneration.current += 1;
    noticeToken.current += 1;
    setStateContextKey(contextKey);
    const next = resetJourneyActionContext();
    actionStateRef.current = next;
    setActionState(next);
    setNotice(null);
    inFlight.current.clear();
  }, [contextKey]);

  return {
    state: effectiveState,
    candidateOrder,
    notice,
    promote,
    decide,
    save,
    skipTonight,
    recover,
    openMap,
    share,
    reportFailure,
    clearNotice,
    reset,
  };
};
