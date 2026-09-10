import { useCallback, useMemo, useState } from 'react';
import type { JourneySavedPlacePreviewBinding } from '../services/api/journey-api-binding';
import {
  savedPlaceConsultationRefFor,
  savedPlaceItemsFor,
} from '../services/saved-place-preview-view';
import type { SavedPlaceItem } from '../state/journey-shell';
import { useSavedPlacePreview } from './useSavedPlacePreview';

export type JourneySavedPlacePreviewController = {
  readonly connected: boolean;
  readonly unavailable: boolean;
  readonly consultDisabled: boolean;
  readonly items: readonly SavedPlaceItem[];
  readonly preview: ReturnType<typeof useSavedPlacePreview>;
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

export const useJourneySavedPlacePreview = (
  binding: JourneySavedPlacePreviewBinding | undefined,
  onSavedPlaceSelect?: (item: SavedPlaceItem) => void,
  consultDisabled = false,
): JourneySavedPlacePreviewController => {
  const preview = useSavedPlacePreview(
    binding === undefined
      ? {}
      : {
          listService: binding.listService,
          refreshService: binding.refreshService,
          ...(binding.now === undefined ? {} : { now: binding.now }),
        },
  );
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
      preview.recheck();
      if (savedPlaceConsultationRefFor(preview.getState(), savedPlaceRef) === null) return;
      setPendingRefs([savedPlaceRef]);
      preview.close();
    },
    [binding, consultDisabled, preview],
  );
  const clearConsultation = useCallback((): void => {
    setPendingRefs([]);
  }, []);
  const select = useCallback(
    (savedPlaceRef: string): boolean =>
      binding === undefined ? false : preview.select(savedPlaceRef),
    [binding, preview],
  );
  const selectDrawerItem = useCallback(
    (item: SavedPlaceItem): void => {
      const accepted = binding === undefined || select(item.id);
      if (accepted) onSavedPlaceSelect?.(item);
    },
    [binding, onSavedPlaceSelect, select],
  );
  const retry = useCallback((): void => {
    const savedPlaceRef = preview.selected?.serverSavedPlaceRef;
    if (savedPlaceRef !== undefined) preview.select(savedPlaceRef);
  }, [preview]);
  const responseSettled = useCallback((): void => {
    setPendingRefs([]);
  }, []);
  const reset = useCallback((): void => {
    setPendingRefs([]);
    preview.close();
  }, [preview]);
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
    reload: preview.reload,
    retry,
    close: preview.close,
    responseSettled,
    reset,
  };
};
