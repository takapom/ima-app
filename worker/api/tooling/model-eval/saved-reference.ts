const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Copies only expected semantic aliases from a host trace extension. */
export const savedRefsFor = (
  value: unknown,
  allowedReferences: readonly string[],
): readonly string[] => {
  if (!record(value) || !Array.isArray(value.resolvedSavedPlaceRefs)) return [];
  const allowed = new Set(allowedReferences);
  const seen = new Set<string>();
  return value.resolvedSavedPlaceRefs.filter((reference): reference is string => {
    if (
      typeof reference !== 'string' ||
      reference.length === 0 ||
      !allowed.has(reference) ||
      seen.has(reference)
    ) {
      return false;
    }
    seen.add(reference);
    return true;
  });
};
