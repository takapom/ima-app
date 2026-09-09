# Development

このリポジトリは Bun 1.3.8 の workspace と Node.js 24.11.1 を使用する。`.node-version` と `package.json` の `engines` を実行環境の基準にする。

## 起動

- `bun run dev:mobile`: Expo Dev Client を起動する。
- `bun run dev:worker`: Wrangler のローカル Worker を起動する。
- `bun install --frozen-lockfile`: `bun.lock` と manifest の一致を検査する。

## 品質ゲート

- `bun run format`: Prettier の対象ファイルだけを検査する。履歴 ADR、計画資料、既存 HTML は `.prettierignore` に明示している。
- `bun run lint`: ESLint、500 行制限、`eslint-disable` の理由、型付き規則の実違反フィクスチャを検査する。
- `bun run architecture`: dependency-cruiser の解決済みグラフと workspace manifest の依存境界を検査し、許可・拒否フィクスチャを実行する。
- `bun run typecheck`: 5 workspace と root のテスト・Vitest/Worker 設定を `tsc` で検査する。
- `bun run test`: Vitest の unit suite と Cloudflare Workers runtime suite を別 pool で実行する。
- `bun run build`: 各 workspace の build script を実行する。

ローカル補助 hook を有効にする場合は `git config core.hooksPath .githooks` を一度実行する。hook は補助的な再確認であり、この環境では有効化しておらず、品質ゲートは手動コマンドで検証している。

Worker の runtime suite は `@cloudflare/vitest-pool-workers` の `SELF` 経由で `/health` の成功、拒否メソッド、未知パスを検査する。HTTP、Cloudflare/LLM SDK、runtime、provider、storage、bootstrap は `workers/api` 内の責務別 adapter に限定し、`src/tool-bindings` は安定した tool 契約と provider adapter の変換を担って直接 provider SDK を呼ばない。Core と UI はそれぞれ port/service 経由の I/O を要求する。

実装・設定・テストの手書きファイルは 500 行以内、各 commit は `bun run commit-size` で 2,000 行以内にする。新しい例外は対象 rule と具体的な理由を同じ directive に書き、`max-lines` や全 rule の disable では回避しない。

`.github/workflows/quality.yml` は main push 用の定義として検証する。GitHub 側の branch protection 設定と CI の実稼働状態は、この環境では未確認である。

今回の検証環境では通常の `bun install --ignore-scripts --no-progress` が approval policy により拒否されたため、fresh install と Core の新規 `valibot` manifest 変更後の lockfile 更新は未検証である。lockfile の手編集や別 installer による代替は行わない。

静的な import 境界検査は、解決済み graph・manifest・alias・type import・re-export を検査するが、実 provider SDK の挙動や外部 binding の runtime 契約までは証明しない。SDK と runtime の実契約は M04 の実 Worker/DO 契約試験で確認する。
