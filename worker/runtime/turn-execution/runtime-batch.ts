export const RUNTIME_PUBLIC_OPERATIONS = Object.freeze([
  'search_places',
  'get_place_details',
  'submit_cards',
] as const);

export type RuntimePublicOperation = (typeof RUNTIME_PUBLIC_OPERATIONS)[number];

export type RuntimeBatchAction =
  | { readonly kind: 'tool'; readonly operation: string }
  | { readonly kind: 'final'; readonly text: string };

export type RuntimeBatchIssueCode =
  | 'UNKNOWN_TOOL'
  | 'MIXED_TERMINAL_ACTION'
  | 'MULTIPLE_SUBMIT'
  | 'FINAL_WITH_TOOL'
  | 'TOOL_FINISH_WITHOUT_TOOL';

export type RuntimeBatchIssue = {
  readonly code: RuntimeBatchIssueCode;
  readonly message: string;
};

export type RuntimeBatchResult =
  | {
      readonly ok: true;
      readonly terminal: 'none' | 'message' | 'submit';
      readonly emptyFinal: boolean;
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
  const finals = actions.filter(
    (action): action is Extract<RuntimeBatchAction, { kind: 'final' }> => action.kind === 'final',
  );
  const unknown = tools.find((action) => !isPublicOperation(action.operation));
  if (unknown !== undefined) return issue('UNKNOWN_TOOL', 'provider requested an unknown tool');
  const submits = tools.filter((action) => action.operation === 'submit_cards');
  const reads = tools.filter((action) => action.operation !== 'submit_cards');
  if (finals.length > 0 && tools.length > 0) {
    return issue('FINAL_WITH_TOOL', 'final message and tool calls must be separate steps');
  }
  if (reads.length > 0 && submits.length > 0) {
    return issue('MIXED_TERMINAL_ACTION', 'read and submit actions must be separate steps');
  }
  if (submits.length > 1) return issue('MULTIPLE_SUBMIT', 'a step may contain one submit action');
  if (finals.length > 1) return issue('FINAL_WITH_TOOL', 'a step may contain one final message');
  if (tools.length === 0 && finals.length === 0) {
    return issue('TOOL_FINISH_WITHOUT_TOOL', 'provider step has no executable action');
  }
  if (finals.length === 1) {
    const final = finals[0];
    if (final === undefined) return issue('FINAL_WITH_TOOL', 'final message is missing');
    return { ok: true, terminal: 'message', emptyFinal: final.text.length === 0 };
  }
  return {
    ok: true,
    terminal: submits.length === 1 ? 'submit' : 'none',
    emptyFinal: false,
  };
};
