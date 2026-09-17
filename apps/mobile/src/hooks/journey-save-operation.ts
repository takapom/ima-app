import { createRuntimeId } from '@mobile/services/runtime-id';

export type JourneySaveOperationRegistry = {
  readonly keyFor: (operationKey: string) => string;
  readonly begin: (operationKey: string) => AbortController | null;
  readonly finish: (operationKey: string, controller: AbortController) => void;
  readonly abortAll: () => void;
  readonly clearKeys: () => void;
};

/** Owns save retries and controllers for one mounted action hook. */
export const createJourneySaveOperationRegistry = (): JourneySaveOperationRegistry => {
  const keys = new Map<string, string>();
  const pending = new Map<string, AbortController>();

  return {
    keyFor: (operationKey) => {
      const existing = keys.get(operationKey);
      if (existing !== undefined) return existing;
      const key = createRuntimeId('save');
      keys.set(operationKey, key);
      return key;
    },
    begin: (operationKey) => {
      if (pending.has(operationKey)) return null;
      const controller = new AbortController();
      pending.set(operationKey, controller);
      return controller;
    },
    finish: (operationKey, controller) => {
      if (pending.get(operationKey) === controller) pending.delete(operationKey);
    },
    abortAll: () => {
      for (const controller of pending.values()) controller.abort();
      pending.clear();
    },
    clearKeys: () => keys.clear(),
  };
};
