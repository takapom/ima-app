import * as v from 'valibot';
import type { RegistryScope } from '@worker/domain/evidence/freshness';
import type {
  CommittedResponse,
  SubmitApplication,
  CommitApplicationResult,
} from '@worker/application/use-cases/submit-response/submit-application';
import type { CandidateObservationRegistryPort } from '@worker/application/ports/registry';
import type { CancellationToken, ToolExecutionContext } from '@worker/application/ports/context';
import {
  SubmitCardsPortInputSchema,
  type SubmitCardsPort,
  type SubmitCardsPortInput,
  type SubmitCardsPortResult,
  type SubmitIssue,
} from '@worker/application/ports/submission';
import type {
  SubmitValidationContext,
  SubmitValidationIssue,
} from '@worker/application/use-cases/submit-response/validation/submit-cards-evidence';

export type SubmitCardsPortFactoryOptions = {
  application: SubmitApplication;
  registry: CandidateObservationRegistryPort;
  scope: RegistryScope;
  validationContext: SubmitValidationContext;
  expectedTurnId: string;
  expectedRevision: number;
  idempotencyKey: string;
  getRemainingRepairs: () => 0 | 1 | 2;
};

export class SubmitApplicationSubmitCardsPort implements SubmitCardsPort {
  constructor(private readonly options: SubmitCardsPortFactoryOptions) {}

  async submit(
    input: SubmitCardsPortInput,
    execution: ToolExecutionContext,
    cancellation: CancellationToken,
  ): Promise<SubmitCardsPortResult> {
    if (cancellation.isCancelled()) return this.cancelled();
    if (execution.operation !== 'submit_cards') {
      return this.invalid([
        {
          code: 'INVALID_ARGUMENT',
          path: 'operation',
          message: 'submit cards port received another operation',
          missingFields: [],
        },
      ]);
    }
    if (
      execution.threadId !== this.options.scope.threadId ||
      execution.turnId !== this.options.expectedTurnId ||
      execution.revision !== this.options.expectedRevision
    ) {
      return this.invalid(
        [
          {
            code: 'STALE_TURN',
            path: 'threadId',
            message: 'submit belongs to another thread',
            missingFields: [],
          },
        ],
        true,
      );
    }
    const parsedInput = v.safeParse(SubmitCardsPortInputSchema, input);
    if (!parsedInput.success) {
      return this.invalid([
        {
          code: 'INVALID_ARGUMENT',
          path: 'input',
          message: 'submit cards input is invalid',
          missingFields: [],
        },
      ]);
    }
    if (cancellation.isCancelled()) return this.cancelled();
    const result = await this.options.application.commitCards(
      parsedInput.output,
      this.options.validationContext,
      this.options.registry,
      {
        scope: this.options.scope,
        turnId: this.options.expectedTurnId,
        expectedRevision: this.options.expectedRevision,
        idempotencyKey: this.options.idempotencyKey,
      },
    );
    return this.toPortResult(result, parsedInput.output);
  }

  getCommittedResponse(
    scope: RegistryScope,
    turnId: string,
    responseId: string,
  ): CommittedResponse | undefined {
    return this.options.application.getCommittedResponse(scope, turnId, responseId);
  }

  clearTurn(scope: RegistryScope, turnId: string): void {
    this.options.application.clearTurn(scope, turnId);
  }

  private toPortResult(
    result: CommitApplicationResult,
    input: SubmitCardsPortInput,
  ): SubmitCardsPortResult {
    if (result.status === 'committed') {
      return {
        status: 'committed',
        responseId: result.receipt.responseId,
        revision: result.receipt.revision,
        presentation: 'replace',
        cards: input,
      };
    }
    if (result.status === 'conflict') {
      return this.invalid(
        [
          {
            code: result.conflict.code === 'STALE_REVISION' ? 'STALE_TURN' : 'SCHEMA_MISMATCH',
            path: 'commit',
            message: result.conflict.message,
            missingFields: [],
          },
        ],
        true,
      );
    }
    const terminal = result.issues.some(
      (issue) =>
        issue.code === 'STALE_TURN' ||
        issue.code === 'CANCELLED' ||
        issue.code === 'BUDGET_EXCEEDED',
    );
    return this.invalid(result.issues, terminal);
  }

  private cancelled(): SubmitCardsPortResult {
    return {
      status: 'invalid',
      issues: [
        {
          code: 'CANCELLED',
          path: null,
          message: 'submit was cancelled',
          missingFields: [],
        },
      ],
      repairable: false,
      remainingRepairs: 0,
    };
  }

  private invalid(
    issues: readonly SubmitValidationIssue[],
    terminal = false,
  ): SubmitCardsPortResult {
    const normalized = issues.map((item): SubmitIssue => ({
      code: item.code,
      path: item.path,
      ...(item.candidateId === undefined ? {} : { candidateId: item.candidateId }),
      ...(item.evidenceIds === undefined ? {} : { evidenceIds: item.evidenceIds }),
      message: item.message,
      missingFields: item.missingFields,
    }));
    const remainingRepairs = terminal ? 0 : this.options.getRemainingRepairs();
    const repairable = !terminal && remainingRepairs > 0;
    return {
      status: 'invalid',
      issues: normalized.slice(0, 8),
      repairable,
      remainingRepairs,
    };
  }
}

export const createSubmitCardsPort = (
  options: SubmitCardsPortFactoryOptions,
): SubmitApplicationSubmitCardsPort => new SubmitApplicationSubmitCardsPort(options);
