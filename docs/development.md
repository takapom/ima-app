# 開発

## 環境と依存導入

Nodeは[.node-version](../.node-version)、Bunは[package.json](../package.json)の`packageManager`を使う。リポジトリルートで実行する。

```sh
bun install --frozen-lockfile
```

## APIキー不要のローカル起動

専用Workerは合成認証値で起動でき、`.dev.vars`は不要。
既存の`workers/api/.dev.vars`がある場合は、live credentialやProvider停止設定を混在させない。開発fixtureはliveへフォールバックせず、live credentialが設定されている場合は拒否する。

```sh
bun run dev:worker:fixture
```

`apps/mobile/.env.local`へ以下の開発用値を設定する。

```dotenv
EXPO_PUBLIC_API_MODE=fixture
EXPO_PUBLIC_ENVIRONMENT=dev
EXPO_PUBLIC_API_BASE_URL=http://localhost:8787
EXPO_PUBLIC_APP_VERSION=m28-dev-fixture
EXPO_PUBLIC_FIXTURE_APP_TOKEN=dev-fixture-app-token
EXPO_PUBLIC_FIXTURE_DEVICE_ID=dev-fixture-device
EXPO_PUBLIC_FIXTURE_OWNER_CREDENTIAL=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE
```

別terminalでExpoを起動する。

```sh
bun run dev:web
```

表示されたWeb URLを開き、新規検索で「カフェ」と入力する。設定変更後はExpoを再起動する。
「アプリ設定を確認してください」が出る場合は`.env.local`、通信エラーならWorkerの8787番での起動を確認する。

fixtureは合成店舗1件、固定の徒歩480秒・600m、合成PNGを返す。実際の現在地からの経路計算ではない。終電は提供しない。徒歩上限を付ける場合は精度・鮮度を満たした現在地が必要であり、位置不足を成功へ補正しない。

Dev Clientは`bun run dev:mobile`で起動する。同一マシンのWeb/Simulatorはlocalhostを使えるが、実機はHTTPS endpointを必要とし、LAN IPへの平文HTTPは許可しない。fixture設定は配布buildへ使わない。
実環境の設定は[運用](operations.md)を参照する。

## 実LLMと合成店舗データでのローカル起動

`workers/api/.dev.vars.llm`を作り、次のキーだけを設定する。このファイルはGitの追跡対象外で、既存の`.dev.vars`とは別に読み込む。

```dotenv
OPENAI_API_KEY=自分のOpenAI_APIキー
```

次のコマンドは実OpenAI APIを使用する。モデルは[既存のモデル設定](../workers/api/src/model/provider-config.ts)に従い、API利用料が発生する。

```sh
bun run dev:worker:llm
```

アプリは上記の開発用認証と`EXPO_PUBLIC_API_MODE=fixture`を使い、別terminalで`bun run dev:web`を実行する。端末側のモードは接続・認証の設定であり、モデルの選択はWorkerが行う。OpenAIキーは端末側へ設定しない。

新しい会話で「恵比寿のカフェを探して」と入力し、カード表示後に条件変更や質問を試す。店舗情報は同じ合成店舗1件で、LLMが操作と応答を選ぶ。写真・徒歩経路・終電はこの構成では無効。GoogleのAPIキーは不要。実LLMの成功と実店舗APIの成功は区別する。

キー不足・無効キー・API障害はエラーになり、固定モデルへ切り替わらない。キーなし起動へ戻す場合はWorkerを終了し、`bun run dev:worker:fixture`で起動する。

## 品質検査

| コマンド               | 検証するもの                                               |
| ---------------------- | ---------------------------------------------------------- |
| `bun run format`       | Prettierによる整形                                         |
| `bun run lint`         | 型付きESLint、Hooks、500行制限、disable理由、違反fixture   |
| `bun run architecture` | 解決済み依存グラフ、manifest、公開exports、境界違反fixture |
| `bun run typecheck`    | 4 workspace、rootと関連toolingのTypeScript                 |
| `bun run test`         | 単体、Worker、App Integrity、実SDK/DO、開発fixture         |
| `bun run build`        | 各workspaceのbuild。Workerはdeploy dry-run                 |
| `bun run commit-size`  | 各コミットの追加＋削除行数                                 |

変更に応じた関連検査を実行し、実行していない検査を合格としない。型・lintの正確な設定は[tsconfig.base.json](../tsconfig.base.json)、[ESLint設定](../eslint.config.mjs)、[Prettier設定](../.prettierrc.json)で管理する。
独自lintは既存の規則で検出できない違反がある場合に限って追加する。

手書きコード・テスト・設定は空行・コメント込み500行以内。Markdown、lockfile、明示した生成物はファイル行数制限から除外する。コミットの追加＋削除は文書・テスト・生成物も含め2,000行以内とし、必要な試験の切り離しや圧縮で回避しない。

[quality CI](../.github/workflows/quality.yml)はmainへのpushで品質検査と各コミットの行数検査を実行する構成。[config dry-run CI](../.github/workflows/config-dry-run.yml)はdev/staging/productionの設定を検査する。定義の存在を、GitHub上での成功や保護設定の証明にしない。
ローカルhookは補助であり、必要なら`git config core.hooksPath .githooks`で有効にする。

## 検証の使い分け

- Core/公開schemaの境界は単体試験、SDKの保存前制御・Tool限定・再送はWorker/DOの統合fixtureで検証する。
- `bun run test:runtime-native`は本番構成・HTTP・開発fixtureを含むSDK検証。固定モデルやmock fetchの成功を実API成功に数えない。
- 実モデル評価・Provider live smoke・実機・配布は[運用](operations.md)の別ゲート。キー未設定や未測定を0件の成功へ変換しない。

## 文書の更新

製品要件は[製品仕様](product.md)、責務と依存図は[アーキテクチャ](architecture.md)、作業規則は[AGENTS.md](../AGENTS.md)に置く。契約の形はschema、コマンドや設定の値はコードを参照し、同じ情報を複数文書で管理しない。
仕様を変えたときに該当文書を直接更新する。未決案・残件・進捗・変更理由はGitHub Issueとコミットへ残し、文書の連番や採択・上書き履歴は管理しない。
既存Issueの古い仕様や資料参照は現行文書と照合し、過去の本文が必要な場合だけGit履歴を読む。
