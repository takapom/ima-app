export type RuntimeThinkConnectionErrorCode =
  | 'TURN_ALREADY_ACTIVE'
  | 'TURN_NOT_ACTIVE'
  | 'RUNTIME_UNCONFIGURED'
  | 'COMPOSITION_INVALID'
  | 'CANCELLED'
  | 'STALE_TURN';
const connectionErrors = new WeakSet<object>();

export class RuntimeThinkConnectionError extends Error {
  readonly code: RuntimeThinkConnectionErrorCode;

  constructor(code: RuntimeThinkConnectionErrorCode) {
    super(`runtime Think connection denied: ${code}`);
    this.name = 'RuntimeThinkConnectionError';
    this.code = code;
    connectionErrors.add(this);
  }
}

export const isRuntimeThinkConnectionError = (
  value: unknown,
): value is RuntimeThinkConnectionError =>
  typeof value === 'object' && value !== null && connectionErrors.has(value);
