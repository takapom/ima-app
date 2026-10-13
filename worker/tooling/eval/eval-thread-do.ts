import type { AssistantResponse } from '@ima/contracts';
import { createLiveOpenAIProvider } from '@worker/infrastructure/adapters/out/providers/openai/model-provider';
import { sessionExpiryAt } from '@worker/composition/runtime-production-support';
import { ThreadDO } from '@worker/entrypoints/cloudflare/thread-do';
import type { RuntimeModelGuardModel } from '@worker/infrastructure/runtime/turn-execution/runtime-model-guard';
import type {
  RuntimeSubmitRejection,
  RuntimeTurnOutcome,
} from '@worker/runtime/turn-execution/runtime-submit-diagnostic';
import type { EvalCase, EvalFailure, EvalRunResult, EvalTurnRecord } from './eval-contract';
import { createHotPepperStub } from './hotpepper-stub';
import { createEvalModelRecorder } from './model-recorder';
import { evalShopSetFor, type EvalShopSet } from './shops/shop-sets';
import {
  EVAL_OWNER_SCOPE_REF,
  evalLocationFor,
  evalTurnInput,
  evalTurnRecord,
  responseOf,
  type EvalTurnObservation,
} from './turn-record';

/**
 * 秘密値ではないローカル用の値。ホットペッパーへの通信はすべて偽物が受けるためキーはどこにも送られず、
 * カーソル署名値もこの実行の中のカーソルにしか使わない。
 */
const STUB_HOT_PEPPER_KEY = 'eval-stub-hotpepper-key';
const STUB_CURSOR_SECRET = 'eval-stub-cursor-secret-local-only';

/** 1ケースの間、変わらない設定。 */
type EvalSetup = {
  readonly shops: EvalShopSet;
  /** 現在時刻であり、スレッドの作成時刻とセッション期限の起点でもある。 */
  readonly now: string;
};

const failureJson = (error: EvalFailure['error']): string =>
  JSON.stringify({ error } satisfies EvalFailure);

/**
 * 本番のThreadDOのうち次だけを差し替えた評価用DO。1ケースにつき1つのDOを使う。
 * モデル（記録用middlewareで包む）、ホットペッパー（合成店舗）、時計（現在時刻・作成時刻・
 * セッション期限をケースの時刻に揃える）、turn結果の観測。
 * Tool・スキーマ・予算・ガード・respond検証は本番のものをそのまま使う。
 */
export class EvalThreadDO extends ThreadDO {
  private evalSetup: EvalSetup | undefined;
  private readonly evalRecorder = createEvalModelRecorder();
  private evalOutcome: RuntimeTurnOutcome | null = null;
  private evalRejections: RuntimeSubmitRejection[] = [];

  /**
   * 1ケースを最初のターンから順に実行し、`EvalRunResult`か`EvalFailure`をJSON文字列で返す。
   * 記録には任意のJSON（モデルが出した引数）が入り、RPCの型ではそれを表せないため、
   * 文字列で渡して受け取り側が契約のスキーマで検証する。
   */
  async runEvalCase(threadId: string, evalCase: EvalCase): Promise<string> {
    // Thinkの接続は最初の設定で作られて使い回されるため、同じDOで別のケースを実行しない。
    if (this.evalSetup !== undefined) return failureJson('TURN_FAILED');
    const shops = evalShopSetFor(evalCase.shopSet);
    if (shops === undefined) return failureJson('UNKNOWN_SHOP_SET');
    this.evalSetup = { shops, now: evalCase.now };
    this.evalRecorder.setVariant({
      ...(evalCase.systemPrompt === undefined ? {} : { systemPrompt: evalCase.systemPrompt }),
      ...(evalCase.toolDescriptions === undefined
        ? {}
        : { toolDescriptions: evalCase.toolDescriptions }),
    });
    const initialized = await this.initialize(EVAL_OWNER_SCOPE_REF, threadId);
    if (!initialized.ok) return failureJson('TURN_FAILED');

    const location = evalLocationFor(evalCase.location, shops.origin, evalCase.now);
    const turns: EvalTurnRecord[] = [];
    let shown: AssistantResponse | null = null;
    for (const [index, text] of evalCase.turns.entries()) {
      const result = await this.runRuntimeTurn(
        evalTurnInput({ evalCase, threadId, index, text, location, shown }),
      );
      turns.push(evalTurnRecord(text, result, this.takeEvalTurn()));
      // 失敗後のターンはユーザーが見ていない会話への応答になるため、ここで打ち切る。
      if (result.status !== 'completed') break;
      shown = responseOf(result) ?? shown;
    }
    return JSON.stringify({ turns } satisfies EvalRunResult);
  }

  /** 直前のターンで起きたことを取り出し、次のターンのために空にする。 */
  private takeEvalTurn(): EvalTurnObservation {
    const observation: EvalTurnObservation = {
      ...this.evalRecorder.takeTurn(),
      outcome: this.evalOutcome,
      rejections: this.evalRejections,
    };
    this.evalOutcome = null;
    this.evalRejections = [];
    return observation;
  }

  private requireEvalSetup(): EvalSetup {
    if (this.evalSetup === undefined) throw new Error('EVAL_NOT_CONFIGURED');
    return this.evalSetup;
  }

  /** 設定前（DOの起動処理など）は本番どおりの時計を使う。 */
  protected override runtimeProductionNow(): string {
    return this.evalSetup?.now ?? super.runtimeProductionNow();
  }

  /**
   * 本番は実際の時刻でスレッドの作成時刻を保存し、そこからセッション期限を決める。
   * ケースの時刻と食い違うと期限切れの判定が狂うため、期限もケースの時刻から決める。
   */
  protected override runtimeProductionSessionExpiresAt(): string {
    return this.evalSetup === undefined
      ? super.runtimeProductionSessionExpiresAt()
      : sessionExpiryAt(this.evalSetup.now);
  }

  /** 評価するモデル。既定は本番と同じOpenAI。workerd上の統合テストだけが台本モデルに差し替える。 */
  protected evalBaseModel(): RuntimeModelGuardModel {
    return createLiveOpenAIProvider(this.env).model;
  }

  /**
   * Thinkの接続を作るときに1度だけ呼ばれ、結果は使い回される。設定前に呼ばれたら作らずに失敗させ、
   * ケースと無関係な時刻や店舗を接続に残さない（次の呼び出しで作り直される）。
   */
  protected override createRuntimeProductionOverrides() {
    const setup = this.requireEvalSetup();
    return {
      ...super.createRuntimeProductionOverrides(),
      threadCreatedAt: setup.now,
      modelForTurn: this.evalRecorder.wrap(this.evalBaseModel()),
      fetcher: createHotPepperStub(setup.shops),
      hotPepperApiKey: STUB_HOT_PEPPER_KEY,
      placesCursorSecret: STUB_CURSOR_SECRET,
      clock: () => setup.now,
      turnObserver: {
        outcome: (outcome: RuntimeTurnOutcome) => {
          this.evalOutcome = outcome;
        },
        respondRejected: (rejection: RuntimeSubmitRejection) => {
          this.evalRejections.push(rejection);
        },
      },
    };
  }
}
