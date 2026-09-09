export type ThreadState = 'active' | 'cancelled' | 'ended' | 'restarted' | 'resumed';

export type ThreadSnapshot = {
  readonly threadId: string;
  readonly ownerScopeRef: string;
  readonly revision: number;
  readonly active: boolean;
  readonly state: ThreadState;
};

export type ThreadAuthorization =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'NOT_FOUND' | 'FORBIDDEN' };

export type ThreadStateErrorCode = 'NOT_FOUND' | 'FORBIDDEN';

export type ThreadConflictErrorCode = 'REVISION_CONFLICT' | 'IDEMPOTENCY_CONFLICT';
export type ThreadOperationErrorCode = ThreadStateErrorCode | ThreadConflictErrorCode;

/** Internal DO error; bootstrap maps it to the public status without exposing scope values. */
export class ThreadStateError extends Error {
  readonly code: ThreadStateErrorCode;

  constructor(code: ThreadStateErrorCode) {
    super('thread state is unavailable');
    this.name = 'ThreadStateError';
    this.code = code;
  }
}

/** RPC may deserialize Error instances without preserving their prototype. */
export const isThreadStateError = (value: unknown): value is ThreadStateError => {
  if (value instanceof ThreadStateError) return true;
  if (typeof value !== 'object' || value === null) return false;
  if (!('name' in value) || value.name !== 'ThreadStateError') return false;
  if (!('code' in value)) return false;
  return value.code === 'NOT_FOUND' || value.code === 'FORBIDDEN';
};

export class ThreadConflictError extends Error {
  readonly code: ThreadConflictErrorCode;

  constructor(code: ThreadConflictErrorCode) {
    super('thread operation conflicts with current state');
    this.name = 'ThreadConflictError';
    this.code = code;
  }
}

export const isThreadConflictError = (value: unknown): value is ThreadConflictError => {
  if (value instanceof ThreadConflictError) return true;
  if (typeof value !== 'object' || value === null) return false;
  if (!('name' in value) || value.name !== 'ThreadConflictError') return false;
  if (!('code' in value)) return false;
  return value.code === 'REVISION_CONFLICT' || value.code === 'IDEMPOTENCY_CONFLICT';
};

export type ThreadSnapshotResult =
  | { readonly ok: true; readonly snapshot: ThreadSnapshot }
  | { readonly ok: false; readonly code: ThreadOperationErrorCode };

export type ThreadDeleteResult =
  { readonly ok: true } | { readonly ok: false; readonly code: ThreadOperationErrorCode };
