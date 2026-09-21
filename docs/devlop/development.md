# 開発

## 環境と依存導入

Nodeは[.node-version](../../.node-version)、Bunは[package.json](../../package.json)の`packageManager`を使う。リポジトリルートで実行する。

```sh
bun install --frozen-lockfile
```

## APIキー不要のローカル起動

専用Workerは合成認証値で起動でき、`.dev.vars`は不要。
既存の`worker/.dev.vars`がある場合は、live credentialやProvider停止設定を混在させない。開発fixtureはliveへフォールバックせず、live credentialが設定されている場合は拒否する。

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

fixtureはホットペッパー形式の合成店舗1件を返す。写真・徒歩経路・終電は提供しない。徒歩や最低滞在などの必須条件は根拠不足のまま成功へ補正しない。

Dev Clientは`bun run dev:mobile`で起動する。同一マシンのWeb/Simulatorはlocalhostを使えるが、実機はHTTPS endpointを必要とし、LAN IPへの平文HTTPは許可しない。fixture設定は配布buildへ使わない。
実環境の設定は[運用](../operations.md)を参照する。

## 実LLMとホットペッパーでのローカル起動

`worker/.dev.vars.llm`を作り、次の3項目を設定する。このファイルはGitの追跡対象外で、既存の`.dev.vars`とは別に読み込む。

```dotenv
OPENAI_API_KEY=自分のOpenAI_APIキー
HOTPEPPER_API_KEY=自分のホットペッパーAPIキー
PLACES_CURSOR_SECRET=16バイト以上のランダムな秘密値
```

