import { describe, expect, it } from 'vitest';
import type {
  CancellationToken,
  IdPort,
  ToolExecutionContext,
} from '@worker/application/ports/context';
import type {
  CommitHashPort,
  CommitPort,
  CommitPortResult,
  CommitRecord,
  CommitRequest,
} from '@worker/application/ports/commit';
import {
  CommitAdapterError,
  SubmitApplication,
} from '@worker/application/use-cases/submit-response/submit-application';
import { createRespondPort } from '@worker/application/use-cases/submit-response/respond-port';
import {
  makeFixture,
  makeInput,
  makeSelection,
} from '@worker/application/use-cases/submit-response/tests/submit-cards-fixtures';

class FixedResponseIds implements Pick<IdPort, 'nextResponseId'> {
  private count = 0;

  nextResponseId(): string {
    this.count += 1;
    return `port-response-${this.count}`;
  }
}

class FixedHash implements CommitHashPort {
  digest(value: string): string {
    return `port-hash-${value.length}`;
  }
}

class FixedCommit implements CommitPort {
  readonly records: CommitRecord[] = [];

  commit(request: CommitRequest): CommitPortResult {
    this.records.push(request.record);
    return {
      status: 'committed',
      receipt: {
        responseId: request.record.responseId,
        revision: request.record.revision,
        payloadDigest: request.record.payloadDigest,
        presentation: request.record.presentation,
        replayed: false,
      },
    };
  }
}

class WrongRevisionCommit implements CommitPort {
  commit(request: CommitRequest): CommitPortResult {
    return {
      status: 'committed',
      receipt: {
        responseId: request.record.responseId,
        revision: request.record.revision + 1,
        payloadDigest: request.record.payloadDigest,
        presentation: request.record.presentation,
        replayed: false,
      },
    };
  }
}

class ThrowingCommit implements CommitPort {
  commit(_request: CommitRequest): CommitPortResult {
    throw new Error('commit adapter failed');
  }
}

class DeferredHash implements CommitHashPort {
  private resolver: ((value: string) => void) | undefined;

  digest(_value: string): Promise<string> {
    return new Promise((resolve) => {
      this.resolver = resolve;
    });
  }

  resolve(): void {
    const resolver = this.resolver;
    if (resolver === undefined) throw new Error('digest was not started');
    this.resolver = undefined;
    resolver('deferred-hash');
  }
}

class DeferredCommit implements CommitPort {
  private resolver: (() => void) | undefined;
  calls = 0;

  commit(request: CommitRequest): Promise<CommitPortResult> {
    this.calls += 1;
    return new Promise((resolve) => {
      this.resolver = () =>
        resolve({
          status: 'committed',
          receipt: {
            responseId: request.record.responseId,
            revision: request.record.revision,
            payloadDigest: request.record.payloadDigest,
            presentation: request.record.presentation,
            replayed: false,
          },
        });
    });
  }

  resolve(): void {
    const resolver = this.resolver;
    if (resolver === undefined) throw new Error('commit was not started');
    this.resolver = undefined;
    resolver();
  }
}

const token: CancellationToken = { isCancelled: () => false };

const execution = (threadId: string): ToolExecutionContext => ({
  callId: 'port-call-1',
  operation: 'respond',
  threadId,
  turnId: 'port-turn-1',
  revision: 1,
});

const messageFixture = () => makeFixture([], { requireLastOrder: false });

