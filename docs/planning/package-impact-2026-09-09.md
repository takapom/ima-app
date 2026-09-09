# package境界決定による全Issueの修正（2026-09-09）

[ADR0012](../adr/0012-package-dependency-boundaries.md)を親#1と全35件へ反映する。Issueの配置・成果物・完了条件の更新であり、実装完了ではない。

## 共通の決定

- mobile→contracts、api→contracts/core、eval→core。coreとcontractsは相互依存なし。
- 公開DTOと内部型の変換はWorker。各packageは公開exportsを使う。相対パス・alias・型importによる迂回も禁止。
- Core専用Fixtureはeval、SDK/DO/HTTP/provider/実モデル評価はWorker内、UI/state/SQLiteはmobile内。試験用packageやrunnerを本番へ含めない。
- 保持ポリシーは仕様/期待値を共通化し、端末がCoreをimportする設計にはしない。
- M10はruntimeの注入入口、M16は実DO Adapterの配線、M23は本番構成の試験を所有する。統合試験Issueへ実装を先送りしない。
- M16にM10（runtime注入入口）、M22にM26（events/flagsの実接続）を直接依存として追加する。循環なし。package間の依存とIssueの完了依存は別。新規Issueは不要で、各既存担当に配置を明記する。
- 具体的なlint製品・独自ルールの詳細は未採択。M02の実装前に確定し、今回の決定と混同しない。

## 全件対応表

