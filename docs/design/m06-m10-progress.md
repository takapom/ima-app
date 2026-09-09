# M06〜M10 実装チェックポイント

2026-09-10。対象はM06〜M10（#7〜#11）。本書は完了報告ではない。

## 現在の状態

- M04用のBun依存導入とlockfileコミットは完了。M05〜M10用の実行時依存への移動とOpenAI Provider 3.0.69追加はmanifest更新済み、lockfile同期待ち。
- M03の公開契約・Core契約は実装・ローカル検証済み。#4はGitHub反映・完了処理が残る。
- M04の共通Think構成は24テストを通過し、[ADR0014](../adr/0014-think-runtime-adoption.md)で採用を決定した。
- M04完了時点の全162テスト、workspace型検査、lint、format、依存境界31ケース、Worker dry-run、Expo iOS exportが成功。
- M05のHTTP入力・認証・公開エラー境界を`d4ee8a0`（#6、677行）にコミット。親レビュー、関連5テスト、Worker型検査、対象lint/format、依存境界検査を通過。
- M05の公開14経路・所有権確認への委譲・入力出力検証・エラー変換を`4564996`（#6、1,379行）にコミット。親がHTTPの12テスト、Worker型検査、対象lint/formatを確認。DOの所有権Adapter・bootstrap・SELF接続は次単位。
- M06の候補・不変観測・鮮度照合を`05e0717`（#7、1,288行）にコミット。親レビュー、Core/evalの25テスト、両package型検査、対象lint/format、依存境界31ケースを通過。保存参照・表示順・非known項目の保持は後続単位。
- M09の純粋検証・観測由来カード組立を`984cd3d`（#10、1,992行）にコミット。親が関連16テスト、Core型検査、対象lint/format、依存境界31ケースを確認。CommitPort・競合/再送試験は実装中。
- M05のThink継承ThreadDO・bootstrapを`955a630`（#6、1,310行）にコミット。親が実Worker 9テスト、Worker型検査、対象lint/formatを確認。更新後のdry-runは拒否され未検証。詳細は[HTTP境界記録](m05-http-boundary.md)。
- M06の保存/過去候補・表示順・非known項目と再利用失効を`f974049`（#7、1,742行）にコミット。親が関連24テスト、Core/eval型検査、対象lint/format、依存境界31ケースを確認。
- M09のCommitPort・Application確定・既存submit Port接続・eval CASを`dc89215`（#10、1,507行）にコミット。親が関連31テスト、Core/eval型検査、対象lint/format、依存境界31ケースを確認。指定観測IDの失効確認と遅着時のephemeral response破棄も含む。
- M10の予算予約・重複実行防止・混在バッチ検証を`c200fcf`（#11、918行）にコミット。親が既存runtime-gateを含む53テスト（新規16）、Worker型検査、対象lint/format、依存境界31ケースを確認。timeout/retry executorとThink接続は後続単位。
- 追加の親回帰確認でAIChat比較用mobile-replayシナリオが一度HTTP 422になった。再実行では既存SDKゲート51テスト（AIChat 22、Think公開5、Think実行24）すべて成功。原因特定・コード修正済みとは扱わず、native接続後に最終検査する。
- M08のCore文脈・共通鮮度・原文引用に基づく条件更新を`877eef1`（#9、1,258行）にコミット。親がCore関連15テスト、型検査、対象lint/format、依存境界31ケースを確認。M07未完のため、既存Core契約とFixtureで独立した文脈投影の範囲として先行。SDK Provider接続の完了とは区別する。
- M08のWorker SDK形式変換・system指針・キー設定を`77d6535`（#9、359行）にコミット。親がmodel9テスト、Worker本体型検査、対象lint/formatを確認。検査時のtests全体型検査はM07編集中テストに1件エラーが残り、統合時に再検査する。Provider導入・実通信は未完。
- M09の冗長なスキーマpipeを`0e3d90c`（#10、26行）で除去。親がsubmit Port 6テスト、Core型検査、対象lint/formatを確認。
- M10のread executor・残時間timeout・Retry-After・取消/旧turn遅着拒否を`b32eb62`（#11、731行）にコミット。親が関連27テスト、Worker全体tests型検査、対象lint/format、依存境界31ケースを確認。先に記録したM07編集中の型エラーはこの時点で解消。実Think factoryとの接続は次単位。
- M07の登録観測に基づくモデル安全投影を`cca3d7c`（#8、1,068行）、3ツールのschema/envelope・認可・Port接続を`1120b63`（#8、1,673行）にコミット。親が全tools27テスト、Worker全体tests型検査、対象lint/format、依存境界31ケースを確認。
- M10のモデル予算・全stepの副作用前検証・期限Abortを`b75233f`（#11、902行）にコミット。親が関連29テスト、Worker全体tests型検査、対象lint/format、依存境界31ケースを確認。
- M10の保存前本文制御・現turnの期限付きTool根拠復元を`6f9316e`（#11、1,926行）にコミット。親が関連12テスト、Worker全体tests型検査、対象lint/formatを確認。SDK user本文は現turnも再利用せず、Core投影後の文脈を別途注入する。
- M10のターンfactory・安定call ID・条件snapshot・Abort/disposeを`fefb1cf`（#11、782行）にコミット。親が関連6テスト、Worker全体tests型検査、対象lint/formatを確認。read Portの実予算接続とThink/DOへの組込は別単位で実装中。
- M10の最終JSON検証・Core確定応答からの公開DTO構築を`b838b02`（#11、845行）にコミット。親が関連7テストと対象lint/formatを確認。モデル出力のカード本文を公開応答へ直接流さない。
- M10の検証済み最終テキスト受渡しを`039283d`（#11、81行）、HTTP中断から対象turnへの取消dispatchを`6988c52`（#11、248行）にコミット。親がそれぞれ18・6テストと対象lint/formatを確認。DOへの組込は未完。
- M08のResponses設定と最終JSON形式を`b2fd345`（#9、59行）、M07のread完了時刻に基づく鮮度判定を`db7b9a3`（#8、281行）、M10のread Port費用予約・重複抑止・再試行を`0af8b4e`（#11、775行）にコミット。親が関連9ファイル54テストと対象lint/formatを確認。await中に期限切れとなる観測の拒否も検証した。
- M10接続準備としてThread公開型とRateLimit DOを`e0d3949`（#11、344行）で分離。親が既存Worker 9テストと対象lint/formatを確認。業務判断とSDK依存をCoreへ移さず、Worker内の責務分割を維持した。
- M08の実Provider接続、M10の保存前制御・Think/DO接続は実装中。途中時点のNode全287テストは通過したが、変更完了後の最終検査ではない。
- 作業はmain上。各コミットは実在sub-issueに紐づけ、追加＋削除2,000行以内。
  実装はLuna/max、主担当が差分・契約・テストをレビューする。

