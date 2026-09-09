export type ModelContextErrorCode =
  'INVALID_CONTEXT' | 'SCOPE_MISMATCH' | 'CARD_SET_MISMATCH' | 'INVALID_EVIDENCE';

export class ModelContextError extends Error {
  readonly code: ModelContextErrorCode;

  constructor(code: ModelContextErrorCode, message: string) {
    super(message);
    this.name = 'ModelContextError';
    this.code = code;
  }
}
