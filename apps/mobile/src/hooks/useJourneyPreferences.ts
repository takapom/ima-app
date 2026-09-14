import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  hasPersistedJourneyPreferenceChange,
  type JourneyPreferencesReadResult,
  type JourneyPreferencesSaveResult,
  type JourneyPreferencesService,
} from '../services/preferences';
import {
  createDefaultJourneyConditions,
  type ConditionScope,
  type JourneyConditions,
} from '../state/journey-input';

export type UseJourneyPreferencesOptions = {
  /** Host-composed SQLite-backed settings service. */
  readonly service?: JourneyPreferencesService | undefined;
  /** In-memory fallback; its station label is never written to SQLite. */
  readonly initialSavedConditions?: JourneyConditions | undefined;
};

export type JourneyPreferencesChangeResult = {
  readonly applied: boolean;
  readonly saveResult: JourneyPreferencesSaveResult | null;
  readonly notice: string | null;
};

export type JourneyPreferencesTransition = {
  readonly result: JourneyPreferencesChangeResult;
  readonly savedConditions: JourneyConditions;
};

export type UseJourneyPreferencesResult = {
  /** Restored saved conditions, or the supplied fallback when storage is unavailable. */
  readonly savedConditions: JourneyConditions;
  readonly readResult: JourneyPreferencesReadResult;
  /** The last attempted write, including a failure when persistence did not succeed. */
  readonly saveResult: JourneyPreferencesSaveResult | null;
  /** Persists only through the injected settings service; callers choose saved scope. */
  readonly saveSavedConditions: (
    conditions: JourneyConditions,
  ) => Promise<JourneyPreferencesSaveResult>;
  /** Validates and persists a saved-scope edit before the caller updates its shell state. */
  readonly applyConditionChange: (
    scope: ConditionScope,
    currentSavedConditions: JourneyConditions,
    changes: Partial<JourneyConditions>,
  ) => Promise<JourneyPreferencesChangeResult>;
  readonly conditionNotice: string | null;
  /** Changes when the host-owned service or fallback changes, for shell remounting. */
  readonly sourceKey: string;
};

const unavailableRead = (conditions: JourneyConditions): JourneyPreferencesReadResult => ({
  status: 'unavailable',
  reason: 'storage_unavailable',
  conditions,
});

const readSafely = (
  service: JourneyPreferencesService | undefined,
  fallback: JourneyConditions,
): JourneyPreferencesReadResult => {
  if (service === undefined) return unavailableRead(fallback);
  try {
    return service.read(fallback);
  } catch {
    return unavailableRead(fallback);
  }
};

const saveFailure = (): JourneyPreferencesSaveResult => ({
  status: 'failed',
  reason: 'storage_unavailable',
});

/**
 * Dormant while no editor writes a station label. It stays because the branch must
 * return with the station resolver rather than be rediscovered, and it is still
 * reachable through this module's own contract.
 */
const stationNotice = '駅名は端末に保存されません。';
const sessionOnlyNotice = '条件は端末に保存されません。';
const saveFailureNotice = '条件を保存できませんでした。もう一度試してください。';

export const journeyPreferenceChangeFor = (
  scope: ConditionScope,
  currentSavedConditions: JourneyConditions,
  changes: Partial<JourneyConditions>,
  save: ((conditions: JourneyConditions) => JourneyPreferencesSaveResult) | undefined,
): JourneyPreferencesChangeResult => {
  if (scope !== 'saved') return { applied: true, saveResult: null, notice: null };
  const stationChanged = Object.prototype.hasOwnProperty.call(changes, 'stationLabel');
  const persists = hasPersistedJourneyPreferenceChange(changes);
  if (persists && save !== undefined) {
    const result = save({ ...currentSavedConditions, ...changes });
    return result.status === 'failed'
      ? { applied: false, saveResult: result, notice: saveFailureNotice }
      : { applied: true, saveResult: result, notice: null };
  }
  return {
    applied: true,
    saveResult: null,
    notice: stationChanged ? stationNotice : persists ? sessionOnlyNotice : null,
  };
};

export const journeyPreferenceTransitionFor = (
  scope: ConditionScope,
  currentSavedConditions: JourneyConditions,
  changes: Partial<JourneyConditions>,
  save: ((conditions: JourneyConditions) => JourneyPreferencesSaveResult) | undefined,
): JourneyPreferencesTransition => {
  const result = journeyPreferenceChangeFor(scope, currentSavedConditions, changes, save);
  return {
    result,
    savedConditions:
      scope === 'saved' && result.applied
        ? { ...currentSavedConditions, ...changes }
        : currentSavedConditions,
  };
};

type HookState = {
  readonly source: JourneyPreferencesReadResult;
  readonly savedConditions: JourneyConditions;
  readonly saveResult: JourneyPreferencesSaveResult | null;
};