| Issue | 所有する配置 | 変更・検収の焦点 |
|---|---|---|
| [M01 / #2](https://github.com/takapom/ima-app/issues/2) | docs/design | 実装基準に5つのpackageの責務・許可依存・公開入口・テスト配置を記載する。 ADR0012を含む全要件の担当が一意で、package分割とデプロイ面の追加を混同しない。 |
| [M02 / #3](https://github.com/takapom/ima-app/issues/3) | workspace設定・CI | 5つのworkspaceのpackage.json/exportsとpackage単位の型検査・ビルド・テストを構成する。依存lintの具体製品と独自ルールは実装前に設計を確定し、未採択案を採択済みと扱わない。 contracts/coreを独立検査し、相対パス・alias・type import・再export・循環・未宣言依存・内部へのdeep importの違反例を検出する。UI直接I/OとCore内部レイヤも検査対象とし、evalを本番成果物へ含めない。 |
| [M03 / #4](https://github.com/takapom/ima-app/issues/4) | packages/contracts・packages/core | contractsはHTTP/描画/端末保持メタデータ、coreは能力Port・観測・業務入力/結果を所有する。両者の対応表と変換例を定義し、変換実装はM05/M07/M15等のWorker Adapterが担当する。 両packageは相互importなしで検査でき、公開schemaに内部Port/SDK型/内部観測全体を露出しない。端末に必要な保持情報が公開契約に含まれる。 |
| [M04 / #5](https://github.com/takapom/ima-app/issues/5) | workers/api（spike・tests） | scripted modelとSDK/DO適合性FixtureはWorker内の検証用コードに置く。packages/evalにはSDKを導入しない。 spikeがcoreの公開Portをstub実装でき、Cloudflare/モデルSDKの型と自動保存制御がWorker側で完結する。 |
| [M05 / #6](https://github.com/takapom/ima-app/issues/6) | workers/api（HTTP・bootstrap） | 公開DTOとCore内部入力/結果の変換、HTTP error変換、認証をWorkerに置く。bootstrapの注入入口を定義し、CoreはRequest/Response/Envを受け取らない。 HTTP境界をstub handlerで検証し、公開DTO変換の欠落・内部情報の漏出を検出する。後段の具象Adapterをbootstrapから注入できる。 |
| [M06 / #7](https://github.com/takapom/ima-app/issues/7) | packages/core・packages/eval | registry/Clock Port/鮮度判定はcore、再利用するCore専用の固定時計・観測Fixtureとシナリオはevalに置く。core自体の単体テストはcoreに置く。 coreからeval/Worker/contractsへのimportなしで単体試験でき、evalもcoreの公開入口だけで観測・スコープ・期限のシナリオを実行できる。 |
| [M07 / #8](https://github.com/takapom/ima-app/issues/8) | workers/api（Tool Binding） | SDKの3操作の定義・引数変換・実行BindingはWorkerに置き、coreの公開能力Port/Application入口を呼ぶ。Worker内テスト用Fakeは本番コードから参照しない。 SDK型の変換とallowlistをWorker側で試験し、Toolの追加packageやToolごとのCoreを作らずにProviderを差し替えられる。 |
| [M08 / #9](https://github.com/takapom/ima-app/issues/9) | workers/api（model Adapter）・packages/core | モデルSDK・prompt encodingはWorker、許可済み文脈の投影・構造化条件案の業務検証はcoreに置く。coreはSDKのmessage型を返さず、Workerで変換する。 文脈・条件検証をSDKなしで試験でき、SDK用message組立テストはWorker側に閉じる。ユーザー原文を維持する。 |
| [M09 / #10](https://github.com/takapom/ima-app/issues/10) | packages/core・packages/eval | 確定検証・内部表示結果・CommitPortはcoreに置く。Core専用in-memory CAS Fixtureはeval、公開AssistantResponseへの変換はWorkerの担当とする。 coreの業務検証を独立試験し、evalから公開入口を使って競合/再送/invalidの状態変更を検証する。カード組立のためにcontractsへ依存しない。 |
| [M10 / #11](https://github.com/takapom/ima-app/issues/11) | workers/api（runtime・bootstrap） | SDKのstep/予算/取消制御とruntime factoryはWorkerに置く。M05のbootstrapへ接続し、CommitPortは注入する。M16が実DO Adapterの配線を完成し、M23は完成した本番構成を検証する。 Worker内テスト用in-memory Adapterで制御試験を実行できる。独自汎用ループやpackages/evalへの実行時依存を作らない。 |
| [M11 / #12](https://github.com/takapom/ima-app/issues/12) | workers/api（Places検索Adapter） | Places SDK/HTTP・field mapping・署名cursorはWorkerに置き、coreの検索Portを実装する。 Worker内のHTTP FixtureでPort適合性を試験し、providerレスポンス型がcore/contracts/mobileへ漏れない。 |
| [M12 / #13](https://github.com/takapom/ima-app/issues/13) | workers/api（Places詳細Adapter） | Places詳細の取得・正規化はWorkerでcoreの詳細Portを実装する。観測登録と業務状態変更はcoreの担当を維持する。 Worker内のprovider契約試験がcoreの公開型で検収でき、contractsへprovider SDK型を追加しない。 |
| [M13 / #14](https://github.com/takapom/ima-app/issues/14) | workers/api（Routes Adapter）・packages/core | Routes通信・レスポンス正規化はWorker、徒歩条件/鮮度の業務判定はM06/M09のcoreへ集約する。 HTTPエラー・行列変換はWorkerで、秒単位の条件判定はcoreで検査し、CoreからRoutesを直接呼ばない。 |
| [M14 / #15](https://github.com/takapom/ima-app/issues/15) | packages/core・workers/api | journeyの内部型・純粋な時刻/適用日/滞在判定はcore、データ読出しPort実装・取込みI/O/コマンドはWorkerに置く。取込みも同じCore検証器を呼ぶ。 合成データでcoreの計算を独立検査でき、取込み/保存先の結合試験はWorkerで行う。公開契約に実時刻表全体を含めない。 |
| [M15 / #16](https://github.com/takapom/ima-app/issues/16) | workers/api（photo Adapter） | 認証付きHTTP配信・handle署名・stream・帰属DTO変換はWorkerに置く。mobileの帰属描画はM19、HTTP利用はM22とする。 Worker内試験で認証/失効/streamを検証し、contractsには表示に必要なhandle/帰属のみを公開する。 |
| [M16 / #17](https://github.com/takapom/ima-app/issues/17) | packages/core・workers/api | 保持可否・期限・制約継承の業務判定はcore、SDK保存前制御・DO transaction/alarm・削除I/OはWorkerに置く。M10の注入入口へ実CommitPortを配線する。 保持判定はCore単体、永続書込み/削除/CASはWorker統合試験で検証する。実配線は本Issueの成果物とし、M23へ実装を先送りしない。 |
| [M17 / #18](https://github.com/takapom/ima-app/issues/18) | apps/mobile（UI） | UI/tokens/fontsはmobile内部へ配置する。hooks/state/servicesの軽量構成を維持し、packageは画面やレイヤごとに増やさない。 画面からWorker/core/evalをimportせず、UIからHTTP/SQLite等を直接呼ばない。 |
| [M18 / #19](https://github.com/takapom/ima-app/issues/19) | apps/mobile（UI・hooks・services） | 入力状態はhooks/state、位置SDKはservices、送信データはcontractsの公開型で構築する。位置の業務的利用可否を端末Core importで判定しない。 位置serviceのFakeでUIを検証でき、ネイティブSDKへのアクセスがservicesに閉じる。 |
| [M19 / #20](https://github.com/takapom/ima-app/issues/20) | apps/mobile（renderer・tests） | 描画はcontractsの公開応答型を受ける。表示Fixtureはmobile内に置き、内部Observationやpackages/evalのシナリオをimportしない。 公開応答Fixtureだけでkeep/replace/帰属/欠損表示を検証でき、Coreの業務判定をrendererへ複製しない。 |
| [M20 / #21](https://github.com/takapom/ima-app/issues/21) | apps/mobile（actions・services） | 操作をhooks/stateと端末servicesへ分け、Linking/Share/hapticsのI/Oはservicesが担当する。 mobile内Fakeで検査でき、Worker/SDK Tool/Coreを直接呼ばずHTTP service契約へ引き継げる。 |
| [M21 / #22](https://github.com/takapom/ima-app/issues/22) | apps/mobile（SQLite services・tests） | 保持の公開メタデータをcontractsから受け、端末servicesで保存前/利用前失効を適用する。M31の仕様上の期待値を端末用ケースにし、Core保持関数やeval Fixtureをimportしない。 Worker未完成でも公開契約Fixtureで保存・失効を試験できる。未確認/不足メタデータはdenyとなり、サーバー内部型の共有を要しない。 |
| [M22 / #23](https://github.com/takapom/ima-app/issues/23) | apps/mobile（HTTP services・state） | HTTP serviceがcontractsで検証しstateへ渡す。実Workerとの接続はHTTP経由で行い、Worker/core/evalのコードはimportしない。 端末側のkeep/replace/再送/保持整合を公開契約で試験でき、バックエンド内部実装の変更でmobileの依存が増えない。 |
| [M23 / #24](https://github.com/takapom/ima-app/issues/24) | workers/api（SDK・HTTP・DO tests） | SDK/HTTP/実DOの4領域suiteとmodel/provider FixtureはWorker内に置く。packages/evalの対象はCore専用試験に限定し、このsuiteを移さない。 M10/M16の本番bootstrapを使い、テストだけの別配線で欠落を隠さない。Core eval・mobile state・SQLite・実機の証跡を参照し、相互package importは増やさない。 |
| [M24 / #25](https://github.com/takapom/ima-app/issues/25) | workers/api（provider tests・smoke） | provider HTTP Fixture、契約suite、live smokeコマンドをWorker内の検証用コードに置く。packages/evalへ通信SDKを入れない。 キーなしsuiteとlive smokeが分離され、検証コード/Fixtureが本番bootstrap・デプロイ成果物へ含まれない。 |
| [M25 / #26](https://github.com/takapom/ima-app/issues/26) | workers/api（model eval tooling） | 実モデルを呼ぶrunner・固定供給Fixture・rubricはWorker側の検証用コードへ置く。packages/evalはCore専用であり、SDKやWorkerをimportするrunnerを置かない。 評価runnerは本番配布されず、Worker→evalの依存なしで固定供給を注入できる。Core evalの結果と実モデル品質評価の結果を区別する。 |
| [M26 / #27](https://github.com/takapom/ima-app/issues/27) | workers/api（telemetry・flags）・packages/contracts | 公開event/flagのデータ契約はcontracts、収集/集計/保存/SDK trace変換はWorkerに置く。Coreへtelemetry SDKやEnvを注入しない。 Worker内event Fixtureで検証でき、mobileは公開HTTP契約だけで送信する。 |
| [M27 / #28](https://github.com/takapom/ima-app/issues/28) | apps/mobile・workers/api・packages/contracts | native Attest clientはmobile services、nonce/assertionの公開契約はcontracts、Apple検証/認可I/OはWorkerに置く。 Apple/Expo/Cloudflare型がcontracts/coreに漏れず、認証を迂回する別のSDK入口を公開しない。 |
| [M28 / #29](https://github.com/takapom/ima-app/issues/29) | docs・workspace CI・apps/mobile・workers/api設定 | M02のpackage検査とM34以後の設定を統合する。contracts/coreの独立検査とビルド順、eval/検証runnerの本番除外をrunbookへ記載する。 2つのデプロイ面のみを生成し、packageごとの型/境界検査と本番bundleの検証コード除外を確認できる。 |
| [M29 / #30](https://github.com/takapom/ima-app/issues/30) | apps/mobile（E2E）・docs（監査） | E2Eは実アプリとHTTP境界を通し、Core/Worker内部のimportでサービスを置き換えない。各packageの試験証跡と要求対応を監査する。 依存境界検査の合格とmobile/Worker実接続の両方があり、Core evalだけでUI/SDK統合成功と判定しない。 |
| [M30 / #31](https://github.com/takapom/ima-app/issues/31) | docs（配布）・apps/mobile/Worker成果物 | 配布チェックへ2デプロイ面・本番bundleの秘密値/Fixture/評価runner除外を追加する。 配布する実成果物を確認し、packages/evalやテスト専用モデルが本番経路へ混入していない。 |
| [M31 / #32](https://github.com/takapom/ima-app/issues/32) | docs（policy仕様・データのみの期待例） | 内部保持判断と端末向け公開保持メタデータの対応を定義する。共通とは仕様/期待値を指し、Core実装の端末共有ではない。各packageは適切な入力形式で同じ制約を検証する。 公開契約だけで端末の許可/期限/denyを判断でき、内部観測とのWorker変換例がある。期待例にSDK実装を含めず、M03/M16/M21の責務が明確である。 |
| [M32 / #33](https://github.com/takapom/ima-app/issues/33) | workers/api（HP Adapter） | HP HTTP・照合/正規化・capability合成はWorkerの外部Adapterに置き、coreの既存能力Portへ返す。 HP SDK型やレスポンスを公開契約/Coreへ漏らさず、Worker内の契約試験でキーなし/競合を検証できる。 |
| [M33 / #34](https://github.com/takapom/ima-app/issues/34) | workers/api（データ・取込み運用）・docs（出典） | 実journeyデータはWorkerの取込み経路から管理し、M14のCore検証器とWorker importerを利用する。contracts/mobile/evalに本番時刻表を配置しない。 本番データと合成Fixtureの入力元が分離され、更新/rollbackが公開Core検証入口を通る。 |
| [M34 / #35](https://github.com/takapom/ima-app/issues/35) | workers/api・apps/mobile（環境設定） | WorkerのEnv/binding/型生成はWorker内、EAS/端末設定はmobile内へ閉じる。contracts/coreにはCloudflare/Expo設定を持ち込まない。 5つのworkspaceでもデプロイ面はmobile/Workerの2つで、evalは検証ジョブだけに使う。 |
| [M35 / #36](https://github.com/takapom/ima-app/issues/36) | workers/api（live検収）・docs（証跡） | M24のWorker側smokeを実HTTP/モデル経路で実行し、応答をcontractsで検査する。Core evalや固定供給でlive経路を代替しない。 実配線・公開HTTP応答・本番対象の依存構成を検収し、Fixtureやevalがlive成功を作っていない。 |