## 依存順と責務

| 順序 | Issue     | 実装責務                                                    |
| ---- | --------- | ----------------------------------------------------------- |
| 並行 | M05 / #6  | Worker HTTP・認証・所有権・bootstrap。Applicationはstub注入 |
| 1    | M06 / #7  | Core候補・不変観測・所有者/thread・鮮度/context照合、eval   |
| 2    | M09 / #10 | 根拠検証・観測由来カード・CommitPort・in-memory CAS、eval   |
| 3    | M07 / #8  | Workerの3操作Binding、schema、能力・実行文脈注入            |
| 4    | M08 / #9  | 実モデルProvider、Coreの許可文脈と条件案、Worker encoding   |
| 5    | M10 / #11 | SDK実行予算・batch拒否・修正・取消・再送、M05 bootstrap接続 |

M06→M09→M07→M08→M10。M10はM05も必要。
実DOのApplication保存はM16、完成した本番構成の検収はM23が担当する。

## M04の証拠

- `6ede1bb`：Thinkの共通保存前制御・現turn原文投影・期限書換え・compaction・実DO/HTTP統合（1,844行）。
- `683b153`：本文digestと参照だけの再送記録・復元DTO（667行）。
- `cd5c5ed`：確定根拠から公開DTOへの変換と不整合拒否（464行）。
- `69ecb25`：共通保持契約・期限policy・保存前envelope検証（420行）。
- `555c243`、`71d90d5`：AIChat比較候補。contextなしnative入力の保存前制御は未達で未採用。

それ以前の比較・監査・Core接続は[適合性記録](runtime-compatibility.md)を参照。
一時環境の過去の成功を、正式構成の成功と読み替えない。

## 未実測と未反映

実モデル・有料店舗API・本番alarm遅延・実機描画は未実測。
GitHubへのpush、各Issueへの完了記録・Closeは、ローカルコミットとは区別する。
未pushをGitHub反映済みとは報告しない。

依存同期の`bun install --ignore-scripts --no-progress`は自動承認レビューに拒否された。
ユーザーへ手元での実行を依頼済み。M08 Provider導入・更新後のfrozen-lock整合は未検証。
未pushコミット一覧・範囲行数・remoteの確認コマンドと、M05更新後のWorker dry-runも
自動承認レビューに拒否された。これらの操作は再試行・別手段で迂回せず未確認として残す。
