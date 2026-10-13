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
  RespondPortInputSchema,
  type RespondPort,
  type RespondPortInput,
  type RespondPortResult,
  type SubmitIssue,
} from '@worker/application/ports/submission';
import type {
  SubmitValidationContext,
  SubmitValidationIssue,
} from '@worker/application/use-cases/submit-response/validation/submit-cards-evidence';

/**
 * 1ターンの respond を SubmitApplication へつなぐ材料。
 * expectedTurnId と expectedRevision は実行文脈と突き合わせ、別ターンの確定を受け付けない。
 */
export type RespondPortFactoryOptions = {
  application: SubmitApplication;
  registry: CandidateObservationRegistryPort;
  scope: RegistryScope;
  validationContext: SubmitValidationContext;
  expectedTurnId: string;
  expectedRevision: number;
  idempotencyKey: string;
  getRemainingRepairs: () => 0 | 1 | 2;
};

/**
 * モデルの終端操作を1回確定する。質問と回答はカードを残し、提案はカードを置き換える。
 * 修復できる検証失敗だけ残り回数を残す。期限切れ、取消、予算超過は修復不可にする。
 */
export class SubmitApplicationRespondPort implements RespondPort {
  constructor(private readonly options: RespondPortFactoryOptions) {}

  /**
   * このターンの respond だけを確定する。
   * 別操作、別スレッド、取消済みは確定しない。質問と回答はカードを残し、提案はカードを置き換える。
   */
  async respond(
    input: RespondPortInput,
    execution: ToolExecutionContext,
    cancellation: CancellationToken,
  ): Promise<RespondPortResult> {
    if (cancellation.isCancelled()) return this.cancelled();
    if (execution.operation !== 'respond') {
      return this.invalid([
        {
          code: 'INVALID_ARGUMENT',
          path: 'operation',
          message: 'respond port received another operation',
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
    const parsedInput = v.safeParse(RespondPortInputSchema, input);
    if (!parsedInput.success) {
      return this.invalid([
        {
          code: 'INVALID_ARGUMENT',
          path: 'input',
          message: 'respond input is invalid',
          missingFields: [],
        },
      ]);
    }
    if (cancellation.isCancelled()) return this.cancelled();
    const request = {
      scope: this.options.scope,
      turnId: this.options.expectedTurnId,
      expectedRevision: this.options.expectedRevision,
      idempotencyKey: this.options.idempotencyKey,
    };
    const parsed = parsedInput.output;
    const result =
      parsed.kind === 'propose'
        ? await this.options.application.commitCards(
            { message: parsed.message, hero: parsed.hero, alts: parsed.alts },
            this.options.validationContext,
            this.options.registry,
            request,
          )
        : await this.options.application.commitMessage(
            { kind: parsed.kind, message: parsed.message },
            this.options.validationContext,
            request,
          );
    return this.toPortResult(result, parsed.kind);
  }

  /** ツール境界から当ターンの確定応答を読む。破棄済みは返さない。 */
  getCommittedResponse(
    scope: RegistryScope,
    turnId: string,
    responseId: string,
  ): CommittedResponse | undefined {
    return this.options.application.getCommittedResponse(scope, turnId, responseId);
  }

  /** ツール境界からターンのメモリを捨てる。永続レシートの削除はここではない。 */
  clearTurn(scope: RegistryScope, turnId: string): void {
    this.options.application.clearTurn(scope, turnId);
  }

  /**
   * 確定結果を Port の結果へ写す。
   * revision 衝突と、期限切れ、取消、予算超過は修復できない失敗にする。
   */
  private toPortResult(
    result: CommitApplicationResult,
    kind: RespondPortInput['kind'],
  ): RespondPortResult {
    if (result.status === 'committed') {
      return {
        status: 'committed',
        responseId: result.receipt.responseId,
        revision: result.receipt.revision,
        kind,
        presentation: kind === 'propose' ? 'replace' : 'keep',
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

  private cancelled(): RespondPortResult {
    return {
      status: 'invalid',
      issues: [
        {
          code: 'CANCELLED',
          path: null,
          message: 'respond was cancelled',
          missingFields: [],
        },
      ],
      repairable: false,
      remainingRepairs: 0,
    };
  }

  private invalid(issues: readonly SubmitValidationIssue[], terminal = false): RespondPortResult {
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

/** 検証済みの実行文脈から respond の Port を作る。HTTP の解釈はここより前に済んでいる。 */
export const createRespondPort = (
  options: RespondPortFactoryOptions,
): SubmitApplicationRespondPort => new SubmitApplicationRespondPort(options);
