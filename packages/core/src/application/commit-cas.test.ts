import { describe, expect, it } from 'vitest';
import type { RegistryScope } from '../domain';
import type {
  CommitHashPort,
  CommitPort,
  CommitPortResult,
  CommitRecord,
  CommitRequest,
} from '../ports';
import { SubmitApplication } from './submit-application';
import { makeFixture } from './submit-cards-fixtures';

const turnKey = (scope: RegistryScope, turnId: string): string =>
  `${scope.ownerScopeRef}\u0000${scope.threadId}\u0000${turnId}`;

const threadKey = (scope: RegistryScope): string => `${scope.ownerScopeRef}\u0000${scope.threadId}`;

class FixtureCommitHash implements CommitHashPort {
  digest(value: string): string {
    let hash = 2_166_136_261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    return `cas-${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }
}

/** Holds hash calls until both contenders are in flight. */
class BarrierCommitHash implements CommitHashPort {
  private readonly waiters: Array<{ value: string; resolve: (digest: string) => void }> = [];

  constructor(
    private readonly delegate = new FixtureCommitHash(),
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
class InMemoryCommitPort implements CommitPort {
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

  startTurn(scope: RegistryScope, turnId: string, revision: number): void {
    this.activeTurns.set(threadKey(scope), { turnId, revision });
  }

  commit(request: CommitRequest): CommitPortResult {
    this.invocationCount += 1;
    const { expectedRevision, record } = request;
    const active = this.activeTurns.get(threadKey(record.scope));
    if (active === undefined || active.turnId !== record.turnId) {
      return {
        status: 'conflict',
        conflict: { code: 'STALE_REVISION', message: 'commit turn is no longer active' },
      };
    }
    const key = turnKey(record.scope, record.turnId);
    if (this.records.has(key)) {
      return {
        status: 'conflict',
        conflict: { code: 'STALE_REVISION', message: 'turn already has a committed response' },
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
    return {
      status: 'committed',
      receipt: {
        responseId: record.responseId,
        revision: record.revision,
        payloadDigest: record.payloadDigest,
        presentation: record.presentation,
        replayed: false,
      },
    };
  }
}

/** Delays adapter completion until both contenders have reached the CAS boundary. */
class BarrierCommitPort implements CommitPort {
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

const message = (text: string) => ({
  text,
  evidenceIds: [],
  basis: 'conversational' as const,
});

describe('BarrierCommit CAS', () => {
  it('allows only one side of a same-revision concurrent submit to commit', async () => {
    const fixture = makeFixture([], {
      originRef: null,
      maxWalkMinutes: null,
      requireLastOrderAtArrival: false,
    });
    const commits = new InMemoryCommitPort();
    commits.startTurn(fixture.context.scope, 'cas-turn', 1);
    let response = 0;
    const application = new SubmitApplication(
      new BarrierCommitPort(commits),
      { nextResponseId: () => `cas-response-${(response += 1)}` },
      new BarrierCommitHash(),
    );
    const request = (idempotencyKey: string) => ({
      scope: fixture.context.scope,
      turnId: 'cas-turn',
      expectedRevision: 1,
      idempotencyKey,
    });
    const [first, second] = await Promise.all([
      application.commitMessage(
        message('条件を確認しました'),
        fixture.context,
        fixture.registry,
        request('first-key'),
      ),
      application.commitMessage(
        message('競合した内容'),
        fixture.context,
        fixture.registry,
        request('second-key'),
      ),
    ]);

    expect([first.status, second.status].sort()).toEqual(['committed', 'conflict']);
    expect(commits.calls).toBe(2);
    expect(commits.writes).toBe(1);
  });
});
