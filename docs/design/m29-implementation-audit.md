# M29 / #30 内部MVP監査

この監査は実装・検証の証跡を対応付けるための作業中の記録である。表の未確認事項が残る間は #30 を完了扱いにしない。対象はユーザー指定の GitHub sub-issue #30 までであり、M30 / #31 のTestFlightリリースとは異なる。

## 境界と完了判定

- UIは `apps/mobile` の components、操作・状態は hooks/state、HTTP・端末I/Oは services が所有する。
- WorkerはSDK・Provider・永続化を組み立て、Coreは業務判断とPortを所有する。mobileからCore・Worker・evalをimportしない。
- コミットはmain上で各sub-issueへ紐付け、追加＋削除2,000行以内。手書きのコード・テスト・設定は1ファイル500行以内。
- 単体試験、実SDK/DOのFixture試験、実モデル、実店舗API、Web表示、iPhone実機は別の証跡とする。
- GitHubへ未反映のコミットや、実測していないゲートを合格扱いにしない。

根拠: [AGENTS.md](../../AGENTS.md)、[ADR0006](../adr/0006-lightweight-frontend-hexagonal-backend.md)、[ADR0012](../adr/0012-package-dependency-boundaries.md)、[#30](https://github.com/takapom/ima-app/issues/30)。

## 現在の実装と残件

2026-09-10、`6f8e768` 時点。以下はIssueのClose判定ではなく、現在の実装状況である。

| 対象                 | 実装・証跡                                                                                             | 残件                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| #15 終電             | `52c85de`。詳細取得、出典・確認期限・終電時刻による期限上限。`workers/api/tests/providers/last-train/` | 本番factory接続、dataset更新による再利用無効化、時刻更新後の再計算。実データ未設定時はdisabled |
| #16 写真             | `711f707` ほか。認証付きHTTP、期限付きtoken、部分欠損、キャンセル後の発行抑止                          | 本番factoryとmobile画像表示への接続                                                            |
| #17 保持・SDK        | `1635ed1`、`fd8acd3`。LLM利用許可を表示・保存許可から分離、Tool出力の既定拒否                          | SDKの実値到達試験、固定05:00期限と再生成、複数turn文脈、削除・復元、保存先canaryの統合検証     |
| #18 画面基盤         | `f4835ea`、`45da9df`、`6f8e768`。画面・キーボード対応、native/Web依存                                  | safe-area、フォント・ライセンス・splash接続、実機・視覚比較                                    |
| #19 入力・条件       | `8f99074`。候補語、条件編集、取消・再送、保存条件の区別                                                | 位置情報SDK・駅参照・APIへの接続                                                               |
| #20 結果表示         | `58bf3df`、`1ec097b`、`6ea03ac`。履歴と候補対応、fact/推定/出典表示                                    | 表示中・復帰時の期限処理、写真表示と操作、出典リンクの端末service接続                          |
| #21 決定・地図・共有 | 未実装                                                                                                 | 明示操作、保存/除外/復旧、端末services、Fake試験                                               |
| #22 端末保存         | 未実装                                                                                                 | SQLite migration、保存前・読取前失効、05:00、破損・重複・削除、保持Fixture                     |
| #23 API接続          | 応答JSON検証とstate適用の基礎あり                                                                      | HTTP/auth/Abort/timeout、操作接続、履歴切替・遅着、端末/サーバ復元の調停                       |
| #24 SDK/HTTP/DO統合  | 既存のM04〜M16各suiteあり                                                                              | 最新本番bootstrapで要求対応表と4領域回帰を統合                                                 |
| #25 Provider契約     | 各AdapterのHTTP Fixture試験あり                                                                        | suiteの要求対応、明示実行のlive smokeと未設定検出                                              |
| #26 モデル評価       | 未実装                                                                                                 | 12シナリオ以上×3回、結果・禁止動作、人手採点、時間・コスト測定                                 |
| #27 計測・flags      | 未実装                                                                                                 | 最小イベント、機密情報を含めないtrace、保持・削除、停止・復旧                                  |
| #28 App Integrity    | 未実装                                                                                                 | native/Worker互換性検証、nonce/enroll/assertion、replay・迂回防止、実機検証                    |
| #29 環境統合         | 基礎wrangler/CIあり                                                                                    | 環境・EAS・Secrets・preflight・runbookの統合、デプロイ/復旧の証跡                              |
| #30 実機・MVP監査    | この対応表を作成中                                                                                     | 実アプリ→HTTP→実SDK→実APIの一連検証とスクリーンショット・ログ                                  |

## 直近の検証記録

- 2026-09-10 15:34 JST: mobile、Worker tools、last-trainの関連16ファイル・94テスト合格。Worker/mobile型検査合格。
- 同変更のtools/last-trainとCandidateCard対象ESLint・Prettier合格。
- CandidateCardの `leaveBy` は「店を出る時刻」、`lastDepartureAt` は「終電発車」と表示。修正後の5テスト合格。
- 2026-09-10: 依存検査370 modules / 1,513 dependencies、検査Fixture31件合格。
- この記録は全体テスト・ビルド・実機の最終合格を意味しない。以後の変更で再検証する。
- Web起動試行: `expo start --web --localhost --port 8081` はMetroの `EMFILE: too many open files, watch` で失敗。Watchmanはインストール済みだが、Expo 57の既定設定がWatchmanを選択していない。修正後の再試験が必要。

## 外部検証に必要な前提

#30は[#36](https://github.com/takapom/ima-app/issues/36)の非本番実API検収に依存する。OpenAI、Google Places/Details/Routes/photosの設定・アカウント条件、iPhone開発ビルドの利用可否は未確認。キーの値を監査文書・チャットへ記録しない。

実モデル評価、実API成功、実機E2E、VoiceOver、文字拡大、キーボード、写真gesture、05:00境界・再起動、視覚比較は未実測。Webだけの表示確認で置き換えない。終電データが未検証の場合、disabledと明示条件下の候補確定拒否を試験する。
