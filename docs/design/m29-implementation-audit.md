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

2026-09-11、`6eeaede` 時点。以下はIssueのClose判定ではなく、現在の実装状況である。

| 対象                 | 実装・証跡                                                                                                                                                                                                                                                                                              | 残件                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| #15 終電             | `52c85de`、`9519bc0`、`0e19ffd`。詳細取得、期限上限、再利用無効化部品、提出時刻での滞在時間再計算                                                                                                                                                                                                       | 本番factory接続。実データ未設定時はdisabled                              |
| #16 写真             | `711f707` ほか。認証付きHTTP、期限付きtoken、部分欠損、キャンセル後の発行抑止                                                                                                                                                                                                                           | 本番factoryとmobile画像表示への接続                                      |
| #17 保持・SDK        | `1635ed1`、`fd8acd3`、`c572582`、`e86e596`。用途別保持、固定05:00期限、複数turnのhistory/cardSet/evidence/原文、失敗・遅着拒否。`d5748aa` で本番Routes・origin・予算接続、`2e8aab3` で最終応答を1回予約・tools遮断。`3c9ee09`で参照復元・期限拒否、`dbca337`でSDK alarm/削除再試行、`029f3af`で保存監査 | 保存店参照のモデル接続、未監視保存面・実環境の削除遅延、既定Provider設定 |
| #18 画面基盤         | `f4835ea`、`45da9df`、`6f8e768`。画面・キーボード対応、native/Web依存                                                                                                                                                                                                                                   | safe-area、フォント・ライセンス・splash接続、実機・視覚比較              |
| #19 入力・条件       | `8f99074`。候補語、条件編集、取消・再送、保存条件の区別                                                                                                                                                                                                                                                 | 位置情報SDK・駅参照・APIへの接続                                         |
| #20 結果表示         | `58bf3df`、`1ec097b`、`6ea03ac`、`8a60978`、`ad9895a`。履歴・fact/推定/出典、表示中と復帰時の期限処理、時計巻戻し防止                                                                                                                                                                                   | 写真表示と操作、出典リンクの端末service接続                              |
| #21 決定・地図・共有 | `455dd99`、`31b10f0`。候補操作UI、取消・再提案と応答受信の状態遷移、古い非同期通知の抑止、RN地図/共有境界、地図利用policy                                                                                                                                                                               | SQLite/hapticsの実接続、地図座標resolver、実機操作の確認                 |
| #22 端末保存         | `ee37fdc`。実SQLiteのmigration・参照のみsnapshot、保存ID/サーバ参照分離、期限/破損/重複/削除、starredとdecidedAt分離                                                                                                                                                                                    | Expo SQLite接続、画面・APIへの保存/復元接続、実機再起動                  |
| #23 API接続          | `b088b7b`、`d12a6dd`、`0cf3773`、`04ff21a`。公開schema・認証・timeout/Abort、会話/履歴の世代制御、期限付き参照、App環境構成・画面/Hook接続、同一キーでの作成retry・取消/期限後の再作成拒否                                                                                                              | SecureStore・Expo SQLite、選択/並び順・保存参照発行、実HTTP接続          |
| #24 SDK/HTTP/DO統合  | 既存のM04〜M16各suite。`fc6f06c`でSDKエラー文字列の再送出を停止し、公開HTTP 502へ正規化。`e26a44b`で4領域対応表・0/2候補の実SDK応答                                                                                                                                                                     | 未監視保存面・SDK内部ログ、最新本番bootstrap/実アプリ接続の追加検証      |
| #25 Provider契約     | 各AdapterのHTTP Fixture試験、`d2635ff` の明示live smoke・未設定skip・固定エラー報告                                                                                                                                                                                                                     | suiteの要求対応、journey実データadapterのCLI接続、実API検証              |
| #26 モデル評価       | `07babb6`、`6829dc5`。14シナリオ×3反復の定義・評価ゲート、実Think/DOの明示live probe・trace/artifact                                                                                                                                                                                                    | 候補ID対応・複数turnのseed接続、42件の実モデル実行と人手評価             |
| #27 計測・flags      | `27b4553`。固定schema、実DO SQLite、厳密7日境界、書込み後alarm前倒し、HTTPイベント、実測/unknown別集計。`96b78bc`でfactory/写真HTTPの停止・Fixture隔離                                                                                                                                                  | 本番のtrace生成・障害観測、既定hostのRoutes/写真・Hot Pepper接続         |
| #28 App Integrity    | `6eeaede`。HTTP検証gate、nonce/key/counter境界、raw body・期限・取消・store障害、環境分離                                                                                                                                                                                                               | 実DO store・Apple verifier、nonce/enroll/revoke HTTP、native実機         |
| #29 環境統合         | `26e59ff`。3環境の設定、EAS profile/ID・HTTPS検証、秘密値を出さないpreflight、CI・runbook                                                                                                                                                                                                               | 既定hostのProvider構成、CI dry-run/手動deploy入口、実deploy/復旧の証跡   |
| #30 実機・MVP監査    | この対応表を作成中                                                                                                                                                                                                                                                                                      | 実アプリ→HTTP→実SDK→実APIの一連検証とスクリーンショット・ログ            |

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
- 2026-09-10 21:57–59 JST: #26評価基盤の17テスト、Worker source/tests/tooling型検査、対象lint/format合格。依存検査442 modules / 1,785 dependencies・Fixture31件合格。評価テストを通常suiteへ追加した。実モデルの品質検証は未実施。
- 2026-09-10 22:01–02 JST: #22のmobile/公開保持契約の18ファイル・109テスト、mobile/contracts型検査、対象lint/format合格。Node24の実SQLite試験であり、Expo SQLite・実機接続の証明ではない。
- 2026-09-10 22:19–25 JST: #17のguard/final/Think connection 4ファイル・26テスト、実SDK/DO 5ファイル・19テスト、Worker型3系統、対象lint/format合格。final-onlyのsearch/submitは副作用0、予算終了後はmodel call 0。既知guard失敗は型付き失敗へ変換し、未知SDK失敗の未処理ログ2件は残る。依存検査456 modules / 1,835 dependencies・Fixture31件合格。
- 2026-09-10 22:33–34 JST: #23のmobile/contracts 25ファイル・134テスト、mobile/contracts型検査、対象lint/format合格。全処理timeout、null相関拒否、同keyの別threadへ旧cancel/retryを適用しない回帰を含む。依存検査459 modules / 1,846 dependencies・Fixture31件合格。HTTP transportは注入fetch試験であり実Worker/実機接続は未実測。
- 2026-09-10 22:36–37 JST: #26の専用Worker poolはopt-outで7テスト合格・実モデル1件skip。Worker型3系統と対象lint/format合格。probeは新規検索3反復に限定し、カードの候補対応表がない間は未評価artifactを出力する。実モデル品質や全42件の検収を意味しない。
- 2026-09-10 22:50–55 JST: #17参照復元・削除・期限拒否を親レビュー後、native 6ファイル・23テスト、Worker型3系統、対象lint/format合格。復元後の候補除外、削除失敗後の再試行を含む。unknown SDK負例の未処理例外ログ2件は継続。親の依存検査は22:49時点466 modules / 1,877 dependencies・Fixture31件合格。alarm予約・15分遅延計測は別単位で継続。
- 2026-09-10 23:01–04 JST: #29 preflight/Expo設定11テストとmobile型、対象lint/format、依存475 modules / 1,906 dependencies・Fixture31件合格。外部buildのID/HTTPS欠損・不正を拒否し、環境値の自己申告だけでruntime接続済みと判定しない。Wrangler環境型生成はサブエージェント検証、実deploy/buildは未実施。env exampleはformatter未対応のため目視とdiffチェックで確認。
- 2026-09-10 23:14–19 JST: #23 API service 5ファイル・19テスト、mobile型、対象lint/format合格。read中の新turnがreadを無効化し、古いsnapshotによるrevision巻戻しやpending turnの無効化を防ぐ。端末storage待ち中の期限到来も拒否する。Hook/画面/Expo起動経路は次単位であり、この試験は実機接続の証明ではない。
- 2026-09-10 23:30–33 JST: 作業中変更を含む検証。Worker型3系統、運用gate等19テスト、依存488 modules / 1,951 dependencies・Fixture31件は合格。全体試験はNode 138ファイル・761テスト合格後、Workerの写真停止時HTTP応答の期待不一致1件で停止（38合格・1失敗）。別実行のalarm/contextは6合格・1失敗で、初回turn後のSQL canary検出を調査中。以降のruntime suiteは未実行であり、全体合格ではない。
- 2026-09-10 23:41–43 JST: #27停止gateは修正後、Node関連5ファイル・22テスト、Worker bootstrap/写真HTTP 2ファイル・4テスト、Worker型3系統、対象lint/format合格。写真token認可と停止応答の不一致は解消。`96b78bc`は追加＋削除943行。alarm導入中のnative回帰は別途修正中であり、全体合格とは扱わない。
- 2026-09-10 23:44–46 JST: #23 App/Hook接続の親検証はAPI/操作7ファイル・32テスト、mobile型、対象lint/format合格。環境の静的読取、productionのfixture拒否、切替後の旧処理抑止、idle会話を消さないcleanupを含む。mobile全25ファイル・142テストはサブエージェント検証。`0cf3773`は追加＋削除1,079行。実React renderer・実機・実WorkerへのHTTPは未実測。
- 2026-09-10 23:50–55 JST: #17は初期化順序の回帰を修正後、親のnative7ファイル・27テストと保存監査1ファイル・2テストが合格。Worker型3系統、対象lint/format合格。削除遅延5分はFixture時計による検証。保存前SQL triggerはCAS行数へ影響するthread_state/runtime_turnとFTSを除き、これらは保存後監査のみ。_cf_KV/_cf_METADATAは公開SQLで未観測。全保存面の保存前ゼロや本番の削除遅延保証とは扱わない。未知SDK負例の未処理例外ログ2件は#24で継続調査。
- 2026-09-11 00:01–05 JST: #24の親検証はnative 9ファイル・32テスト、Worker型3系統、対象lint/format合格。今回のnative実行では以前の未処理例外stackを観測しなかった。任意のSDK内部ログ全体の非漏出を証明するものではない。`fc6f06c`は追加＋削除78行。
- 2026-09-11 00:09–13 JST: #23作成retryは親のmobile/ID 4ファイル・25テスト、Worker HTTP/DO 3ファイル・8テスト、mobile/Worker型、対象lint/format合格。純粋snapshot変換の抽出後もHTTP/DOを再確認。`04ff21a`は539行。全体lint（検出Fixture22件）と依存498 modules / 1,992 dependencies・Fixture31件も合格（各実行時点の作業中変更を含む）。
- 2026-09-11 00:17–18 JST: 親の `bun run test` は全6suite、170ファイル・907テスト合格（Node 782、Worker 40、HTTP/mobile 22、Think 5、Think runtime 24、native 34）。実行時点の作業中変更を含む。以前の写真HTTP失敗とSDK未処理例外stackは今回再現しなかった。以後の変更は個別再検証する。
- 2026-09-11 00:21–22 JST: #24の2候補hero+altとHTTP fixture許可先制限の修正後、親native10ファイル・34テスト、Worker型3系統、対象lint/format合格。ローカルSDK alarmの数msの予約時刻不一致警告1件を観測したがテストは合格。実環境のalarm遅延保証の証拠ではない。`e26a44b`は543行。
- 2026-09-11 00:23–24 JST: #28 C1は親HTTP/gate/preflight 8ファイル・39テスト、Worker型3系統、対象lint/format合格。search/turnの正当assertion、同値JSONの空白改変拒否、遅延後の現在時刻・取消・store内部エラー非漏出を含む。注入verifier/storeでありApple実検証ではない。`6eeaede`は1,613行。
- この記録は全体テスト・ビルド・実機の最終合格を意味しない。以後の変更で再検証する。
- Web起動試行: Expo 57の既定設定ではMetroの `EMFILE: too many open files, watch` で失敗。既存Watchmanを有効化した再試行は `watch-project` が130秒超応答せず停止した。Web exportも同じ待機で停止。画面表示・Webビルドは未確認であり、起動成功とは扱わない。