[ホットペッパーWebサービス](https://webservice.recruit.co.jp/register)でAPIキーを取得する。カーソル署名値は例として `openssl rand -hex 32` で生成できる。キー変更後はWorkerを再起動する。

次のコマンドは実OpenAI APIとホットペッパーAPIを使用する。モデルは[既存のモデル設定](../../worker/src/adapters/out/providers/openai/provider-config.ts)に従い、API利用料が発生する。

```sh
bun run dev:worker:llm
```

アプリは上記の開発用認証と`EXPO_PUBLIC_API_MODE=fixture`を使い、別terminalで`bun run dev:web`を実行する。端末側のモードは接続・認証の設定であり、モデルの選択はWorkerが行う。APIキーはWorkerだけに設定する。

新しい会話で「恵比寿のカフェを探して」と入力し、カード表示後に条件変更や質問を試す。LLMが検索語と地域を選び、ホットペッパーの実店舗検索・店舗IDによる詳細取得を行う。店舗写真が取得できれば候補カードに表示する。写真tokenの署名には`PHOTO_TOKEN_SECRET`、未設定なら既存の`PLACES_CURSOR_SECRET`を使うため、追加APIキーは不要。掲載営業時間は表示するが、現在営業中・到着時の営業・ラストオーダーは未確認として扱う。徒歩経路・終電・保存一覧からの店舗再取得はこの構成では無効。Google API実装と接続設定は削除している。

キー不足・無効キー・API障害はエラーになり、固定モデルへ切り替わらない。キーなし起動へ戻す場合はWorkerを終了し、`bun run dev:worker:fixture`で起動する。

検索・会話の待機上限は[Workerのターン予算](../../worker/src/runtime/budget/runtime-budget.ts)、[モデル呼び出し](../../worker/src/runtime/turn-execution/runtime-model-guard.ts)、[端末のHTTPクライアント](../../apps/mobile/src/platform/http/client.ts)で管理する。時間切れの診断ログは`kind: "timeout"`、`code: "MODEL_STREAM_TIMEOUT"`となる。待機設定を変更した場合はWorkerとExpoの両方を再起動する。

`kind: "invalid_tool_input"`はProvider呼出し前のTool引数検証エラー。`fields`に値を含まない契約上の項目名を出し、LLMにも同じ項目名を返して修正を促す。HTTP 200は会話応答の成功を示し、店舗検索やカード提示の成功を保証しない。

カードが出ない場合はまず`event: "turn_outcome"`の行を見る。`committed`が確定の有無、`operations`がそのturnで呼ばれた公開Toolと回数を示す。`submit_cards`が0ならモデルは確定へ進んでおらず、原因は検索結果か指示の側にある。確定を試みた場合は`event: "submit_cards_invalid"`の行を見る。確定が検証で拒否されるとissueの`code`・`path`・`missingFields`・Core側の`message`と、影響した候補数・修復残数を出力する。候補ID・観測ID・生成文・Provider内容は含まない。`missingFields`に`identity`や`opening_hours`が出る場合は、モデルが`submit_cards`の前に`get_place_details`でその根拠を取得していない。この行がなく候補も出ないときは、確定まで到達せず検索が0件だった場合を疑う。

## 品質検査

| コマンド               | 検証するもの                                               |
| ---------------------- | ---------------------------------------------------------- |
| `bun run check`        | 変更パスに対応するゲートだけを選んで実行                   |
| `bun run format`       | Prettierによる整形                                         |
| `bun run docs`         | 文書の配置・行数と、相対リンク・見出しアンカーの実在       |
| `bun run lint`         | 型付きESLint、Hooks、500行制限、disable理由、違反fixture   |
| `bun run architecture` | 解決済み依存グラフ、manifest、公開exports、境界違反fixture |
| `bun run typecheck`    | 3 workspace、rootと関連toolingのTypeScript                 |
| `bun run test`         | 単体、App Integrity、Worker HTTP、実SDK/DO、開発fixture    |
| `bun run build`        | 各workspaceのbuild。Workerはdeploy dry-run                 |
| `bun run commit-size`  | 各コミットの追加＋削除行数                                 |

`bun run check`はstageした差分から必要なゲートを選ぶ。文書だけの変更はformatとdocs、mobileだけの変更はWorker poolを除いた範囲になる。ルート設定や未知のパスは全ゲートを選ぶ。`--all`で全ゲート、`--list`で選択結果だけを表示する。
段階ごとの実行は`test:unit`、`test:app-integrity`、`test:worker-http`、`test:runtime`を使う。
変更に応じた関連検査を実行し、実行していない検査を合格としない。型・lintの正確な設定は[tsconfig.base.json](../../tsconfig.base.json)、[ESLint設定](../../eslint.config.mjs)、[Prettier設定](../../.prettierrc.json)で管理する。
独自lintは既存の規則で検出できない違反がある場合に限って追加する。文書の配置は[check-doc-paths](../../scripts/check-doc-paths.mjs)が許可する入口に限る。
`.codex/skills/`のスキル資産はアプリ用の整形・lint・行数・disable理由検査から除外する。スキル文書は製品文書の行数上限を適用せず、配置・リンクを検査する。

手書きコード・テスト・設定は空行・コメント込み500行以内。Markdown、lockfile、明示した生成物はファイル行数制限から除外する。コミットの追加＋削除は文書・テスト・生成物も含め2,000行以内とし、必要な試験の切り離しや圧縮で回避しない。

[quality CI](../../.github/workflows/quality.yml)はmainへのpushで品質検査と各コミットの行数検査を実行する構成。[config dry-run CI](../../.github/workflows/config-dry-run.yml)はdev/staging/productionの設定を検査する。定義の存在を、GitHub上での成功や保護設定の証明にしない。
ローカルhookは補助であり、必要なら`git config core.hooksPath .githooks`で有効にする。hookは`commit-size`と`bun run check`を実行し、CIは全ゲートを実行する。

## 検証の使い分け

- Core/公開schemaの境界は単体試験、SDKの保存前制御・Tool限定・再送はWorker/DOの統合fixtureで検証する。
- `bun run test:runtime-native`は本番構成・HTTP・開発fixtureを含むSDK検証。固定モデルやmock fetchの成功を実API成功に数えない。
- 実モデル評価・実店舗接続・実機・配布は[運用](../operations.md)の別ゲート。キー未設定や未測定を0件の成功へ変換しない。

## 文書の更新

製品要件は[製品仕様](../product.md)、ディレクトリ構成・責務・依存図は[アーキテクチャ](../architecture/architecture.md)、作業規則は[AGENTS.md](../../AGENTS.md)に置く。契約の形はschema、コマンドや設定の値はコードを参照し、同じ情報を複数文書で管理しない。
仕様を変えたときに該当文書を直接更新する。未決案・残件・進捗・変更理由はGitHub Issueとコミットへ残し、文書の連番や採択・上書き履歴は管理しない。
既存Issueの古い仕様や資料参照は現行文書と照合し、過去の本文が必要な場合だけGit履歴を読む。
