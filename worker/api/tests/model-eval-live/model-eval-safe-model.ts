import type {
  RuntimeGateModelCallOptions,
  RuntimeGateModelStreamPart,
} from '../support/runtime-model-fixture';
import { finalParts, toolParts } from './model-eval-context-output';
import { modelSearchResultIn } from './model-eval-context-values';

const currentLocationSearchInput = {
  mode: 'search' as const,
  query: '近くの店',
  area: { kind: 'current_location' as const, radiusMeters: 1000 },
  openNow: false,
  limit: 3,
  excludeCandidateIds: [],
};

type SafeModelInput = {
  readonly phase: 'cards' | 'message';
  readonly profile: string;
  readonly currentCall: number;
  readonly prompt: RuntimeGateModelCallOptions['prompt'];
  readonly locationProbe: 'clarify' | 'current-location';
  readonly step: (name: 'search_places' | 'final_message') => void;
};

/** Returns the fixture-only refusal/failure response branches kept out of the main model. */
export const safeModelPartsFor = (
  input: SafeModelInput,
): readonly RuntimeGateModelStreamPart[] | undefined => {
  if (input.phase === 'cards' && input.profile === 'candidate-failure' && input.currentCall > 0) {
    input.step('final_message');
    const searchResult = modelSearchResultIn(input.prompt);
    const text =
      searchResult.kind === 'error' && searchResult.code === 'UPSTREAM_UNAVAILABLE'
        ? '候補を取得できませんでした。'
        : searchResult.kind === 'success' && searchResult.candidateCount === 0
          ? '条件に合う候補は見つかりませんでした。'
          : '候補を確認できませんでした。';
    return finalParts(text, [], 'conversational');
  }
  if (input.phase !== 'message' || input.profile !== 'gps-refusal') return undefined;
  if (input.locationProbe === 'current-location' && input.currentCall === 0) {
    input.step('search_places');
    return toolParts(input.currentCall, 'search_places', currentLocationSearchInput);
  }
  input.step('final_message');
  return finalParts('位置情報を使わずに探すには地域を教えてください。', [], 'conversational');
};
