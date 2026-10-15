# 開発

## 環境と依存導入

Nodeは[.node-version](../../.node-version)、Bunは[package.json](../../package.json)の`packageManager`を使う。リポジトリルートで実行する。

```sh
bun install --frozen-lockfile
```

## 実LLMとホットペッパーでのローカル起動

`worker/.dev.vars.llm`を作り、次の3項目を設定する。このファイルはGitの追跡対象外で、既存の`.dev.vars`とは別に読み込む。

```dotenv
OPENAI_API_KEY=自分のOpenAI_APIキー
HOTPEPPER_API_KEY=自分のホットペッパーAPIキー
PLACES_CURSOR_SECRET=16バイト以上のランダムな秘密値
```

[ホットペッパーWebサービス](https://webservice.recruit.co.jp/register)でAPIキーを取得する。カーソル署名値は例として `openssl rand -hex 32` で生成できる。キー変更後はWorkerを再起動する。

次のコマンドは実OpenAI APIとホットペッパーAPIを使用する。モデルは[既存のモデル設定](../../worker/src/infrastructure/adapters/out/providers/openai/provider-config.ts)に従い、API利用料が発生する。

```sh
bun run dev:worker:llm
```

[開発専用Worker](../../worker/wrangler.dev.jsonc)は本番のHTTPとDOを使い、localhostからのブラウザ接続だけCORSを許可する。固定店舗・固定モデルは持たない。

`apps/mobile/.env.local`へ以下の開発用値を設定し、別terminalで`bun run dev:web`を実行する。

```dotenv
EXPO_PUBLIC_API_MODE=fixture
EXPO_PUBLIC_ENVIRONMENT=dev
EXPO_PUBLIC_API_BASE_URL=http://localhost:8787
EXPO_PUBLIC_APP_VERSION=dev-local
EXPO_PUBLIC_FIXTURE_APP_TOKEN=dev-fixture-app-token
EXPO_PUBLIC_FIXTURE_DEVICE_ID=dev-local-device
EXPO_PUBLIC_FIXTURE_OWNER_CREDENTIAL=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE
```

端末側の`fixture`は開発用の接続・認証設定であり、Workerは実モデル・実店舗APIへ接続する。APIキーはWorkerだけに設定する。設定変更後はExpoを再起動する。
Dev Clientは`bun run dev:mobile`で起動する。同一マシンのWeb/Simulatorはlocalhostを使えるが、実機はHTTPS endpointを必要とし、LAN IPへの平文HTTPは許可しない。上記の開発用認証を配布buildへ使わない。実環境の設定は[運用](../operations.md)を参照する。

新しい会話で「恵比寿のカフェを探して」と入力し、カード表示後に条件変更や質問を試す。LLMが検索語と地域を選び、ホットペッパーの実店舗検索を行う。検索1回で店名・営業時間・予算・設備・写真を登録するため、カードは詳細取得なしで確定できる。店舗IDによる詳細取得は期限切れ項目の取り直しに使う。店舗写真が取得できれば候補カードに表示する。写真tokenの署名には`PHOTO_TOKEN_SECRET`、未設定なら既存の`PLACES_CURSOR_SECRET`を使うため、追加APIキーは不要。掲載営業時間は表示するが、現在営業中・到着時の営業・ラストオーダーは未確認として扱う。徒歩経路・終電・保存一覧からの店舗再取得はこの構成では無効。Google API実装と接続設定は削除している。

キー不足・無効キー・API障害はエラーになり、固定モデルへ切り替わらない。APIキーなしで固定応答を返す起動経路は設けない。

検索・会話の待機上限は[Workerのターン予算](../../worker/src/infrastructure/runtime/budget/runtime-budget.ts)、[モデル呼び出し](../../worker/src/infrastructure/runtime/turn-execution/runtime-model-guard.ts)、[端末のHTTPクライアント](../../apps/mobile/src/platform/http/client.ts)で管理する。時間切れの診断ログは`kind: "timeout"`、`code: "MODEL_STREAM_TIMEOUT"`となる。待機設定を変更した場合はWorkerとExpoの両方を再起動する。

`kind: "invalid_tool_input"`はProvider呼出し前のTool引数検証エラー。`fields`に値を含まない契約上の項目名を出し、LLMにも同じ項目名を返して修正を促す。HTTP 200は会話応答の成功を示し、店舗検索やカード提示の成功を保証しない。

カードが出ない場合はまず`event: "turn_outcome"`の行を見る。`committed`が確定の有無、`kind`が確定した応答の種別（`ask`・`answer`・`propose`）、`operations`がそのturnで呼ばれた公開Toolと回数を示す。`respond`が0ならToolまで届いた確定はない。モデルが確定しなかったか、respondの引数がTool schemaで拒否されたかのどちらかで、後者はTool実行前に落ちるため`respond_invalid`の行も修復予算の消費もなく、`kind: "invalid_tool_input"`・`tool: "respond"`の`runtime_upstream_failure`行だけに残る。Toolを呼ばずに文章だけ・空で終わったstepは`event: "respond_missing"`の`reason`（`TEXT_WITHOUT_RESPOND`・`EMPTY_STEP`）に出る。確定を試みた場合は`event: "respond_invalid"`の行を見る。確定が検証で拒否されるとissueの`code`・`path`・`missingFields`・Core側の`message`と、影響した候補数・修復残数を出力する。候補ID・観測ID・生成文・Provider内容は含まない。カードの店名・営業時間などの根拠はCoreがレジストリから付ける。`missingFields`に`identity`や`opening_hours`が出る場合は、その候補の有効な観測がレジストリにない（検索結果に含まれない、または期限切れ・競合で`get_place_details`による取り直しが必要）。この行がなく候補も出ないときは、確定まで到達せず検索が0件だった場合を疑う。

## プロンプトとToolの評価（promptfoo）

[promptfoo](https://www.promptfoo.dev/)で、本番と同じターンを実OpenAIと合成店舗で実行し、Tool呼び出しと応答を採点する。プロンプト・Tool定義の変更前後の比較に使う。

```sh
bun run eval:smoke           # 既存4ケースを1回ずつ実行。モデル呼び出しのみ課金（LLM採点なし）
bun run eval                 # 全ケースを1回ずつ実行。OpenAIの利用料が発生する（モデルとLLM採点）
bun run eval --repeat 3      # 揺らぎを見るため、各ケースを3回実行する
bun run eval:view            # 結果をブラウザで見る
```

- Nodeは[.node-version](../../.node-version)の24.11.1を使う。APIキーは上記の`worker/.dev.vars.llm`の`OPENAI_API_KEY`を使う。`eval`ではLLM採点のためpromptfooも同じファイルを読み、`eval:smoke`ではWorkerだけが読む。ホットペッパーのキーは使わず、店舗は[合成店舗](../../worker/tooling/eval/shops/shop-sets.ts)だけを返す。実在店舗のデータを評価データに加えない。
- [評価用Worker](../../worker/wrangler.eval.jsonc)は本番のThreadDOを継承し、モデル・店舗供給・時計・turn結果の観測だけを差し替える。Providerが`wrangler dev --local`で起動し、デプロイしない。
- [評価ケース](../../worker/tooling/eval/promptfoo/cases)は[AIの振る舞い](../philosophy/ai-behavior.md)の条項ごとに置き、全ケースに共通する判定は[評価設定](../../worker/tooling/eval/promptfoo/promptfooconfig.yaml)の`defaultTest`に置く。
- 指標は2種類ある。「ゲート:」は[必須ゲート](../../worker/tooling/eval/promptfoo/assertions.ts)で、1つでも不合格ならケースを不合格にする。「スコア:」は[スコア](../../worker/tooling/eval/promptfoo/scores.ts)とLLM採点で、`weight: 0`として記録だけを行い合否には使わない。どちらも呼び出し順の完全一致は合否に使わない。
- 確定しない・場所を聞き返す・時間切れで打ち切られるなどのモデルの振る舞いはFAILとして採点する。モデル呼び出し自体の失敗（キー・通信・Provider障害）、設定で実行されなかった場合（`RUNTIME_UNCONFIGURED`）、案を適用できなかった場合、評価用Workerの起動失敗はERRORとして表示し、0件や不合格の結果として扱わない。
- 結果の`metadata.evalRun`に、ターンごとのTool呼び出し・引数・結果、step数、修復回数、確定の有無、トークン数、モデル呼び出しの所要時間が残る。
- promptfoo（[package.json](../../package.json)でバージョン固定）はテレメトリ・更新確認・共有を無効にして実行し、結果はローカルの`~/.promptfoo`に保存する。`promptfoo share`は使わない。
- `eval:smoke`は[smoke設定](../../worker/tooling/eval/promptfoo/promptfooconfig.smoke.yaml)と`--filter-metadata smoke=true`で既存ケースから現在地・位置情報拒否・地名優先・該当店なしの4件だけを選び、各1回、同時実行2で確認する。既存の必須ゲートとスコアを使い、LLM採点は行わない。1ケース内でモデルを複数回呼ぶことがあり、その利用料は発生する。

### 起動失敗の診断

起動待ちは既定120秒。失敗後は次のケースで起動し直すため、ケースごとに再待機が発生し得る。起動エラーが続く場合は評価を中断し、評価プロセスの停止を確認してから、`worker`ディレクトリで次を実行する。

```sh
bunx wrangler dev --config wrangler.eval.jsonc --env-file .dev.vars.llm --local --ip 127.0.0.1 --port 8791 --show-interactive-dev-session=false
```

評価結果には起動エラーの固定説明・エラーコード・終了コード・待機上限だけを返し、生のstderrは保存しない。診断出力は手元で確認し、promptfooの結果やIssueへ転載しない。確認後は手動起動したWorkerを停止してから評価を再実行する。

### 疎通結果の記録

`bun run eval:smoke`の後、`bun run eval:view`で4ケースの合否・ERROR・応答・Tool履歴・step・修復・トークン数・所要時間を確認する。実モデルでの確認はユーザーが手元で行い、実行日時・コミットSHA・結果・トークン数を[Issue #87](https://github.com/takapom/ima-app/issues/87)へ記録する。本文・座標・キーは転載しない。

モデルIDとreasoning effortは実行対象コミットの[OpenAI設定](../../worker/src/infrastructure/adapters/out/providers/openai/provider-config.ts)から手動記録する。設定上のIDは実際のモデルのsnapshot版の確認を意味せず、取得できなければsnapshot版は未確認とする。Providerは`cost`を返さないためUIに費用は表示されない。費用はOpenAI管理画面で確認した実額とし、今回の実行分を分離できなければ未確認とする。トークン数と公式料金表から計算する場合は、参照した料金表・計算条件とともに概算と記録する。現在の記録にはキャッシュ内訳がなく、請求額との一致は保証できない。

### 改善サイクルと採否の基準

1. 現行版の基準値を`--repeat 3`で取り、対象のIssueに記録する。記録は実行日時・コミット・モデル・ケース数・repeat・指標ごとの通過率・トークン数・費用とし、応答の本文・座標・キーは含めない。
2. 失敗したケースを読み、原因を分ける。判断の誤りはプロンプト、引数の拒否や修復はTool設計、step不足は予算や無駄な呼び出しを疑う。
3. 仮説を1つだけ立てて案を作る。システムプロンプトの案は評価設定の`prompts`にファイルを並べ、Toolのdescriptionの案は同じProviderを`label`と`toolDescriptionsFile`（`search_places`・`get_place_details`・`respond`をキーにしたJSON）を変えて並べる。
4. 現行版と案を、同じケース・同じrepeatで実行し、`bun run eval:view`で指標ごとに比べる。
5. 「ゲート:」の通過率がどれも現行版を下回らず、狙った「スコア:」が上がったときだけ採用する。ERRORが残る実行は比べずにやり直す。
6. 直した失敗を評価ケースに加え、本番ログ（`turn_outcome`・`respond_invalid`）で見つけた失敗の型も合成店舗で再現してケースに加える。

## 品質検査

| コマンド               | 検証するもの                                               |
| ---------------------- | ---------------------------------------------------------- |
| `bun run check`        | 変更パスに対応するゲートだけを選んで実行                   |
| `bun run format`       | Prettierによる整形                                         |
| `bun run docs`         | 文書の配置・行数と、相対リンク・見出しアンカーの実在       |
| `bun run lint`         | 型付きESLint、Hooks、500行制限、disable理由、違反fixture   |
| `bun run architecture` | 解決済み依存グラフ、manifest、公開exports、境界違反fixture |
| `bun run typecheck`    | 3 workspace、rootと関連toolingのTypeScript                 |
| `bun run test`         | 単体、App Integrity、Worker HTTP、実SDK/DO、開発用HTTP     |
| `bun run build`        | 各workspaceのbuild。Workerはdeploy dry-run                 |
| `bun run commit-size`  | 各コミットの追加＋削除行数                                 |

`bun run check`はstageした差分から必要なゲートを選ぶ。文書だけの変更はformatとdocs、mobileだけの変更はWorker poolを除いた範囲になる。ルート設定や未知のパスは全ゲートを選ぶ。`--all`で全ゲート、`--list`で選択結果だけを表示する。
段階ごとの実行は`test:unit`、`test:app-integrity`、`test:worker-http`、`test:runtime`を使う。
変更に応じた関連検査を実行し、実行していない検査を合格としない。型・lintの正確な設定は[tsconfig.base.json](../../tsconfig.base.json)、[ESLint設定](../../eslint.config.mjs)、[Prettier設定](../../.prettierrc.json)で管理する。
独自lintは既存の規則で検出できない違反がある場合に限って追加する。文書の配置は[check-doc-paths](../../scripts/check-doc-paths.mjs)が許可する入口に限る。
`.claude/skills/`と`.codex/skills/`のスキル資産はアプリ用の整形・lint・行数・disable理由検査から除外する。スキル文書は製品文書の行数上限を適用せず、配置・リンクを検査する。

手書きコード・テスト・設定は空行・コメント込み500行以内。Markdown、lockfile、明示した生成物はファイル行数制限から除外する。コミットの追加＋削除は文書・テスト・生成物も含め2,000行以内とし、必要な試験の切り離しや圧縮で回避しない。

[quality CI](../../.github/workflows/quality.yml)はmainへのpushで品質検査と各コミットの行数検査を実行する構成。[config dry-run CI](../../.github/workflows/config-dry-run.yml)はdev/staging/productionの設定を検査する。定義の存在を、GitHub上での成功や保護設定の証明にしない。
ローカルhookは補助であり、必要なら`git config core.hooksPath .githooks`で有効にする。hookは`commit-size`と`bun run check`を実行し、CIは全ゲートを実行する。

## 検証の使い分け

- Core/公開schemaの境界は単体試験、SDKの保存前制御・Tool限定・再送はWorker/DOの統合fixtureで検証する。
- `bun run test:runtime-native`は本番構成・HTTP・開発用HTTPを含むSDK検証。固定モデルやmock fetchの成功を実API成功に数えない。
- 実モデル・実店舗接続・実機・配布は[運用](../operations.md)の別ゲート。キー未設定や未測定を0件の成功へ変換しない。

## 文書の更新

製品要件は[製品仕様](../product.md)、ディレクトリ構成・責務・依存図は[アーキテクチャ](../architecture/architecture.md)、作業規則は[AGENTS.md](../../AGENTS.md)に置く。契約の形はschema、コマンドや設定の値はコードを参照し、同じ情報を複数文書で管理しない。
仕様を変えたときに該当文書を直接更新する。未決案・残件・進捗・変更理由はGitHub Issueとコミットへ残し、文書の連番や採択・上書き履歴は管理しない。
既存Issueの古い仕様や資料参照は現行文書と照合し、過去の本文が必要な場合だけGit履歴を読む。
