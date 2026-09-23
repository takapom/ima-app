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
import { createSubmitCardsPort } from '@worker/application/use-cases/submit-response/submit-cards-port';
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
  operation: 'submit_cards',
  threadId,
  turnId: 'port-turn-1',
  revision: 1,
});

const messageFixture = () => makeFixture([], { requireLastOrderAtArrival: false });

describe('submit cards application adapter', () => {
  it('passes runtime metadata to SubmitApplication and returns the legacy port shape', async () => {
    const fixture = makeFixture();
    const ids = fixture.ids.get('candidate-1');
    if (ids === undefined) throw new Error('fixture candidate missing');
    const commit = new FixedCommit();
    const port = createSubmitCardsPort({
      application: new SubmitApplication(commit, new FixedResponseIds(), new FixedHash()),
      registry: fixture.registry,
      scope: fixture.context.scope,
      validationContext: fixture.context,
      expectedTurnId: 'port-turn-1',
      expectedRevision: 1,
      idempotencyKey: 'port-idempotency',
      getRemainingRepairs: () => 2,
    });

    const input = makeInput([makeSelection('candidate-1', ids)]);
    const result = await port.submit(input, execution(fixture.context.scope.threadId), token);

    expect(result.status).toBe('committed');
    if (result.status !== 'committed') return;
    expect(result.cards).toEqual(input);
    expect(commit.records[0]?.idempotencyKey).toBe('port-idempotency');
    const response = port.getCommittedResponse(
      fixture.context.scope,
      'port-turn-1',
      result.responseId,
    );
    expect(response?.presentation).toBe('replace');
  });

  it('uses the injected repair snapshot and never commits invalid cards', async () => {
    const fixture = makeFixture();
    const ids = fixture.ids.get('candidate-1');
    if (ids === undefined) throw new Error('fixture candidate missing');
    const commit = new FixedCommit();
    let repairs: 0 | 1 | 2 = 2;
    const port = createSubmitCardsPort({
      application: new SubmitApplication(commit, new FixedResponseIds(), new FixedHash()),
      registry: fixture.registry,
      scope: fixture.context.scope,
      validationContext: fixture.context,
      expectedTurnId: 'port-turn-1',
      expectedRevision: 1,
      idempotencyKey: 'port-invalid',
      getRemainingRepairs: () => repairs,
    });
    const invalidInput = makeInput([makeSelection('candidate-1', ids)]);
    invalidInput.hero.evidenceIds = invalidInput.hero.evidenceIds.filter(
      (id) => id !== ids.opening,
    );

    const first = await port.submit(invalidInput, execution(fixture.context.scope.threadId), token);
    repairs = 1;
    const second = await port.submit(
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
    const port = createSubmitCardsPort({
      application: new SubmitApplication(commit, new FixedResponseIds(), new FixedHash()),
      registry: fixture.registry,
      scope: fixture.context.scope,
      validationContext: fixture.context,
      expectedTurnId: 'port-turn-1',
      expectedRevision: 1,
      idempotencyKey: 'port-cancel',
      getRemainingRepairs: () => 2,
    });
    const input = makeInput([makeSelection('candidate-1', ids)]);
    const cancelled = await port.submit(input, execution(fixture.context.scope.threadId), {
      isCancelled: () => true,
    });
    const drifted = await port.submit(
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
    const input = { text: '確認しました', evidenceIds: [], basis: 'conversational' as const };
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
      wrongReceipt.commitMessage(input, fixture.context, fixture.registry, request),
    ).rejects.toBeInstanceOf(CommitAdapterError);
    await expect(
      throwing.commitMessage(input, fixture.context, fixture.registry, request),
    ).rejects.toThrow('commit adapter failed');
  });

  it('does not recreate an ephemeral response when a delayed digest finishes after disposal', async () => {
    const fixture = messageFixture();
    const hash = new DeferredHash();
    const commit = new FixedCommit();
    const application = new SubmitApplication(commit, new FixedResponseIds(), hash);
    const pending = application.commitMessage(
      { text: '遅着', evidenceIds: [], basis: 'conversational' },
      fixture.context,
      fixture.registry,
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
      { text: '遅着commit', evidenceIds: [], basis: 'conversational' },
      fixture.context,
      fixture.registry,
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
