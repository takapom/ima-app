import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ImaTurnProvider from '../../tooling/eval/promptfoo/provider';

const vars = {
  shopSet: 'shibuya-ebisu',
  now: '2026-10-10T11:00:00.000Z',
  location: 'available',
  turns: '近くでカフェ',
};
const stderrMarker = 'EVAL_STDERR_MUST_NOT_BE_SAVED';
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'ima-eval-startup-'));
  mkdirSync(join(directory, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(directory, '.dev.vars.llm'), 'OPENAI_API_KEY=test-only\n');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const executable = (source: string, mode = 0o755) => {
  const path = join(directory, 'node_modules/.bin/wrangler');
  writeFileSync(path, `#!/usr/bin/env node\n${source}\n`);
  chmodSync(path, mode);
};

const provider = () =>
  new ImaTurnProvider({ config: { workerDir: directory, readyTimeoutMs: 1_000, port: 18791 } });

describe('評価用Workerの起動失敗', () => {
  /** 実行ファイルの不在で評価全体を落とすと、他のケースの結果も確認できなくなるため。 */
  it('Wranglerがない場合もプロセスを落とさずERRORを返す', async () => {
    const result = await provider().callApi('production', { vars });
    expect(result.error).toContain('ENOENT');
    expect(result.output).toBeUndefined();
  });

  /** 実行権限の不足も、モデルの判断失敗や検索0件とは区別する必要があるため。 */
  it('実行権限がない場合もERRORを返す', async () => {
    executable('process.exit(1);', 0o644);
    const result = await provider().callApi('production', { vars });
    expect(result.error).toContain('EACCES');
    expect(result.output).toBeUndefined();
  });

  /** 起動途中の終了は既存仕様でもERRORであり、診断用の生stderrを保存しないため。 */
  it('起動途中の終了をERRORにし、stderrを結果へ含めない', async () => {
    executable(`console.error('${stderrMarker}'); process.exit(1);`);
    const result = await provider().callApi('production', { vars });
    expect(result.error).toContain('起動中に終了');
    expect(JSON.stringify(result)).not.toContain(stderrMarker);
  });

  /** 起動待ちの上限後に子プロセスを残すと、次の実行で同じポートを占有するため。 */
  it('タイムアウトをERRORにし、待機中のWorkerを停止する', async () => {
    executable(`
import { writeFileSync } from 'node:fs';
console.error('${stderrMarker}');
process.on('SIGTERM', () => { writeFileSync('stopped', 'yes'); process.exit(0); });
setInterval(() => {}, 100);
`);
    const result = await provider().callApi('production', { vars });
    expect(result.error).toContain('1000ms');
    expect(JSON.stringify(result)).not.toContain(stderrMarker);
    await expect.poll(() => existsSync(join(directory, 'stopped'))).toBe(true);
  });

  /** healthの接続先が応答しなくても、起動待ちの上限を超えて待ち続けないため。 */
  it('health応答が止まっても、タイムアウトで通信とWorkerを停止する', async () => {
    executable(`
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
const server = createServer(() => {});
server.listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1');
process.on('SIGTERM', () => {
  server.closeAllConnections();
  server.close(() => { writeFileSync('stopped', 'yes'); process.exit(0); });
});
`);
    const result = await provider().callApi('production', { vars });
    expect(result.error).toContain('1000ms');
    await expect.poll(() => existsSync(join(directory, 'stopped'))).toBe(true);
  });

  /** 前回の起動失敗を起動済みとして使い続けると、設定を直しても再試行できなくなるため。 */
  it('起動失敗の後は、新しいWorkerを起動し直す', async () => {
    const client = provider();
    const first = await client.callApi('production', { vars });
    expect(first.error).toContain('ENOENT');
    executable(
      "import { writeFileSync } from 'node:fs'; writeFileSync('retried', 'yes'); process.exit(1);",
    );
    const second = await client.callApi('production', { vars });
    expect(second.error).toContain('起動中に終了');
    expect(existsSync(join(directory, 'retried'))).toBe(true);
  });
});