## 外部検証に必要な前提

#30は[#36](https://github.com/takapom/ima-app/issues/36)の非本番実API検収に依存する。OpenAI、Google Places/Details/Routes/photosの設定・アカウント条件、iPhone開発ビルドの利用可否は未確認。キーの値を監査文書・チャットへ記録しない。

2026-09-10の初回ローカル調査では、実設定の`.dev.vars`/`.env`はなく、exampleのみ存在した。`26e59ff`でEAS profileを追加したが、実際のプロジェクトID・署名・配布先の設定を証明するものではない。実行環境のOpenAI・Google Places・Google Routes・APP_TOKENも未設定だった（値は出力せず有無だけ確認）。リモート環境の設定有無は別途確認が必要。

Expo位置情報・haptics・SQLite・SecureStoreの新規依存追加、およびlocalhost:8081へのHTTP確認は、承認ポリシーにより実行前に拒否された。ユーザーへ依存追加コマンドを案内済み。別経路で再試行しておらず、依存導入・Web接続確認の成功とは扱わない。

実モデル評価、実API成功、実機E2E、VoiceOver、文字拡大、キーボード、写真gesture、05:00境界・再起動、視覚比較は未実測。Webだけの表示確認で置き換えない。終電データが未検証の場合、disabledと明示条件下の候補確定拒否を試験する。
