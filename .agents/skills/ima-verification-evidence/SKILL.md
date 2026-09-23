---
name: ima-verification-evidence
description: ima-appの検証ゲートを判定し、合格の範囲と未測定項目を区別してIssueへ証跡を記録する。
---

# ima. 検証ゲートと証跡

検証結果を報告・記録するときに読む。固定データの成功を実接続の成功へ広げないことが目的。
コマンドと使い分けは[開発の品質方針](../../../docs/devlop/development.md#品質検査)、環境と配布は[運用](../../../docs/operations.md)に従う。

## ゲートと合格の定義

| ゲート        | 実行                                                                          | 合格が意味すること                     |
| ------------- | ----------------------------------------------------------------------------- | -------------------------------------- |
| 静的          | `bun run format` `docs` `lint` `architecture` `typecheck`                     | 整形・規約・依存境界・型               |
| 単体・契約    | `bun run test:unit`                                                           | Coreの判断と公開schemaの境界           |
| Worker統合    | `bun run test:app-integrity` `test:worker-http`                               | HTTP境界とApp Integrity                |
| SDK/DO統合    | `bun run test:runtime`                                                        | 本番構成・HTTP・開発fixtureでのSDK制御 |
| 実モデル      | `MODEL_EVAL_LIVE=1 bunx vitest run --config vitest.model-eval-live.config.ts` | 実モデルの応答。Providerは固定         |
| 実Provider    | [実LLMとホットペッパー起動](../../../docs/devlop/development.md)で会話を作成  | OpenAIとHot Pepperの実接続             |
| 環境preflight | `bun run env:preflight -- --target <env>`                                     | 設定値の形式と存在のみ                 |
| 実機・配布    | App Attest、EAS成果物、署名、利用条件、プライバシー公開                       | 各項目を個別に検収                     |

`bun run check` は変更パスから必要なゲートを選ぶ。選ばれなかったゲートを合格として報告しない。

## 合格に見えるが合格でないもの

- **preflightの`ready`（exit 0）は実接続ではない。** 値の形式と存在だけを見る。`partial`はexit 2、`blocked`はexit 1。
- **`runtimeVerified`と`releaseAllowed`は現行コードで常にfalse。** [environment-preflight](../../../scripts/environment-preflight.ts)と[release-preflight](../../../scripts/release-preflight.ts)を参照。変数を設定しても実行・配布の検収は完了しない。
- **`MODEL_EVAL_LIVE=0`はProvider呼出し前に停止する。** 実モデル成功に数えない。
- **`test:runtime`の固定モデル・mock fetchの成功は実API成功ではない。**
- **実接続はOpenAIとHot Pepperのみ。** 徒歩経路・終電は撤去済み（#55）。
- **キー・flagの設定は利用可能の証明ではない。** runtime factoryが停止flag・secret・用途別policyを確認する。
- **CIの定義の存在は、GitHub上の成功や保護設定の証明ではない。** push後CIはコミット前検証を代替しない。
- **認証失敗・0件・タイムアウトを成功へ補正しない。** 未測定は未測定として残す。

## 証跡の記録

進捗・完了状態・証跡はGitHub Issueで管理し、追跡ファイルへ書かない。実接続は[Issue #36](https://github.com/takapom/ima-app/issues/36)、配布は[Issue #31](https://github.com/takapom/ima-app/issues/31)。

記録する項目。

- 実行日時、対象環境・profile、モデル版、コミットSHA
- 実行したゲートと結果、公開schemaの応答
- 発生した費用
- 未測定・未実施の項目と、その理由

記録しない項目。

- モデル応答のraw本文、座標、token、secret、アカウントID

## 報告の規則

- 実行していないゲートを合格と報告しない。実行したコマンドと範囲を明示する。
- テスト件数の増減を検証の完了根拠にしない。ゲート単位で述べる。
- sub agentの完了報告をそのまま合格にしない。主担当が差分と結果を確認する。
- 自分の完了条件を別Issueへ移して合格にしない。未達は未達として残す。
