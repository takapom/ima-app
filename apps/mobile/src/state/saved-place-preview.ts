import type { PublicPlaceDetailsData } from '@ima/contracts';
import type { ApiError } from '../services/api/api';
import type { SavedPlaceListItem, SavedPlaceListResult } from '../services/saved-place-list';
import type { ServerSavedPlaceRef } from '../services/saved-place-types';

export type SavedPlacePreviewPayload = {
  readonly savedPlaceRef: ServerSavedPlaceRef;
  readonly candidateId: string;
  readonly evidenceIds: readonly string[];
  readonly data: PublicPlaceDetailsData;
};

export type SavedPlacePreviewFailureReason =
  | 'aborted'
  | 'api'
  | 'invalid_input'
  | 'retention_denied'
  | 'stale'
  | 'storage_unavailable'
  | 'clock_unavailable';

export type SavedPlacePreviewFailure = {
  readonly reason: SavedPlacePreviewFailureReason;
  readonly error?: ApiError;
};

export type SavedPlacePreviewState = {
  readonly list: SavedPlaceListResult;
  readonly status: 'closed' | 'loading' | 'ready' | 'failed';
  readonly selected: SavedPlaceListItem | null;
  readonly payload: SavedPlacePreviewPayload | null;
  readonly failure: SavedPlacePreviewFailure | null;
  /** Internal generation used to reject a response from a prior selection. */
  readonly operation: number;
};

export type SavedPlacePreviewAction =
  | { readonly type: 'listLoaded'; readonly result: SavedPlaceListResult }
  | {
      readonly type: 'selectionStarted';
      readonly item: SavedPlaceListItem;
      readonly operation: number;
    }
  | {
      readonly type: 'refreshSucceeded';
      readonly payload: SavedPlacePreviewPayload;
      readonly operation: number;
    }
  | {
      readonly type: 'refreshFailed';
      readonly savedPlaceRef: ServerSavedPlaceRef;
      readonly failure: SavedPlacePreviewFailure;
      readonly operation: number;
    }
  | { readonly type: 'closed'; readonly operation: number };

export const createSavedPlacePreviewState = (): SavedPlacePreviewState => ({
  list: { status: 'unavailable', reason: 'storage_unavailable' },
  status: 'closed',
  selected: null,
  payload: null,
  failure: null,
  operation: 0,
});

const closedState = (
  state: SavedPlacePreviewState,
  operation = state.operation,
): SavedPlacePreviewState => ({
  ...state,
  status: 'closed',
  selected: null,
  payload: null,
  failure: null,
  operation,
});

export const savedPlacePreviewReducer = (
  state: SavedPlacePreviewState,
  action: SavedPlacePreviewAction,
): SavedPlacePreviewState => {
  switch (action.type) {
    case 'listLoaded': {
      if (action.result.status !== 'available' || state.selected === null) {
        return { ...closedState(state), list: action.result };
      }
      const selected = action.result.items.find(
        (item) => item.serverSavedPlaceRef === state.selected?.serverSavedPlaceRef,
      );
      return selected === undefined
        ? { ...closedState(state), list: action.result }
        : { ...state, list: action.result, selected };
    }
    case 'selectionStarted':
      return {
        ...state,
        status: 'loading',
        selected: action.item,
        payload: null,
        failure: null,
        operation: action.operation,
      };
    case 'refreshSucceeded':
      if (
        state.status !== 'loading' ||
        state.operation !== action.operation ||
        state.selected?.serverSavedPlaceRef !== action.payload.savedPlaceRef
      ) {
        return state;
      }
      return { ...state, status: 'ready', payload: action.payload, failure: null };
    case 'refreshFailed':
      if (
        state.status !== 'loading' ||
        state.operation !== action.operation ||
        state.selected?.serverSavedPlaceRef !== action.savedPlaceRef
      ) {
        return state;
      }
      return { ...state, status: 'failed', payload: null, failure: action.failure };
    case 'closed':
      return closedState(state, action.operation);
  }
};
