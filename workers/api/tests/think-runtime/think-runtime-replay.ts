export type ThinkRuntimeReplayCommit = {
  responseId: string;
  revision: number;
  candidateIds: string[];
  evidenceIds: string[];
};

export type ThinkRuntimeReplayRecord = {
  idempotencyKey: string;
  payloadDigest: string;
  turnId: string;
  revision: number;
  commit: ThinkRuntimeReplayCommit;
};

export type ThinkRuntimeReplayReport = {
  action: 'none' | 'run' | 'replay';
  outcome: 'none' | 'stored' | 'replayed' | 'conflict' | 'stale' | 'missing';
  idempotencyKey: string | null;
  turnId: string | null;
  requestedRevision: number | null;
  storedRevision: number | null;
  commit: ThinkRuntimeReplayCommit | null;
  sameCommit: boolean;
};

export type ThinkRuntimeState = {
  replay?: ThinkRuntimeReplayRecord;
};

export type ThinkRuntimeReplayResult = {
  requestId: string;
  status: 'completed' | 'error';
  error: string | null;
};

export function emptyThinkRuntimeReplay(
  action: ThinkRuntimeReplayReport['action'] = 'none',
): ThinkRuntimeReplayReport {
  return {
    action,
    outcome: 'none',
    idempotencyKey: null,
    turnId: null,
    requestedRevision: null,
    storedRevision: null,
    commit: null,
    sameCommit: false,
  };
}

export function queryText(url: URL, name: string, fallback: string): string {
  const value = url.searchParams.get(name);
  return value === null ? fallback : value.slice(0, 256);
}

export function queryRevision(url: URL): number {
  const value = Number(url.searchParams.get('revision') ?? '1');
  return Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function storeThinkRuntimeReplay(
  input: Omit<ThinkRuntimeReplayRecord, 'payloadDigest' | 'commit'> & {
    payload: string;
    responseId: string;
    candidateIds: string[];
    evidenceIds: string[];
  },
  persist: (state: ThinkRuntimeState) => void,
): Promise<ThinkRuntimeReplayReport> {
  const record: ThinkRuntimeReplayRecord = {
    idempotencyKey: input.idempotencyKey,
    payloadDigest: await sha256Hex(input.payload),
    turnId: input.turnId,
    revision: input.revision,
    commit: {
      responseId: input.responseId,
      revision: input.revision,
      candidateIds: input.candidateIds,
      evidenceIds: input.evidenceIds,
    },
  };
  persist({ replay: record });
  return {
    action: 'run',
    outcome: 'stored',
    idempotencyKey: record.idempotencyKey,
    turnId: record.turnId,
    requestedRevision: record.revision,
    storedRevision: record.revision,
    commit: record.commit,
    sameCommit: false,
  };
}

export async function resolveThinkRuntimeReplay(
  url: URL,
  record: ThinkRuntimeReplayRecord | undefined,
  runNumber: number,
): Promise<{ result: ThinkRuntimeReplayResult; report: ThinkRuntimeReplayReport }> {
  const idempotencyKey = queryText(url, 'idempotencyKey', 'think-runtime-key');
  const turnId = queryText(url, 'turnId', 'turn-think-runtime');
  const requestedRevision = queryRevision(url);
  const payload = queryText(url, 'content', 'same payload');
  const digest = await sha256Hex(payload);
  const commit = record?.commit ?? null;
  let outcome: ThinkRuntimeReplayReport['outcome'] = 'missing';
  let status: ThinkRuntimeReplayResult['status'] = 'error';
  let error: string | null = 'IDEMPOTENCY_MISSING';
  let sameCommit = false;

  if (record !== undefined) {
    if (turnId !== record.turnId || idempotencyKey !== record.idempotencyKey) {
      outcome = 'missing';
    } else if (requestedRevision < record.revision) {
      outcome = 'stale';
      error = 'STALE_TURN';
      sameCommit = true;
    } else if (requestedRevision === record.revision && digest === record.payloadDigest) {
      outcome = 'replayed';
      status = 'completed';
      error = null;
      sameCommit = true;
    } else {
      outcome = 'conflict';
      error = 'IDEMPOTENCY_CONFLICT';
    }
  }

  return {
    result: {
      requestId: `think-runtime-replay-${runNumber}`,
      status,
      error,
    },
    report: {
      action: 'replay',
      outcome,
      idempotencyKey,
      turnId,
      requestedRevision,
      storedRevision: record?.revision ?? null,
      commit,
      sameCommit,
    },
  };
}
