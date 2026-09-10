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

2026-09-10、`d5748aa` 時点。以下はIssueのClose判定ではなく、現在の実装状況である。

| 対象                 | 実装・証跡                                                                                                                                                                 | 残件                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| #15 終電             | `52c85de`、`9519bc0`、`0e19ffd`。詳細取得、期限上限、再利用無効化部品、提出時刻での滞在時間再計算                                                                          | 本番factory接続。実データ未設定時はdisabled                                           |
| #16 写真             | `711f707` ほか。認証付きHTTP、期限付きtoken、部分欠損、キャンセル後の発行抑止                                                                                              | 本番factoryとmobile画像表示への接続                                                   |
| #17 保持・SDK        | `1635ed1`、`fd8acd3`、`c572582`、`e86e596`。用途別保持、固定05:00期限、複数turnのhistory/cardSet/evidence/原文、失敗・遅着拒否。`d5748aa` で本番Routes・origin・予算を接続 | 保存店参照のモデル接続、削除・文脈復元、保存先全体canary、最終回答予約、環境flags接続 |
| #18 画面基盤         | `f4835ea`、`45da9df`、`6f8e768`。画面・キーボード対応、native/Web依存                                                                                                      | safe-area、フォント・ライセンス・splash接続、実機・視覚比較                           |
| #19 入力・条件       | `8f99074`。候補語、条件編集、取消・再送、保存条件の区別                                                                                                                    | 位置情報SDK・駅参照・APIへの接続                                                      |
| #20 結果表示         | `58bf3df`、`1ec097b`、`6ea03ac`、`8a60978`、`ad9895a`。履歴・fact/推定/出典、表示中と復帰時の期限処理、時計巻戻し防止                                                      | 写真表示と操作、出典リンクの端末service接続                                           |
| #21 決定・地図・共有 | `455dd99`、`31b10f0`。候補操作UI、取消・再提案と応答受信の状態遷移、古い非同期通知の抑止、RN地図/共有境界、地図利用policy                                                  | SQLite/hapticsの実接続、地図座標resolver、実機操作の確認                              |
| #22 端末保存         | 未実装                                                                                                                                                                     | SQLite migration、保存前・読取前失効、05:00、破損・重複・削除、保持Fixture            |
| #23 API接続          | 応答JSON検証とstate適用の基礎あり                                                                                                                                          | HTTP/auth/Abort/timeout、操作接続、履歴切替・遅着、端末/サーバ復元の調停              |
| #24 SDK/HTTP/DO統合  | 既存のM04〜M16各suiteあり                                                                                                                                                  | 最新本番bootstrapで要求対応表と4領域回帰を統合                                        |
| #25 Provider契約     | 各AdapterのHTTP Fixture試験、`d2635ff` の明示live smoke・未設定skip・固定エラー報告                                                                                        | suiteの要求対応、journey実データadapterのCLI接続、実API検証                           |
| #26 モデル評価       | 未実装                                                                                                                                                                     | 12シナリオ以上×3回、結果・禁止動作、人手採点、時間・コスト測定                        |
| #27 計測・flags      | `27b4553`。固定schema、実DO SQLite、厳密7日境界、書込み後alarm前倒し、HTTPイベント、実測/unknown別集計、flags契約                                                          | 本番のtrace生成・flagsによる呼出し停止・障害観測の接続                                |
| #28 App Integrity    | 未実装                                                                                                                                                                     | native/Worker互換性検証、nonce/enroll/assertion、replay・迂回防止、実機検証           |
| #29 環境統合         | 基礎wrangler/CIあり                                                                                                                                                        | 環境・EAS・Secrets・preflight・runbookの統合、デプロイ/復旧の証跡                     |
| #30 実機・MVP監査    | この対応表を作成中                                                                                                                                                         | 実アプリ→HTTP→実SDK→実APIの一連検証とスクリーンショット・ログ                         |

## 直近の検証記録

