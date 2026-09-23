# 環境・検証・配布・復旧

## 設定の入口

ローカルの固定データ起動は[開発](devlop/development.md#apiキー不要のローカル起動)を参照する。
実環境の設定名と安全な初期値は[.dev.vars.example](../.dev.vars.example)、[.env.example](../.env.example)、[mobile環境例](../apps/mobile/.env.example)、[Wrangler設定](../worker/wrangler.jsonc)、[EAS設定](../apps/mobile/eas.json)で管理する。
実secret、アカウントID、署名資格は追跡ファイルやコマンド引数へ書かない。Worker secretを端末の公開環境変数へ入れない。

| 区分           | 必要な設定・確認                                                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker         | `IMA_ENV`、`IMA_RUNTIME_MODE`、`APP_TOKEN`、対象環境のDO binding/migration                                                                                                                            |
| モデル         | `OPENAI_API_KEY`。モデル名とProvider optionsは[model設定](../worker/src/adapters/out/providers/openai/provider-config.ts)と[options](../worker/src/adapters/out/providers/openai/provider-options.ts) |
| 店舗検索・詳細 | `HOTPEPPER_API_KEY`、`PLACES_CURSOR_SECRET`                                                                                                                                                           |
| 端末・配布     | HTTPS endpoint、実bundle ID、EAS project、Apple署名、App Attest                                                                                                                                       |
| 有効化         | Provider flags、用途別policy、実アカウント・API・課金・許諾の検収                                                                                                                                     |

キーやflagだけで利用可能と判定しない。runtime factoryはモデル・ホットペッパーの停止flagとsecret、用途別policyを確認する。詳細は[アーキテクチャ](architecture/architecture.md)と[Providerポリシー](provider-policy.md)を参照する。

## preflightと配布判定

以下はローカル設定の形式を検査する例であり、Workerを起動しない。

```sh
IMA_ENV=dev IMA_RUNTIME_MODE=fixture APP_TOKEN=local-only-token \
EXPO_PUBLIC_API_BASE_URL=http://localhost:8787 \
bun run env:preflight -- --target dev
```

実環境の設定を秘密管理から渡したうえで、対象を明示する。

```sh
IMA_PREFLIGHT_BUILD=1 bun run env:preflight -- --target staging
IMA_PREFLIGHT_DEPLOY=1 bun run env:preflight -- --target staging
bun scripts/release-preflight.ts --track internal
bun scripts/release-preflight.ts --track external
```

`IMA_ENV`も対象に一致させる。環境preflightの終了コードは`0=ready`、`1=blocked`、`2=partial/unverified`。`ready`は値の形式・存在を示すだけで、実アカウント・API・署名の成功ではない。
[environment-preflight](../scripts/environment-preflight.ts)の`runtimeVerified`と[release-preflight](../scripts/release-preflight.ts)の`releaseAllowed`は現行コードでfalse。変数を設定するだけでは実行・配布の検収を完了できない。

外部配布はApp Attest、実機、EAS成果物、署名、Provider利用条件、検証済み終電データ、プライバシー公開、限定品質範囲を別々に検収する。知人への招待も明示的な許可を必要とする。進捗・証跡は[配布Issue](https://github.com/takapom/ima-app/issues/31)へ記録する。

## 実Provider検証

### 自分のiPhoneだけで使う個人検証

Appleの無料Personal TeamではApp Attestを利用できない（[対応Capability](https://developer.apple.com/help/account/reference/supported-capabilities-ios)）。自分の端末へローカル署名して入れる場合だけ、stagingの`IMA_PERSONAL_PREVIEW=true`を明示してApp Attestなしの認証を許可する。既定はfalseで、productionではこの値を指定しても例外を認めない。これは外部配布の検収ではなく、既存の配布preflightも合格扱いにしない。

このモードの認証はAPP_TOKENの所持に依存し、正規アプリ・実機であることは証明しない。64桁の小文字16進トークンが必須で、通常のowner credential認証・所有者分離は維持する。個人検証中はアプリ独自の端末ごと30回/時・ownerごと100回/時の制限を適用しない。通常のstaging・productionではこの制限を維持し、個人検証でも1ターンの処理予算・タイムアウトと外部Provider側の制限は変えない。APP_TOKENを知る人は新しいownerとして利用できるため、本人だけで管理する。

1. `openssl rand -hex 32 | pbcopy`で生成したAPP_TOKENをパスワード管理へ保存し、`bunx wrangler secret put APP_TOKEN --config worker/wrangler.jsonc --env staging`の対話入力で登録する。すでに同じ形式で登録済みなら再生成しない。`OPENAI_API_KEY`、`HOTPEPPER_API_KEY`、`PLACES_CURSOR_SECRET`もstagingのsecretに必要。
2. リポジトリ直下で次を実行し、個人検証用stagingを有効化する。先に同じコマンドへ`--dry-run`を付けてbundle・bindingを確認する。実行後の検索はOpenAIとHot Pepperへ接続する。

```sh
bunx wrangler deploy --config worker/wrangler.jsonc --env staging \
  --var IMA_PERSONAL_PREVIEW:true \
  --var IMA_RUNTIME_MODE:live \
  --var IMA_PROVIDER_OPENAI:true \
  --var IMA_PROVIDER_HOTPEPPER:true \
  --var IMA_RUNTIME_FLAGS_CONNECTED:1
```

3. `apps/mobile`で以下を実行する。接続先とbundle IDは自分の値に置き換える。`EXPO_NO_DOTENV=1`で開発用`.env.local`を読み込まず、fixtureの認証情報はシェル環境からも除く。APP_TOKENやProviderのキーをビルドへ渡さない。

```sh
env -u EXPO_PUBLIC_FIXTURE_APP_TOKEN \
  -u EXPO_PUBLIC_FIXTURE_DEVICE_ID \
  -u EXPO_PUBLIC_FIXTURE_OWNER_CREDENTIAL \
  EXPO_NO_DOTENV=1 \
  EXPO_PUBLIC_PERSONAL_PREVIEW=true \
  EXPO_PUBLIC_ENVIRONMENT=staging \
  EXPO_PUBLIC_API_MODE=live \
  EXPO_PUBLIC_API_BASE_URL=https://your-worker.your-subdomain.workers.dev \
  EXPO_PUBLIC_APP_VERSION=0.0.0 \
  EXPO_IOS_BUNDLE_IDENTIFIER=com.example.ima \
  bunx expo run:ios --device --configuration Release
```

4. 起動時の「検証用の接続設定」でAPP_TOKENを入力する。既存のSecureStoreへ端末限定で保存し、owner credentialとdevice IDは端末で生成する。トークン変更は「接続設定」から行う。同じ端末・接続先でのトークン変更はownerとSQLiteの保存先を維持し、認証レコードが消えた場合は新しい保存先を割り当てる。秘密値は画面・ログ・公開環境変数へ再表示しない。
5. Wi-FiとUSBを切り、Macを停止して携帯回線で新しい検索を実行する。ReleaseにはJSが同梱されるためMetroは不要だが、検索にはインターネット接続が必要。無料署名の期限が切れたら再ビルドする（[Appleアカウントの制限](https://developer.apple.com/help/account/basics/about-your-developer-account)）。

停止する場合は、上の`--var`を付けずに通常の`--env staging`デプロイを行う。追跡設定の`IMA_PERSONAL_PREVIEW=false`・runtime disabled・Provider停止へ戻る。通常デプロイは個人検証用の上書きを維持しない。

### ローカルでの実接続

[実LLMとホットペッパーのローカル起動](devlop/development.md#実llmとホットペッパーでのローカル起動)で新しい会話を作り、検索・カード表示・条件変更を実行する。APIの認証失敗・0件・タイムアウトを成功へ補正しない。外部接続はOpenAIとホットペッパーであり、写真・経路・終電は無効。旧Google用のlive smoke runnerは削除済み。

実行日時、対象profile、モデル版、公開schemaの結果、費用、未測定項目を[実接続Issue](https://github.com/takapom/ima-app/issues/36)へ記録する。raw本文・座標・token・secretは証跡へ含めない。

## 実モデル評価

通常のテストとは別の専用poolを使う。`OPENAI_API_KEY`を秘密管理から渡し、有料実行を明示するときだけ次を実行する。

```sh
MODEL_EVAL_LIVE=1 bunx vitest run --config vitest.model-eval-live.config.ts
```

[評価runner](../worker/tests/model-eval-live)は実モデル＋固定Providerを使うため、実店舗APIの検収ではない。`MODEL_EVAL_LIVE=0`はProvider呼出し前に停止する検証経路であり、実モデル成功に数えない。
profile・反復・候補identity対応・人手レビューのcoverageを確認する。候補対応の欠落、不正response、未計測費用は未評価または失敗として残し、0や成功で補わない。

## 撤去済みのDO

終電dataset用の`JourneyDatasetDO`と管理入口`/internal/m14/last-train`は撤去した（#55）。[Wrangler設定](../worker/wrangler.jsonc)のmigration `v7`が`deleted_classes`でクラスを削除し、デプロイ時に保存済みのdatasetも消える。デプロイ前にdry-runで対象環境のmigrationを確認する。

## デプロイと復旧

[config dry-run CI](../.github/workflows/config-dry-run.yml)は型生成・bundle・設定・migrationを検査する。Cloudflareへの反映や実リソースの検収は行わない。

実デプロイ時は次の順序で進める。

1. 対象account・Worker・route・DO migration・secretを確認し、preflightと実接続の不足を解消する。
2. 対象環境を明示してWranglerの型生成・deploy dry-runを行い、差分をレビューする。
3. stagingへ反映し、health、認証拒否、owner分離、Provider、保存期限を確認する。
4. 実機・App Attest・利用条件・停止操作の証跡を確認してからproductionを扱う。

EASはdevelopment（Simulator/Dev Client）、internal（staging）、external（production）のprofileを使う。build時のbundle ID・project ID・endpointが欠ければ拒否する。profileの存在を署名や実機成功の証明にしない。

障害時は[flags](../worker/src/composition/operational-flags.ts)の対象Providerを停止し、必要なら`IMA_KILL_SWITCH=true`を適用する。未指定・不正なProvider flagは停止側。不正なkill switchは停止側だが、未指定のkill switchはfalseという互換既定があるため、環境設定に明示する。
停止後に実際の外部呼出し停止を確認し、fixtureへ暗黙に切り替えない。

復旧では対象環境のWorker version履歴から既知の版へ戻し、health、認証、DO migration互換性、保存期限、Provider停止状態を再確認する。DOを手作業で削除して復旧扱いにせず、データ変更が必要なら後方互換migrationを検証する。
EASは問題のbuild配布を停止し、利用可能なprofile/versionを記録する。復旧後はProviderを一つずつ再開する。

## 観測と証拠の範囲

TelemetryDOは固定イベント・集計を扱い、7日で期限処理する。記録失敗を検索処理の成功に偽装せず、テレメトリ障害とプロダクトの再試行を分ける。
Cloudflareのplatform invocation logやAI Gatewayの本文ログは別の保存面。TelemetryDOの削除を根拠に全ログの削除を保証しない。
SDKの未使用機能を有効化する場合は、SQL、公開KV、live cache、履歴、stream、compaction、ログの保存前制御を再検証する。保存後に本文が消えたことだけでは、書込み禁止の証明にならない。
