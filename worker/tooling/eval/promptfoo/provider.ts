import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import * as v from 'valibot';
import {
  EvalFailureSchema,
  EvalHealthSchema,
  EvalRunResultSchema,
  type EvalHealth,
} from '../eval-contract';
import {
  evalCaseFrom,
  evaluationErrorOf,
  parseToolDescriptions,
  renderEvalRun,
  tokenUsageOf,
} from './provider-support';

/**
 * promptfooのカスタムProvider。評価用Workerを`wrangler dev --local`で1度だけ起動し、
 * ケースごとに`POST /turns`を呼ぶ。Workerが使うAPIキーはwranglerが--env-fileから読む。
 * （LLM採点のため、promptfoo自体も同じenvファイルを読むが、このProviderはキーを参照しない。）
 *
 * promptfooを依存に加えないため、Provider契約のうち使う部分の型だけをここに写す。
 */
type ProviderOptions = { readonly id?: string; readonly config?: unknown };
type CallApiContext = { readonly vars?: Record<string, unknown> };
type ProviderResponse = {
  readonly output?: string;
  readonly error?: string;
  readonly metadata?: Record<string, unknown>;
  readonly tokenUsage?: {
    readonly total: number;
    readonly prompt: number;
    readonly completion: number;
  };
  readonly cached?: boolean;
};

// promptfooが`basePath`などを足して渡すため、知らない項目は無視する。
const ProviderConfigSchema = v.object({
  /** リポジトリのルート（promptfooの実行場所）からのWorkerディレクトリ。 */
  workerDir: v.optional(v.string(), 'worker'),
  /** Workerディレクトリからの、OPENAI_API_KEYを置いたenvファイル。 */
  envFile: v.optional(v.string(), '.dev.vars.llm'),
  port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1024), v.maxValue(65_535)), 8791),
  readyTimeoutMs: v.optional(v.pipe(v.number(), v.minValue(1_000)), 120_000),
  caseTimeoutMs: v.optional(v.pipe(v.number(), v.minValue(1_000)), 300_000),
  /** Toolのdescriptionの案（JSON）。評価設定ファイルからの相対パス。省略時は本番のdescription。 */
  toolDescriptionsFile: v.optional(v.string()),
  /** promptfooが渡す、評価設定ファイルのディレクトリ。 */
  basePath: v.optional(v.string()),
});
type ProviderConfig = v.InferOutput<typeof ProviderConfigSchema>;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

type RunningWorker = { readonly child: ChildProcess; readonly ready: Promise<string> };

let running: RunningWorker | undefined;

const stopWorker = (): void => {
  running?.child.kill();
  running = undefined;
};
process.once('exit', stopWorker);

const hasExited = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

/** 起動待ちの間は接続できないため、読めなければundefinedを返して再試行させる。 */
const readHealth = async (baseUrl: string): Promise<EvalHealth | undefined> => {
  try {
    const response = await fetch(`${baseUrl}/health`);
    const parsed = v.safeParse(EvalHealthSchema, await response.json());
    return parsed.success ? parsed.output : undefined;
  } catch {
    return undefined;
  }
};

const waitUntilReady = async (
  baseUrl: string,
  child: ChildProcess,
  instance: string,
  config: ProviderConfig,
  stderr: () => string,
): Promise<string> => {
  const deadline = Date.now() + config.readyTimeoutMs;
  while (Date.now() < deadline) {
    if (hasExited(child)) {
      throw new Error(
        `評価用Workerが起動中に終了しました（ポート${config.port}が使用中の可能性があります）。\n${stderr()}`,
      );
    }
    const health = await readHealth(baseUrl);
    // 前回の実行で残った別のプロセスが同じポートで答えても、今回の起動とは扱わない。
    if (health !== undefined && health.instance === instance) {
      if (!health.modelKeyConfigured) {
        throw new Error('OPENAI_API_KEYが未設定です。envファイルに設定してください。');
      }
      return baseUrl;
    }
    await sleep(500);
  }
  throw new Error(
    `評価用Workerが${config.readyTimeoutMs}ms以内に起動しませんでした。\n${stderr()}`,
  );
};