- 2026-09-10 15:34 JST: mobile、Worker tools、last-trainの関連16ファイル・94テスト合格。Worker/mobile型検査合格。
- 同変更のtools/last-trainとCandidateCard対象ESLint・Prettier合格。
- CandidateCardの `leaveBy` は「店を出る時刻」、`lastDepartureAt` は「終電発車」と表示。修正後の5テスト合格。
- 2026-09-10: 依存検査370 modules / 1,513 dependencies、検査Fixture31件合格。
- 2026-09-10 16:15 JST: mobile 9ファイル・53テスト、型検査、ESLint、Prettier合格。
- 2026-09-10 16:17 JST: `test:runtime` 全4suite合格（HTTP/mobile 22、Think 5、Think runtime 24、native SDK/DO 15、計66テスト）。旧state.messages参照による失敗を公開selectorへ修正後に再検証した。native負例で `UPSTREAM_UNAVAILABLE` の未処理例外ログが出ており、#24で失敗処理を確認する。
- 2026-09-10 16:29 JST: mobile 72テスト・型・lint/format合格。Core/終電の関連104テストに加え、追加の時計境界を含むport 9テスト合格。Core/Worker source・testsの型検査合格。
- 2026-09-10 16:46–47 JST: production factory/context、実Think/DO multi-turnの親検証合格。候補を維持する追質問では追加検索せず、予算変更で候補集合を置換する。cancelはcontext単体では非Response値としてモデル化しており、実取消との統合は#24で確認する。
- 2026-09-10 16:48 JST: `bun run test` 全6suite、135ファイル・735テスト合格（Node 636、Worker 32、HTTP/mobile 22、Think 5、Think runtime 24、native 16）。実行時点の作業中変更も含む。未処理例外ログの負例3件は引き続き記録されており、テスト合格だけで解決扱いにしない。
- 2026-09-10 17:23–26 JST: telemetry単体6、実DO/HTTP bootstrap計10テスト合格。Worker source/testsの型検査、変更対象lint/format、依存検査409 modules / 1,674 dependencies・Fixture31件合格。Provider接続の作業中型エラーは解消後に再検査した。
- 2026-09-10 17:30–33 JST: mobile全14ファイル・89テスト、型検査、lint/format合格。外部応答はpayloadを複製せず状態だけsettleし、取消後の応答では取消状態を解除しない。実React hook rendererと端末Share/Linking操作は未実測であり、純粋state/service試験と区別する。
- 2026-09-10 21:35–37 JST: Provider 26ファイル・173テスト、本番runtime/Provider構成/attempt signal 7ファイル・22テスト、Worker source/tests/tooling型検査、対象lint/format、依存検査431 modules / 1,745 dependencies・Fixture31件合格。smoke CLIは明示liveなし・空環境の両方でexit 2、空環境は外部呼出し0件を確認した。実API成功の証拠ではない。
- 2026-09-10 21:41–42 JST: `bun run test` 全6suite、145ファイル・789テスト合格（Node 683、Worker 39、HTTP/mobile 22、Think 5、Think runtime 24、native 16）。実行時点の作業中変更を含む。native負例の未処理 `UPSTREAM_UNAVAILABLE` ログ3件は継続しており、#24で調査する。
- この記録は全体テスト・ビルド・実機の最終合格を意味しない。以後の変更で再検証する。
- Web起動試行: Expo 57の既定設定ではMetroの `EMFILE: too many open files, watch` で失敗。既存Watchmanを有効化した再試行は `watch-project` が130秒超応答せず停止した。Web exportも同じ待機で停止。画面表示・Webビルドは未確認であり、起動成功とは扱わない。

## 外部検証に必要な前提

#30は[#36](https://github.com/takapom/ima-app/issues/36)の非本番実API検収に依存する。OpenAI、Google Places/Details/Routes/photosの設定・アカウント条件、iPhone開発ビルドの利用可否は未確認。キーの値を監査文書・チャットへ記録しない。

2026-09-10のローカル調査では、実設定の`.dev.vars`/`.env`/`eas.json`はなく、exampleのみ存在した。実行環境のOpenAI・Google Places・Google Routes・APP_TOKENも未設定だった（値は出力せず有無だけ確認）。リモート環境の設定有無は別途確認が必要。

Expo位置情報・haptics・SQLite・SecureStoreの新規依存追加、およびlocalhost:8081へのHTTP確認は、承認ポリシーにより実行前に拒否された。ユーザーへ依存追加コマンドを案内済み。別経路で再試行しておらず、依存導入・Web接続確認の成功とは扱わない。

実モデル評価、実API成功、実機E2E、VoiceOver、文字拡大、キーボード、写真gesture、05:00境界・再起動、視覚比較は未実測。Webだけの表示確認で置き換えない。終電データが未検証の場合、disabledと明示条件下の候補確定拒否を試験する。
