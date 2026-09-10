let fallbackSequence = 0;

/** Create an opaque application ID without adding a native dependency. */
export const createRuntimeId = (prefix: string): string => {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid === undefined
    ? `${prefix}-${Date.now().toString(36)}-${++fallbackSequence}`
    : `${prefix}-${uuid}`;
};
