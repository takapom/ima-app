import {
  type CommitPort,
  type CommitPortResult,
  type CommitRecord,
  type CommitRequest,
  type CommitReceipt,
  type CommitHashPort,
  type RegistryScope,
} from '@ima/core';

const turnKey = (scope: RegistryScope, turnId: string): string =>
  `${scope.ownerScopeRef}\u0000${scope.threadId}\u0000${turnId}`;

const threadKey = (scope: RegistryScope): string => `${scope.ownerScopeRef}\u0000${scope.threadId}`;

const receiptFor = (record: CommitRecord, replayed: boolean): CommitReceipt => ({
  responseId: record.responseId,
  revision: record.revision,
  payloadDigest: record.payloadDigest,
  presentation: record.presentation,
  replayed,
});

export class EvalCommitHash implements CommitHashPort {
  digest(value: string): string {
    let hash = 2_166_136_261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    return `eval-${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }
}

type HashWaiter = {
  value: string;
  resolve: (digest: string) => void;
};

/** Holds hash calls until both contenders are in flight. */
export class BarrierCommitHash implements CommitHashPort {
  private readonly waiters: HashWaiter[] = [];

  constructor(
    private readonly delegate = new EvalCommitHash(),
    private readonly participants = 2,
  ) {}

  digest(value: string): Promise<string> {
    return new Promise((resolve) => {
      this.waiters.push({ value, resolve });
      if (this.waiters.length < this.participants) return;
      const released = this.waiters.splice(0, this.participants);
      for (const waiter of released) waiter.resolve(this.delegate.digest(waiter.value));
    });
  }
}

/** In-memory CAS fixture. Its durable map contains reference metadata only. */
export class InMemoryCommitPort implements CommitPort {
  private readonly records = new Map<string, CommitRecord>();
  private readonly activeTurns = new Map<string, { turnId: string; revision: number }>();
  private mutationCount = 0;
  private invocationCount = 0;

  get writes(): number {
    return this.mutationCount;
  }

  get calls(): number {
    return this.invocationCount;
  }

  read(scope: RegistryScope, turnId: string): Readonly<CommitRecord> | undefined {
    const record = this.records.get(turnKey(scope, turnId));
    return record === undefined ? undefined : structuredClone(record);
  }

  startTurn(scope: RegistryScope, turnId: string, revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error('fixture turn revision must be a non-negative safe integer');
    }
    this.activeTurns.set(threadKey(scope), { turnId, revision });
  }

  commit(request: CommitRequest): CommitPortResult {
    this.invocationCount += 1;
    const { expectedRevision, record } = request;
    const active = this.activeTurns.get(threadKey(record.scope));
    if (active === undefined || active.turnId !== record.turnId) {
      return {
        status: 'conflict',
        conflict: {
          code: 'STALE_REVISION',
          message: 'commit turn is no longer active',
        },
      };
    }
    const key = turnKey(record.scope, record.turnId);
    const existing = this.records.get(key);
    if (existing !== undefined) {
      if (existing.idempotencyKey === record.idempotencyKey) {
        if (expectedRevision + 1 !== existing.revision || active.revision !== existing.revision) {
          return {
            status: 'conflict',
            conflict: {
              code: 'STALE_REVISION',
              message: 'replay revision does not match the active turn',
            },
          };
        }
        if (existing.payloadDigest === record.payloadDigest) {
          return { status: 'committed', receipt: receiptFor(existing, true) };
        }
        return {
          status: 'conflict',
          conflict: {
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'idempotency key was already used for different content',
          },
        };
      }
      return {
        status: 'conflict',
        conflict: {
          code: 'STALE_REVISION',
          message: 'turn already has a committed response',
        },
      };
    }
    if (expectedRevision !== active.revision || record.revision !== expectedRevision + 1) {
      return {
        status: 'conflict',
        conflict: {
          code: 'STALE_REVISION',
          message: 'expected revision does not match the current turn',
        },
      };
    }
    this.records.set(key, structuredClone(record));
    this.mutationCount += 1;
    active.revision = record.revision;
    return { status: 'committed', receipt: receiptFor(record, false) };
  }
}

/** Delays adapter completion until both contenders have reached the CAS boundary. */
export class BarrierCommitPort implements CommitPort {
  private readonly pending: Array<{
    request: CommitRequest;
    resolve: (result: CommitPortResult) => void;
  }> = [];

  constructor(
    private readonly delegate: InMemoryCommitPort,
    private readonly participants = 2,
  ) {}

  commit(request: CommitRequest): Promise<CommitPortResult> {
    return new Promise((resolve) => {
      this.pending.push({ request, resolve });
      if (this.pending.length < this.participants) return;
      const released = this.pending.splice(0, this.participants);
      for (const pending of released) pending.resolve(this.delegate.commit(pending.request));
    });
  }
}

export type CommitFixture = {
  commits: InMemoryCommitPort;
  hashes: EvalCommitHash;
};

export const createCommitFixture = (): CommitFixture => ({
  commits: new InMemoryCommitPort(),
  hashes: new EvalCommitHash(),
});