export const useJourneyPreferences = (
  options: UseJourneyPreferencesOptions = {},
): UseJourneyPreferencesResult => {
  const initialStationLabel = options.initialSavedConditions?.stationLabel;
  const initialStationSupport = options.initialSavedConditions?.stationSupport;
  const initialMaxWalkMinutes = options.initialSavedConditions?.maxWalkMinutes;
  const initialBudget = options.initialSavedConditions?.budget;
  const fallback = useMemo<JourneyConditions>(
    () =>
      initialStationLabel === undefined
        ? createDefaultJourneyConditions()
        : {
            stationLabel: initialStationLabel,
            stationSupport: initialStationSupport ?? 'unknown',
            maxWalkMinutes: initialMaxWalkMinutes ?? null,
            budget: initialBudget ?? 'any',
          },
    [initialBudget, initialMaxWalkMinutes, initialStationLabel, initialStationSupport],
  );
  const [hydrateGeneration, setHydrateGeneration] = useState(0);
  const readResult = useMemo(() => {
    const result = readSafely(options.service, fallback);
    return hydrateGeneration >= 0 ? result : result;
  }, [fallback, hydrateGeneration, options.service]);
  const sourceRef = useRef<{
    readonly service: JourneyPreferencesService | undefined;
    readonly fallback: JourneyConditions;
  } | null>(null);
  const sourceVersion = useRef(0);
  if (
    sourceRef.current === null ||
    sourceRef.current.service !== options.service ||
    sourceRef.current.fallback !== fallback
  ) {
    sourceRef.current = { service: options.service, fallback };
    sourceVersion.current += 1;
  }
  const [state, setState] = useState<HookState>(() => ({
    source: readResult,
    savedConditions: readResult.conditions,
    saveResult: null,
  }));
  const [conditionNotice, setConditionNotice] = useState<string | null>(null);

  useEffect(() => {
    setState({ source: readResult, savedConditions: readResult.conditions, saveResult: null });
    setConditionNotice(null);
  }, [readResult]);

  useEffect(() => {
    const hydrate = options.service?.hydrate;
    if (hydrate === undefined) return;
    let cancelled = false;
    void hydrate()
      .then(() => {
        if (!cancelled) setHydrateGeneration((current) => current + 1);
      })
      .catch(() => {
        if (!cancelled) setHydrateGeneration((current) => current + 1);
      });
    return () => {
      cancelled = true;
    };
  }, [options.service]);

  const saveSavedConditions = useCallback(
    async (conditions: JourneyConditions): Promise<JourneyPreferencesSaveResult> => {
      let result: JourneyPreferencesSaveResult;
      try {
        result = await Promise.resolve(options.service?.save(conditions) ?? saveFailure());
      } catch {
        result = saveFailure();
      }
      if (result.status === 'saved' || result.status === 'unchanged') {
        setState({ source: readResult, savedConditions: conditions, saveResult: result });
      } else {
        setState((current) => ({
          source: readResult,
          savedConditions:
            current.source === readResult ? current.savedConditions : readResult.conditions,
          saveResult: result,
        }));
      }
      return result;
    },
    [options.service, readResult],
  );

  const applyConditionChange = useCallback(
    async (
      scope: ConditionScope,
      currentSavedConditions: JourneyConditions,
      changes: Partial<JourneyConditions>,
    ): Promise<JourneyPreferencesChangeResult> => {
      const shouldPersist =
        scope === 'saved' &&
        options.service !== undefined &&
        hasPersistedJourneyPreferenceChange(changes);
      if (!shouldPersist) {
        const transition = journeyPreferenceTransitionFor(
          scope,
          currentSavedConditions,
          changes,
          undefined,
        );
        if (scope === 'saved' && transition.result.applied) {
          setState({
            source: readResult,
            savedConditions: transition.savedConditions,
            saveResult: transition.result.saveResult,
          });
        }
        setConditionNotice(transition.result.notice);
        return transition.result;
      }
      const result = await saveSavedConditions({ ...currentSavedConditions, ...changes });
      const change: JourneyPreferencesChangeResult =
        result.status === 'failed'
          ? { applied: false, saveResult: result, notice: saveFailureNotice }
          : { applied: true, saveResult: result, notice: null };
      if (change.applied) {
        setState({
          source: readResult,
          savedConditions: { ...currentSavedConditions, ...changes },
          saveResult: change.saveResult,
        });
      }
      setConditionNotice(change.notice);
      return change;
    },
    [options.service, readResult, saveSavedConditions],
  );

  const sourceChanged = state.source !== readResult;
  return {
    savedConditions: sourceChanged ? readResult.conditions : state.savedConditions,
    readResult,
    saveResult: sourceChanged ? null : state.saveResult,
    saveSavedConditions,
    applyConditionChange,
    conditionNotice: sourceChanged ? null : conditionNotice,
    sourceKey: `preferences-${sourceVersion.current}-${hydrateGeneration}`,
  };
};