const ensureWorker = (config: ProviderConfig): Promise<string> => {
  if (running !== undefined) return running.ready;
  const workerDir = resolve(process.cwd(), config.workerDir);
  if (!existsSync(resolve(workerDir, config.envFile))) {
    return Promise.reject(
      new Error(
        `${config.workerDir}/${config.envFile}がありません。docs/devlop/development.mdの手順でOPENAI_API_KEYを設定してください。`,
      ),
    );
  }
  // `/health`で照合する、この起動だけの識別子。
  const instance = randomUUID();
  const child = spawn(
    resolve(workerDir, 'node_modules/.bin/wrangler'),
    [
      'dev',
      '--config',
      'wrangler.eval.jsonc',
      '--env-file',
      config.envFile,
      '--var',
      `EVAL_INSTANCE:${instance}`,
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(config.port),
      '--show-interactive-dev-session=false',
    ],
    {
      cwd: workerDir,
      // 起動ログは捨て、失敗時の手がかりとしてstderrの末尾だけを残す。
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    },
  );
  let stderrTail = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-4_000);
  });
  const ready = waitUntilReady(
    `http://127.0.0.1:${config.port}`,
    child,
    instance,
    config,
    () => stderrTail,
  );
  running = { child, ready };
  // 途中で落ちたWorkerを起動済みとして使い続けず、次のケースで起動し直す。
  child.once('exit', () => {
    if (running?.child === child) running = undefined;
  });
  ready.catch(stopWorker);
  return ready;
};

/** 案のファイルを読む。読めない・形が違うときは、ケースごとにERRORとして返すため理由を保つ。 */
const loadToolDescriptions = (config: ProviderConfig) => {
  if (config.toolDescriptionsFile === undefined) return { ok: true, value: undefined } as const;
  const path = resolve(config.basePath ?? process.cwd(), config.toolDescriptionsFile);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, error: `Toolのdescriptionの案を読めません: ${path}` } as const;
  }
  return parseToolDescriptions(raw);
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : '評価用Workerの呼び出しに失敗しました。';

export default class ImaTurnProvider {
  private readonly providerId: string;
  private readonly config: ProviderConfig;
  private readonly toolDescriptions: ReturnType<typeof loadToolDescriptions>;

  constructor(options: ProviderOptions = {}) {
    this.providerId = options.id ?? 'ima-turn';
    this.config = v.parse(ProviderConfigSchema, options.config ?? {});
    this.toolDescriptions = loadToolDescriptions(this.config);
  }

  id(): string {
    return this.providerId;
  }

  async callApi(prompt: string, context?: CallApiContext): Promise<ProviderResponse> {
    if (!this.toolDescriptions.ok) return { error: this.toolDescriptions.error };
    const evalCase = evalCaseFrom(prompt, context?.vars ?? {}, this.toolDescriptions.value);
    if (!evalCase.ok) return { error: evalCase.error };
    let body: unknown;
    let status: number;
    try {
      const baseUrl = await ensureWorker(this.config);
      const response = await fetch(`${baseUrl}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(evalCase.value),
        signal: AbortSignal.timeout(this.config.caseTimeoutMs),
      });
      status = response.status;
      body = await response.json();
    } catch (error: unknown) {
      return { error: errorText(error) };
    }
    const failure = v.safeParse(EvalFailureSchema, body);
    if (failure.success) return { error: `評価用Workerが失敗しました: ${failure.output.error}` };
    const run = v.safeParse(EvalRunResultSchema, body);
    if (status !== 200 || !run.success) {
      return { error: `評価用Workerの応答が契約と一致しません（HTTP ${status}）。` };
    }
    const evaluationError = evaluationErrorOf(run.output);
    if (evaluationError !== undefined) {
      return { error: evaluationError, metadata: { evalRun: run.output } };
    }
    return {
      output: renderEvalRun(run.output),
      metadata: { evalRun: run.output },
      tokenUsage: tokenUsageOf(run.output),
      cached: false,
    };
  }
}