describe('respond application adapter', () => {
  it('commits a proposal through SubmitApplication and reports its kind', async () => {
    const fixture = makeFixture();
    const ids = fixture.ids.get('candidate-1');
    if (ids === undefined) throw new Error('fixture candidate missing');
    const commit = new FixedCommit();
    const port = createRespondPort({
      application: new SubmitApplication(commit, new FixedResponseIds(), new FixedHash()),
      registry: fixture.registry,
      scope: fixture.context.scope,
      validationContext: fixture.context,
      expectedTurnId: 'port-turn-1',
      expectedRevision: 1,
      idempotencyKey: 'port-idempotency',
      getRemainingRepairs: () => 2,
    });

    const input = { kind: 'propose' as const, ...makeInput([makeSelection('candidate-1')]) };
    const result = await port.respond(input, execution(fixture.context.scope.threadId), token);

    expect(result.status).toBe('committed');
    if (result.status !== 'committed') return;
    expect(result).toMatchObject({ kind: 'propose', presentation: 'replace' });
    expect(commit.records[0]?.idempotencyKey).toBe('port-idempotency');
    const response = port.getCommittedResponse(
      fixture.context.scope,
      'port-turn-1',
      result.responseId,
    );
    expect(response?.presentation).toBe('replace');
  });

  it.each(['ask', 'answer'] as const)(
    'commits %s as a message that keeps the cards on screen',
    async (kind) => {
      const fixture = messageFixture();
      const commit = new FixedCommit();
      const port = createRespondPort({
        application: new SubmitApplication(commit, new FixedResponseIds(), new FixedHash()),
        registry: fixture.registry,
        scope: fixture.context.scope,
        validationContext: fixture.context,
        expectedTurnId: 'port-turn-1',
        expectedRevision: 1,
        idempotencyKey: `port-${kind}`,
        getRemainingRepairs: () => 2,
      });
      const result = await port.respond(
        { kind, message: 'どのエリアで探しますか？' },
        execution(fixture.context.scope.threadId),
        token,
      );
      expect(result).toMatchObject({ status: 'committed', kind, presentation: 'keep' });
      if (result.status !== 'committed') return;
      expect(
        port.getCommittedResponse(fixture.context.scope, 'port-turn-1', result.responseId),
      ).toEqual({ presentation: 'keep', kind, message: 'どのエリアで探しますか？' });
      expect(commit.records[0]?.presentation).toBe('keep');
    },
  );

  it('uses the injected repair snapshot and never commits invalid cards', async () => {
    const fixture = makeFixture();
    const ids = fixture.ids.get('candidate-1');
    if (ids === undefined) throw new Error('fixture candidate missing');
    const commit = new FixedCommit();
    let repairs: 0 | 1 | 2 = 2;
    const port = createRespondPort({
      application: new SubmitApplication(commit, new FixedResponseIds(), new FixedHash()),
      registry: fixture.registry,
      scope: fixture.context.scope,
      validationContext: fixture.context,
      expectedTurnId: 'port-turn-1',
      expectedRevision: 1,
      idempotencyKey: 'port-invalid',
      getRemainingRepairs: () => repairs,
    });
    const invalidInput = {
      kind: 'propose' as const,
      ...makeInput([makeSelection('candidate-unregistered')]),
    };

    const first = await port.respond(
      invalidInput,
      execution(fixture.context.scope.threadId),
      token,
    );
    repairs = 1;
    const second = await port.respond(
      invalidInput,
      execution(fixture.context.scope.threadId),
      token,
    );

    expect(first.status).toBe('invalid');
    expect(second.status).toBe('invalid');
    if (first.status === 'invalid' && second.status === 'invalid') {
      expect(first.remainingRepairs).toBe(2);
      expect(first.repairable).toBe(true);
      expect(second.remainingRepairs).toBe(1);
    }
    expect(commit.records).toHaveLength(0);
  });

  it('does not start a commit after cancellation and rejects execution metadata drift', async () => {
    const fixture = makeFixture();
    const ids = fixture.ids.get('candidate-1');
    if (ids === undefined) throw new Error('fixture candidate missing');
    const commit = new FixedCommit();
    const port = createRespondPort({
      application: new SubmitApplication(commit, new FixedResponseIds(), new FixedHash()),
      registry: fixture.registry,
      scope: fixture.context.scope,
      validationContext: fixture.context,
      expectedTurnId: 'port-turn-1',
      expectedRevision: 1,
      idempotencyKey: 'port-cancel',
      getRemainingRepairs: () => 2,
    });
    const input = { kind: 'propose' as const, ...makeInput([makeSelection('candidate-1')]) };
    const cancelled = await port.respond(input, execution(fixture.context.scope.threadId), {
      isCancelled: () => true,
    });
    const drifted = await port.respond(
      input,
      { ...execution(fixture.context.scope.threadId), revision: 2 },
      token,
    );

    expect(cancelled.status).toBe('invalid');
    expect(drifted.status).toBe('invalid');
    expect(commit.records).toHaveLength(0);
  });

  it('surfaces adapter receipt/schema failures as errors rather than invalid input', async () => {
    const fixture = messageFixture();
    const request = {
      scope: fixture.context.scope,
      turnId: 'port-turn-1',
      expectedRevision: 1,
      idempotencyKey: 'error-key',
    };
    const input = { kind: 'answer', message: '確認しました' };
    const wrongReceipt = new SubmitApplication(
      new WrongRevisionCommit(),
      new FixedResponseIds(),
      new FixedHash(),
    );
    const throwing = new SubmitApplication(
      new ThrowingCommit(),
      new FixedResponseIds(),
      new FixedHash(),
    );

    await expect(
      wrongReceipt.commitMessage(input, fixture.context, request),
    ).rejects.toBeInstanceOf(CommitAdapterError);
    await expect(throwing.commitMessage(input, fixture.context, request)).rejects.toThrow(
      'commit adapter failed',
    );
  });

  it('does not recreate an ephemeral response when a delayed digest finishes after disposal', async () => {
    const fixture = messageFixture();
    const hash = new DeferredHash();
    const commit = new FixedCommit();
    const application = new SubmitApplication(commit, new FixedResponseIds(), hash);
    const pending = application.commitMessage(
      { kind: 'answer', message: '遅着' },
      fixture.context,
      {
        scope: fixture.context.scope,
        turnId: 'port-turn-1',
        expectedRevision: 1,
        idempotencyKey: 'late-digest',
      },
    );
    application.clearTurn(fixture.context.scope, 'port-turn-1');
    hash.resolve();
    const result = await pending;

    expect(result).toEqual({
      status: 'conflict',
      conflict: {
        code: 'STALE_REVISION',
        message: 'turn ephemeral response was disposed',
      },
    });
    expect(commit.records).toHaveLength(0);
  });

  it('does not recreate an ephemeral response when commit resolves after disposal', async () => {
    const fixture = messageFixture();
    const commit = new DeferredCommit();
    const application = new SubmitApplication(commit, new FixedResponseIds(), new FixedHash());
    const pending = application.commitMessage(
      { kind: 'answer', message: '遅着commit' },
      fixture.context,
      {
        scope: fixture.context.scope,
        turnId: 'port-turn-1',
        expectedRevision: 1,
        idempotencyKey: 'late-commit',
      },
    );
    await Promise.resolve();
    application.clearTurn(fixture.context.scope, 'port-turn-1');
    commit.resolve();
    const result = await pending;

    expect(result.status).toBe('committed');
    expect(commit.calls).toBe(1);
    if (result.status === 'committed') {
      expect(
        application.getCommittedResponse(
          fixture.context.scope,
          'port-turn-1',
          result.receipt.responseId,
        ),
      ).toBeUndefined();
    }
  });
});
