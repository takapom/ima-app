export type RuntimeProductionCardSetSnapshot = {
  readonly cardSetId: string;
  readonly selectedCandidateId: string | null;
  readonly excludedCandidateIds: readonly string[];
  readonly candidateOrder: readonly string[];
};

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** Extracts only the public card-set metadata from the serialized model envelope. */
export const modelCardSetSnapshotsIn = (prompt: string): RuntimeProductionCardSetSnapshot[] => {
  const snapshots: RuntimeProductionCardSetSnapshot[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'string') {
      if (!value.startsWith('{') && !value.startsWith('[')) return;
      try {
        visit(JSON.parse(value));
      } catch {
        // User/model text is not necessarily JSON.
      }
      return;
    }
    if (!isRecord(value)) return;
    const context =
      value.kind === 'ima_turn_context' && isRecord(value.context) ? value.context : null;
    const cardSet = context !== null && isRecord(context.cardSet) ? context.cardSet : null;
    if (cardSet !== null && typeof cardSet.cardSetId === 'string') {
      const entries = Array.isArray(cardSet.entries) ? cardSet.entries : [];
      snapshots.push({
        cardSetId: cardSet.cardSetId,
        selectedCandidateId:
          typeof cardSet.selectedCandidateId === 'string' ? cardSet.selectedCandidateId : null,
        excludedCandidateIds: stringArray(cardSet.excludedCandidateIds),
        candidateOrder: entries.flatMap((entry) =>
          isRecord(entry) && typeof entry.candidateId === 'string' ? [entry.candidateId] : [],
        ),
      });
    }
    Object.values(value).forEach(visit);
  };
  try {
    visit(JSON.parse(prompt));
  } catch {
    return [];
  }
  return snapshots;
};
