# M0〜M05 実装チェックポイント

2026-09-10更新。M0は作業準備、実装対象はM01〜M05（#2〜#6）。前提となるM31（#32）を含む。
**全スコープの完了報告ではない。** GitHubへのpush・CI・Issue完了判定は未完了。

## 最新状況（2026-09-10 03:11 JST）

M03のCoreはコミット・ローカル検証済み。M04は全162テストと品質検査を通過し、
[ADR0014](../adr/0014-think-runtime-adoption.md)で制御付きThinkを採用した。
M05とM06〜M10の本体実装は未完了。[現在の実装順](m06-m10-progress.md)を参照。
以下は各時点の作業記録であり、古い未完了記載はこの最新状況へ読み替える。

## mainへローカルコミット済み

| 対象      | 成果物                                                                          | 主なコミット                               | 残る検収                                                               |
| --------- | ------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| M0        | main作業・sub-issue紐づけ・2,000行制限・PMレビュー規則                          | `3f339da`                                  | GitHub反映                                                             |
| M01 / #2  | [実装基準](implementation-baseline.md)と要求対応表                              | `9bdd356`                                  | GitHub反映・Issue検収                                                  |
| M31 / #32 | Provider利用・保持・能力の仕様と期待値Fixture                                   | `0b052b6`                                  | GitHub反映。アカウント依存の許諾・live実測はM35                        |
| M02 / #3  | 5 workspace、Expo/Worker起動、品質ゲート、CI設定、違反Fixture、コミット行数検査 | `6d21298`、`a48225c`、`207eb28`、`96e5835` | 新規cloneの再現、push後CI、保護設定検収                                |
| M03 / #4  | 公開値・保持・エラー・HTTP・描画・再配送のValibot契約                           | `1d76e07`、`0e44ba0`                       | Core契約の依存導入・通常品質検査・コミット、最終SDK境界との整合        |
| M04 / #5  | 初期SDK調査とレビュー記録、公開DTO→mobile service/state                         | `9a43bda`、`57071f5`、`3597fc7`、`c4ae092` | 必須ゲート統合、Worker内Fixtureの正式配置・依存固定・通常検査、採用ADR |
| M05 / #6  | 未着手                                                                          | —                                          | M03と選定SDKのM04必須ゲート合格後に着手                                |

コミットは追加＋削除2,000行以内で個別検査している。文書・lockfile・テストも計上する。
未pushの成果をGitHub反映済みと扱わず、途中のコミットに自動Close指定は付けていない。

## Core依存導入後の確認（2026-09-10）

ユーザーによる `bun install --ignore-scripts --no-progress` 完了後、通常の依存解決を確認した。
以下の「未コミットのCore」は9月9日時点の履歴であり、依存導入とCoreコミットの阻害は解消済み。

- `132652b`（#4）: Core source・13テスト・manifest・完全なlockfileをまとめてコミット。追加＋削除1,978行。
- `3a9f38a`（#4）: Coreと公開契約の対応・具体JSON。追加＋削除201行。
- `6a2a7f0`（#4）: 公開生成文のsession期限継承を修正。追加10行。
- 主担当の通常検証: 全workspace typecheck、単体67テスト＋Worker3テスト、lint、依存境界、Core formatが成功。
- M04のSDK適合性、M05、M06〜M10の後続実装は未完了。SDK採用の成功を先取りしない。

## 9月9日時点の未コミットCore（履歴）

`packages/core/src/domain`、`ports`、`application`と公開入口、manifest、
[契約文書](contracts-v1.md)のCore追記が作業ツリーにある。

- SDK非依存の観測・根拠・保持・結果、3操作、Harness/モデル向けcontext、submit入出力のschemaとPortを定義。
- Harnessからモデルへの投影は生座標とowner scopeを除外し、位置の精度・取得時刻を保持する。
- 予算切れ・キャンセル・古いturnは修正不能。詳細応答は要求candidate/fieldと照合する。
- Coreの隔離型検査、13テスト、文書JSONのschema検証1件、Prettier、500行検査を確認済み。
- 隔離検査は既存Valibotをテスト用aliasで参照した結果。通常workspaceの依存解決・CI成功を意味しない。

`packages/core/package.json`に`valibot@1.4.2`を追加済みだが、導入コマンドが拒否され、
`bun.lock`と通常の依存リンクは未更新。manifestだけを不完全なlockfileとコミットしない。
拒否後に作られた依存リンクは撤去済み。インストールの代替としてリンクやlockfileの手編集を使わない。

## M04の検証範囲

詳細は[Runtime適合性記録](runtime-compatibility.md)。実Worker/DO、実SDK、scripted modelと
業務Port stubを使う。実モデルの品質、実Providerの許諾・応答、本番の削除遅延は未実測。

一時検証ファイルは次のローカルディレクトリにある。新規cloneで再現できる正式配置ではない。

- `/tmp/ima-m04-spike`: Think、保存前制御、step検査、native loop、保持・復旧。
- `/tmp/ima-m04-contract-gate`: 実Core公開schemaとAI SDKのTool/final境界。
- `/tmp/ima-m04-http-mobile-gate`: Worker内DTO変換→HTTP→mobileの限定接続。

個別テストの合格を採用条件全体の合格にしない。特に、最終wire形式の統一、未知payloadの保存前除去、
複数turnの履歴期限、同じ観測・保持ポリシーからのDTO変換、同一構成での全必須ケース検証を確認する。
不十分なFixtureの成功報告はPMレビューで差し戻している。

## 続行に必要な環境と手順

Nodeは`24.11.1`、Bunは`1.3.8`を使用する。通常のNode 25ではdependency-cruiserの対応条件を外れる。

1. 拒否された依存導入を実行できる環境で、リポジトリ直下の`bun install --ignore-scripts --no-progress`を実行する。
2. 完全なlockfile差分を確認し、Coreの通常型・lint・依存・関連テストを実行。責務単位で2,000行以内にコミットする。
3. M04 Fixtureを同一構成へ統合し、選定候補の必須ゲートと通常品質検査を完了させる。未合格のまま採用ADRを作らない。
4. M05をsub-agentへ委託し、HTTP入力、認証・所有権、rate limit、エラー変換をstub handlerで検証する。
5. 各コミットの行数を再確認してmainへpushし、CI・保護設定・Issueの完了条件を検収する。

この実行環境では依存導入、fetch/push、保護設定確認が自動承認レビューに拒否された。
返却理由は`approval required by policy, but AskForApproval is set to Never`。
一方、既存依存でのWorkers Vitest、Worker dry-run、Expo iOS exportは実行できている。
コマンド単位の拒否を、ローカルSDK実行全体が不可能という意味に拡大しない。
