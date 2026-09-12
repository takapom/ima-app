import type { PublicCard } from '@ima/contracts';
import { triggerDecisionHaptics, type DecisionHapticsService } from '../services/journey-haptics';
import type { JourneyStorageService } from '../services/journey-storage';
import {
  canCommitJourneyNotice,
  type JourneyOperationToken,
} from '../state/journey-operation-gate';
import type { JourneySaveOperationRegistry } from './journey-save-operation';

type DecisionNotice = {
  readonly tone: 'info' | 'success' | 'error';
  readonly text: string;
};

export type PersistJourneyDecisionInput = {
  readonly candidateId: string;
  readonly contextKey: string;
  readonly mounted: boolean;
  readonly activeContextKey: string;
  readonly card: PublicCard | undefined;
  readonly saveOperations: JourneySaveOperationRegistry;
  readonly storage: JourneyStorageService;
  readonly haptics: DecisionHapticsService;
  readonly generation: number;
  readonly isCurrentOperation: (generation: number) => boolean;
  readonly currentOperationToken: () => JourneyOperationToken;
  readonly applyDecide: (candidateId: string) => boolean;
  readonly rejectMissing: () => void;
  readonly setNotice: (notice: DecisionNotice | null) => void;
  readonly bumpNoticeToken: () => void;
};

const hapticUnavailable: DecisionNotice = {
  tone: 'info',
  text: '決定しました。触覚フィードバックは利用できません。',
};

export const persistJourneyDecision = async (
  input: PersistJourneyDecisionInput,
): Promise<boolean> => {
  if (!input.mounted || input.activeContextKey !== input.contextKey) return false;
  if (input.card === undefined) {
    input.rejectMissing();
    return false;
  }
  const operationKey = `decide:${input.contextKey}:${input.candidateId}`;
  const controller = input.saveOperations.begin(operationKey);
  if (controller === null) return false;
  input.bumpNoticeToken();
  const token = input.currentOperationToken();
  input.setNotice({ tone: 'info', text: '決定を保存しています…' });
  let result: Awaited<ReturnType<JourneyStorageService['decideCandidate']>>;
  try {
    result = await input.storage.decideCandidate(input.card, {
      idempotencyKey: input.saveOperations.keyFor(operationKey),
      signal: controller.signal,
    });
  } finally {
    input.saveOperations.finish(operationKey, controller);
  }
  if (!input.isCurrentOperation(input.generation)) return false;
  if (result.status !== 'decided') {
    if (canCommitJourneyNotice(input.currentOperationToken(), token)) {
      input.setNotice({
        tone: 'error',
        text:
          result.reason === 'stale'
            ? '検索が変わったため決定を保存できませんでした。'
            : '決定を保存できませんでした。もう一度試してください。',
      });
    }
    return false;
  }
  if (!input.applyDecide(input.candidateId)) return false;
  if (canCommitJourneyNotice(input.currentOperationToken(), token)) {
    input.setNotice({ tone: 'success', text: 'この候補に決めました。' });
  }
  void triggerDecisionHaptics(input.haptics)
    .then((haptic) => {
      if (
        !input.isCurrentOperation(input.generation) ||
        !canCommitJourneyNotice(input.currentOperationToken(), token)
      ) {
        return;
      }
      if (haptic.status !== 'performed') input.setNotice(hapticUnavailable);
    })
    .catch(() => {
      if (
        input.isCurrentOperation(input.generation) &&
        canCommitJourneyNotice(input.currentOperationToken(), token)
      ) {
        input.setNotice(hapticUnavailable);
      }
    });
  return true;
};
