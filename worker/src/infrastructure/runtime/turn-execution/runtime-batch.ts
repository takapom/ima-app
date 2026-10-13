export const RUNTIME_PUBLIC_OPERATIONS = Object.freeze([
  'search_places',
  'get_place_details',
  'respond',
] as const);

export type RuntimePublicOperation = (typeof RUNTIME_PUBLIC_OPERATIONS)[number];

/** A step ended without a tool call; `text` is what the model wrote instead (maybe nothing). */
export type RuntimeBatchAction =
  | { readonly kind: 'tool'; readonly operation: string }
  | { readonly kind: 'text'; readonly text: string };

export type RuntimeBatchIssueCode =
  'UNKNOWN_TOOL' | 'MIXED_TERMINAL_ACTION' | 'MULTIPLE_RESPOND' | 'TOOL_FINISH_WITHOUT_TOOL';

export type RuntimeBatchIssue = {
  readonly code: RuntimeBatchIssueCode;
  readonly message: string;
};

/**
 * Every step must call a tool, and respond is the only terminal action. A step without a tool
 * call commits nothing; `missingRespond` says whether the model wrote text or nothing at all.
 */
export type RuntimeBatchResult =
  | {
      readonly ok: true;
      readonly terminal: 'none' | 'respond';
      readonly missingRespond: 'TEXT_WITHOUT_RESPOND' | 'EMPTY_STEP' | null;
    }
  | { readonly ok: false; readonly issue: RuntimeBatchIssue };

const issue = (code: RuntimeBatchIssueCode, message: string): RuntimeBatchResult => ({
  ok: false,
  issue: { code, message },
});

const isPublicOperation = (operation: string): operation is RuntimePublicOperation =>
  RUNTIME_PUBLIC_OPERATIONS.some((candidate) => candidate === operation);

/** Checks one complete provider step before any tool executor is entered. */
export const validateRuntimeBatch = (
  actions: readonly RuntimeBatchAction[],
): RuntimeBatchResult => {
  const tools = actions.filter(
    (action): action is Extract<RuntimeBatchAction, { kind: 'tool' }> => action.kind === 'tool',
  );
  const unknown = tools.find((action) => !isPublicOperation(action.operation));
  if (unknown !== undefined) return issue('UNKNOWN_TOOL', 'provider requested an unknown tool');
  const responds = tools.filter((action) => action.operation === 'respond');
  const reads = tools.filter((action) => action.operation !== 'respond');
  if (reads.length > 0 && responds.length > 0) {
    return issue('MIXED_TERMINAL_ACTION', 'read and respond actions must be separate steps');
  }
  if (responds.length > 1) return issue('MULTIPLE_RESPOND', 'a step may contain one respond');
  if (tools.length > 0) {
    return { ok: true, terminal: responds.length === 1 ? 'respond' : 'none', missingRespond: null };
  }
  const text = actions.find(
    (action): action is Extract<RuntimeBatchAction, { kind: 'text' }> => action.kind === 'text',
  );
  if (text === undefined) {
    return issue('TOOL_FINISH_WITHOUT_TOOL', 'provider step has no executable action');
  }
  return {
    ok: true,
    terminal: 'none',
    missingRespond: text.text.trim().length > 0 ? 'TEXT_WITHOUT_RESPOND' : 'EMPTY_STEP',
  };
};
