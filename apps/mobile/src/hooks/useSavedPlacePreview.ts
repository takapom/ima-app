import { AppState } from 'react-native';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { JourneySavedPlacePreviewBinding } from '../services/api/journey-api-binding';
import { subscribeToAssistantResponseResume } from '../services/assistant-response-clock';
import { createSavedPlacePreviewController } from '../services/saved-places/saved-place-preview-controller';
import {
  savedPlaceConsultationRefFor,
  savedPlaceItemsFor,
} from '../presentation/saved-place-preview-view';
import type { SavedPlaceItem } from '../state/journey-shell';
import type { SavedPlacePreviewState } from '../state/saved-place-preview';

export type SavedPlacePreviewUi = {
  readonly connected: boolean;
  readonly unavailable: boolean;
  readonly consultDisabled: boolean;
  readonly items: readonly SavedPlaceItem[];
  readonly preview: SavedPlacePreviewState;
  readonly pendingRefs: readonly string[];
  readonly consult: (savedPlaceRef: string) => void;
  readonly clearConsultation: () => void;
  readonly select: (savedPlaceRef: string) => boolean;
  readonly selectDrawerItem: (item: SavedPlaceItem) => void;
  readonly reload: () => void;
  readonly retry: () => void;
  readonly close: () => void;
  readonly responseSettled: () => void;
  readonly reset: () => void;
};

export const useSavedPlacePreview = (
  binding: JourneySavedPlacePreviewBinding | undefined,
  onSavedPlaceSelect?: (item: SavedPlaceItem) => void,
  consultDisabled = false,
): SavedPlacePreviewUi => {
  const listService = binding?.listService;
  const refreshService = binding?.refreshService;
  const now = binding?.now;
  const controller = useMemo(
    () =>
      createSavedPlacePreviewController({
        ...(listService === undefined ? {} : { listService }),
        ...(refreshService === undefined ? {} : { refreshService }),
        ...(now === undefined ? {} : { now }),
      }),
    [listService, refreshService, now],
  );
  const preview = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  useEffect(() => {
    controller.load();
    const unsubscribeResume = subscribeToAssistantResponseResume((listener) => {
      const subscription = AppState.addEventListener('change', listener);
      return () => subscription.remove();
    }, controller.recheck);
    return () => {
      unsubscribeResume();
      controller.close();
    };
  }, [controller]);
  const [pendingRefs, setPendingRefs] = useState<readonly string[]>([]);
  const items = useMemo(
    () => (binding === undefined ? [] : savedPlaceItemsFor(preview.list)),
    [binding, preview.list],
  );
  const consult = useCallback(
    (savedPlaceRef: string): void => {
      if (binding === undefined || consultDisabled) {
        return;
      }
      controller.recheck();
      if (savedPlaceConsultationRefFor(controller.getState(), savedPlaceRef) === null) return;
      setPendingRefs([savedPlaceRef]);
      controller.close();
    },
    [binding, consultDisabled, controller],
  );
  const clearConsultation = useCallback((): void => {
    setPendingRefs([]);
  }, []);
  const select = useCallback(
    (savedPlaceRef: string): boolean =>
      binding === undefined ? false : controller.select(savedPlaceRef),
    [binding, controller],
  );
  const selectDrawerItem = useCallback(
    (item: SavedPlaceItem): void => {
      const accepted = binding === undefined || select(item.id);
      if (accepted) onSavedPlaceSelect?.(item);
    },
    [binding, onSavedPlaceSelect, select],
  );
  const retry = useCallback((): void => {
    const savedPlaceRef = controller.getState().selected?.serverSavedPlaceRef;
    if (savedPlaceRef !== undefined) controller.select(savedPlaceRef);
  }, [controller]);
  const reload = useCallback((): void => {
    controller.reload();
  }, [controller]);
  const close = useCallback((): void => {
    controller.close();
  }, [controller]);
  const responseSettled = useCallback((): void => {
    setPendingRefs([]);
  }, []);
  const reset = useCallback((): void => {
    setPendingRefs([]);
    controller.close();
  }, [controller]);
  return {
    connected: binding !== undefined,
    unavailable: binding !== undefined && preview.list.status === 'unavailable',
    consultDisabled,
    items,
    preview,
    pendingRefs,
    consult,
    clearConsultation,
    select,
    selectDrawerItem,
    reload,
    retry,
    close,
    responseSettled,
    reset,
  };
};
