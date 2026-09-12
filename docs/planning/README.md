# MVP実装バックログ

2026-09-08に作成した実装計画。以下の「未実装」等は計画作成時点の記述であり、現在の進捗ではない。Issue作成は実装完了を意味しない。

2026-09-10以降の実装・残件・検証区分は[内部MVP監査](../design/m29-implementation-audit.md)とGitHubの各Issueを参照する。SDK採用結果は[ADR0014](../adr/0014-think-runtime-adoption.md)を優先する。

## 完了条件

HTMLモックを基準としたiPhone React Nativeアプリから、LLMが初期3操作を自律選択し、実店舗情報によるメッセージ/候補UI、追記、決定、地図/共有、端末保存が使えること。キーと環境設定の手順を整備し、Fixtureとliveの両方で検証する。外部TestFlightは認証・Apple設定・実データの別ゲートを持つ。

## package配置の決定

2026-09-09採択: [ADR 0012](../adr/0012-package-dependency-boundaries.md)。mobile→contracts、api→contracts/core、eval→core。公開DTOとCore内部型はWorkerで変換する。全35件の成果物・配置・完了条件を更新済み（[影響対応表](./package-impact-2026-09-09.md)）。コードとlint/CIは未実装。

## 品質ハーネスの決定

[ADR0013](../adr/0013-quality-harness-and-size-limits.md)を親と全35件へ反映。ESLint＋typescript-eslint、Prettier、dependency-cruiserを採用し、CIを必須ゲート、hooksを補助とする。手書きコード/テスト/設定は空行・コメント込み500行以内。生成物/lockfile/Markdown/既存HTMLモックはファイル制約の対象外だが、PR追加＋削除2,000行検査には文書・生成物・lockfileも含める。

M02は設計決定済み・実装未完了。製品選定を再度着手条件にせず、正常/違反/行数境界の検査とCI・保護設定を実装する。後段のM28で統合、M29で監査する。Issueの依存関係・35件の分割は維持する。

## 仕様の優先順位

ユーザーの最新決定と後続ADRを優先する。フロントはUI + hooks/state + services、バックエンドはヘキサゴナル。ToolはLLM向け入力Adapter、CoreのPortとは別の入口である。SDKの型と外部サービス依存をCoreへ持ち込まない。

Cloudflare側へ実行管理を集約しThinkを先に検証、不適合ならAIChatAgent + streamText。独自汎用ループ、独立ToolLoopAgent、固定検索順序、毎回3件、訪問3状態、全レスポンスの無条件永続保存は採用しない。詳細案の数値は検証して採用理由を記録する。

## 実施順序

まずM01を完了し、M02（起動基盤）とM31（保存・能力ポリシー）を進める。M03（契約）はその両方を受け、M04（SDK適合性）へ進む。SDK適合性が確定したらバックエンドを進める。M17のUI移植はM02後に独立着手できる。外部Provider実装とUIを契約で接続し、SDK/サーバーFixture（M23）はUI完成を待たず、実モデル＋固定供給の評価（M25）は実店舗APIを待たず進める。M34で非本番環境を先行整備し、実API検収M35、iPhone E2E M29、実終電データM33を含む配布M30へ進む。M16はM10のruntime注入入口、M22はM26のevents/flagsを受けて実接続する。依存欄は完了をブロックする直接依存であり、将来の統合Issueを基盤Issueの依存にはしない。

## 要件対応表

| 要件群・資料 | 担当 |
|---|---|
| ADR0001〜0003：プロダクト、主候補/別案、条件、端末リスト、地図/LINE、対話 | M01, M17〜M22, M26, M29〜M30 |
| ADR0004〜0006：上書き関係、2デプロイ面、軽量フロント/ヘキサゴナル | M01〜M03, M05〜M07, M17, M22, M28 |
| ADR0007〜0009：LLM主導、3操作、任意提示 | M03, M06〜M10, M19, M23, M25 |
| ADR0010〜0011：SDK、Think適合性、fallback、依存隔離 | M02, M04, M07〜M10, M23, M28 |
| ADR0012：package境界・公開入口・試験配置 | 全35件（[影響対応表](./package-impact-2026-09-09.md)） |
| ADR0013：lint/CI・500行/PR2,000行 | M02が基盤、全35件へ適用、M28統合/M29監査 |
| design0001：RN/Expo、地図/共有、位置、SQLite、供給、API/認証、運用、TF | M01〜M03, M05, M11〜M22, M24, M26〜M30 |
| design0002：未決契約、根拠、実行、状態、provider、評価 | M01, M03〜M16, M21〜M30 |
| design0003〜0004：パターン、文脈、2終端、履歴、原文条件更新 | M03, M06〜M10, M18〜M23, M25 |
| design0005 §2〜3：Port/ID/Result/Observation/権限 | M03, M05〜M07 |
| design0005 §4〜5：検索/cursor/詳細/徒歩/終電/部分結果 | M07, M11〜M15, M24 |
| design0005 §6〜9：鮮度/根拠/submit/予算/写真/保持 | M06, M09〜M10, M15〜M16, M19, M21, M23 |
| design0005 型一覧・評価・導入条件 | M03, M23〜M25, M28 |
| design0006：3操作限定/応答/修正/全保存先Fixture | M04, M07, M09〜M10, M16, M19, M21〜M23 |
| index.html：見た目/入力候補/カード/写真/操作/サイドバー | M17〜M22, M29 |
| キー等の設定後に使用できるMVP | M08, M11〜M16, M22, M24, M28〜M30 |

## 対象外・外部依存

- Android/iPad最適化、机UI、WebView、予約、全国の終電保証、LINEログイン/自動送信、訪問追跡、共同リスト、課金UIは今回追加しない。
- APIキー、課金/API有効化、Cloudflare資源、Apple署名/資格、実終電データの供給は明示的な環境依存。コード完了・Fixture合格だけでlive/配布検証済みとは扱わない。
- Hot Pepperは任意設定。無効時も基本MVPを動かし、未提供能力はunsupportedとする。終電は実データなしでdisabledとし、対応を謳う配布の代替にしない。

## 分割レビューの反映

[レビュー記録](./review-2026-09-08.md)。30件をレビューし、任意HP・実終電データ・保存/能力契約・非本番環境・live検収を分離して35件へ更新。全件を親Issueの正式なsub-issueとして管理する。

- M31: M03/M04/M16/M21で使う共通保持・能力契約。サーバー完成待ちを端末へ伝播させない。
- M32: 任意HP実装。Places基本機能から分離。
- M33: 実終電データ検証・投入。M14のコード完成と分離。
- M34: 初期環境。最後のM28は手順統合のみ。
- M35: 実キー・実API検収。契約テスト作成M24から分離。

## Issue一覧

[親Issue #1](https://github.com/takapom/ima-app/issues/1)で全体進捗を管理する。実装Issueは35件＋品質刈り[M36 / #37](https://github.com/takapom/ima-app/issues/37)＋owner正[M37 / #38](https://github.com/takapom/ima-app/issues/38)・[M38 / #39](https://github.com/takapom/ima-app/issues/39)。原本は[backlog.json](./backlog.json)。各Issueに目的・実装範囲・完了条件・直接依存・根拠文書を記載する。

| ID | フェーズ | タスク | 直接依存 |
|---|---|---|---|
| [M01 / #2](https://github.com/takapom/ima-app/issues/2) | 基盤 | 仕様の優先順位・MVP能力・完了条件を実装用に統合する | なし |
| [M02 / #3](https://github.com/takapom/ima-app/issues/3) | 基盤 | 5つのpackageのモノレポと依存境界・品質チェックを構築する | [M01 / #2](https://github.com/takapom/ima-app/issues/2) |
| [M03 / #4](https://github.com/takapom/ima-app/issues/4) | 基盤 | HTTP・3操作・観測・確定応答のvalibot契約を実装する | [M02 / #3](https://github.com/takapom/ima-app/issues/3), [M31 / #32](https://github.com/takapom/ima-app/issues/32) |
| [M04 / #5](https://github.com/takapom/ima-app/issues/5) | 基盤 | Cloudflare Runtimeの適合性をFixtureで検証しSDKを確定する | [M02 / #3](https://github.com/takapom/ima-app/issues/3), [M03 / #4](https://github.com/takapom/ima-app/issues/4) |
| [M05 / #6](https://github.com/takapom/ima-app/issues/6) | バックエンド | WorkerのHTTP境界・認証・スレッド所有権を実装する | [M03 / #4](https://github.com/takapom/ima-app/issues/4), [M04 / #5](https://github.com/takapom/ima-app/issues/5) |
| [M06 / #7](https://github.com/takapom/ima-app/issues/7) | バックエンド | 候補・観測レジストリと根拠の鮮度管理を実装する | [M03 / #4](https://github.com/takapom/ima-app/issues/4) |
| [M07 / #8](https://github.com/takapom/ima-app/issues/8) | バックエンド | 3つのToolを入力Adapterとして登録し能力Portへ接続する | [M03 / #4](https://github.com/takapom/ima-app/issues/4), [M04 / #5](https://github.com/takapom/ima-app/issues/5), [M06 / #7](https://github.com/takapom/ima-app/issues/7), [M09 / #10](https://github.com/takapom/ima-app/issues/10) |
| [M08 / #9](https://github.com/takapom/ima-app/issues/9) | バックエンド | 実モデルAdapterとLLM主導の文脈・応答生成を実装する | [M04 / #5](https://github.com/takapom/ima-app/issues/5), [M07 / #8](https://github.com/takapom/ima-app/issues/8) |
| [M09 / #10](https://github.com/takapom/ima-app/issues/10) | バックエンド | submit_cardsとメッセージの根拠検証・一度だけの応答確定を実装する | [M03 / #4](https://github.com/takapom/ima-app/issues/4), [M06 / #7](https://github.com/takapom/ima-app/issues/7) |
| [M10 / #11](https://github.com/takapom/ima-app/issues/11) | バックエンド | SDKの修正ループ・予算・並列・キャンセル・再送を制御する | [M05 / #6](https://github.com/takapom/ima-app/issues/6), [M07 / #8](https://github.com/takapom/ima-app/issues/8), [M08 / #9](https://github.com/takapom/ima-app/issues/9), [M09 / #10](https://github.com/takapom/ima-app/issues/10) |
| [M11 / #12](https://github.com/takapom/ima-app/issues/12) | 外部連携 | Places検索Adapterと安全なページングを実装する | [M03 / #4](https://github.com/takapom/ima-app/issues/4), [M06 / #7](https://github.com/takapom/ima-app/issues/7), [M31 / #32](https://github.com/takapom/ima-app/issues/32) |
| [M12 / #13](https://github.com/takapom/ima-app/issues/13) | 外部連携 | Places詳細Adapterと項目別取得・部分結果を実装する | [M03 / #4](https://github.com/takapom/ima-app/issues/4), [M06 / #7](https://github.com/takapom/ima-app/issues/7), [M31 / #32](https://github.com/takapom/ima-app/issues/32) |
| [M13 / #14](https://github.com/takapom/ima-app/issues/14) | 外部連携 | 方向付き徒歩経路AdapterをRoutesへ接続する | [M03 / #4](https://github.com/takapom/ima-app/issues/4), [M06 / #7](https://github.com/takapom/ima-app/issues/7), [M31 / #32](https://github.com/takapom/ima-app/issues/32) |
| [M14 / #15](https://github.com/takapom/ima-app/issues/15) | 外部連携 | 終電journeyの検証・計算・取込みコードを実装する | [M03 / #4](https://github.com/takapom/ima-app/issues/4), [M06 / #7](https://github.com/takapom/ima-app/issues/7), [M13 / #14](https://github.com/takapom/ima-app/issues/14) |
| [M15 / #16](https://github.com/takapom/ima-app/issues/16) | 外部連携 | 写真の認証付き配信・失効・帰属表示を実装する | [M05 / #6](https://github.com/takapom/ima-app/issues/6), [M12 / #13](https://github.com/takapom/ima-app/issues/13) |
| [M16 / #17](https://github.com/takapom/ima-app/issues/17) | バックエンド | サーバー保存ポリシー・削除・復元制御を実装する | [M04 / #5](https://github.com/takapom/ima-app/issues/5), [M05 / #6](https://github.com/takapom/ima-app/issues/6), [M06 / #7](https://github.com/takapom/ima-app/issues/7), [M09 / #10](https://github.com/takapom/ima-app/issues/10), [M31 / #32](https://github.com/takapom/ima-app/issues/32), [M10 / #11](https://github.com/takapom/ima-app/issues/11) |
| [M17 / #18](https://github.com/takapom/ima-app/issues/18) | フロント | HTMLモックを基準にReact Nativeの画面基盤を実装する | [M02 / #3](https://github.com/takapom/ima-app/issues/3) |
| [M18 / #19](https://github.com/takapom/ima-app/issues/19) | フロント | 自由入力・入力候補・位置取得・条件編集を実装する | [M03 / #4](https://github.com/takapom/ima-app/issues/4), [M17 / #18](https://github.com/takapom/ima-app/issues/18) |
| [M19 / #20](https://github.com/takapom/ima-app/issues/20) | フロント | メッセージ・候補カード・説明・帰属の描画を実装する | [M03 / #4](https://github.com/takapom/ima-app/issues/4), [M17 / #18](https://github.com/takapom/ima-app/issues/18) |
| [M20 / #21](https://github.com/takapom/ima-app/issues/21) | フロント | 候補の入替・決定・却下・地図・LINE共有を実装する | [M18 / #19](https://github.com/takapom/ima-app/issues/19), [M19 / #20](https://github.com/takapom/ima-app/issues/20) |
| [M21 / #22](https://github.com/takapom/ima-app/issues/22) | フロント | 端末SQLiteの履歴・設定・保存リスト・期限処理を実装する | [M03 / #4](https://github.com/takapom/ima-app/issues/4), [M17 / #18](https://github.com/takapom/ima-app/issues/18), [M31 / #32](https://github.com/takapom/ima-app/issues/32) |
| [M22 / #23](https://github.com/takapom/ima-app/issues/23) | フロント | フロントのAPI service・会話state・復元を接続する | [M05 / #6](https://github.com/takapom/ima-app/issues/6), [M10 / #11](https://github.com/takapom/ima-app/issues/11), [M16 / #17](https://github.com/takapom/ima-app/issues/17), [M18 / #19](https://github.com/takapom/ima-app/issues/19), [M19 / #20](https://github.com/takapom/ima-app/issues/20), [M20 / #21](https://github.com/takapom/ima-app/issues/21), [M21 / #22](https://github.com/takapom/ima-app/issues/22), [M26 / #27](https://github.com/takapom/ima-app/issues/27) |
| [M23 / #24](https://github.com/takapom/ima-app/issues/24) | 検証 | Worker側で4領域のSDK・HTTP・DO Fixture統合テストを完成させる | [M05 / #6](https://github.com/takapom/ima-app/issues/6), [M10 / #11](https://github.com/takapom/ima-app/issues/11), [M16 / #17](https://github.com/takapom/ima-app/issues/17) |
| [M24 / #25](https://github.com/takapom/ima-app/issues/25) | 検証 | Provider契約テストとキー任意のlive smokeコマンドを整備する | [M11 / #12](https://github.com/takapom/ima-app/issues/12), [M12 / #13](https://github.com/takapom/ima-app/issues/13), [M13 / #14](https://github.com/takapom/ima-app/issues/14), [M14 / #15](https://github.com/takapom/ima-app/issues/15), [M15 / #16](https://github.com/takapom/ima-app/issues/16) |
| [M25 / #26](https://github.com/takapom/ima-app/issues/26) | 検証 | 実モデル＋Fixture供給で自律選択・根拠忠実性を評価する | [M08 / #9](https://github.com/takapom/ima-app/issues/9), [M10 / #11](https://github.com/takapom/ima-app/issues/11), [M23 / #24](https://github.com/takapom/ima-app/issues/24) |
| [M26 / #27](https://github.com/takapom/ima-app/issues/27) | 運用 | 最小テレメトリ・運用flags・障害時停止を実装する | [M05 / #6](https://github.com/takapom/ima-app/issues/6), [M10 / #11](https://github.com/takapom/ima-app/issues/11), [M16 / #17](https://github.com/takapom/ima-app/issues/17) |
| [M27 / #28](https://github.com/takapom/ima-app/issues/28) | 外部配布 | App Attestと外部配布向けの不正利用対策を実装する | [M05 / #6](https://github.com/takapom/ima-app/issues/6), [M15 / #16](https://github.com/takapom/ima-app/issues/16), [M22 / #23](https://github.com/takapom/ima-app/issues/23) |
| [M28 / #29](https://github.com/takapom/ima-app/issues/29) | 運用 | 環境設定・デプロイ・復旧手順を最終統合する | [M34 / #35](https://github.com/takapom/ima-app/issues/35), [M16 / #17](https://github.com/takapom/ima-app/issues/17), [M26 / #27](https://github.com/takapom/ima-app/issues/27) |
| [M29 / #30](https://github.com/takapom/ima-app/issues/30) | 検証 | iPhone E2E・視覚比較・内部MVPの完了監査を行う | [M22 / #23](https://github.com/takapom/ima-app/issues/23), [M23 / #24](https://github.com/takapom/ima-app/issues/24), [M25 / #26](https://github.com/takapom/ima-app/issues/26), [M26 / #27](https://github.com/takapom/ima-app/issues/27), [M28 / #29](https://github.com/takapom/ima-app/issues/29), [M35 / #36](https://github.com/takapom/ima-app/issues/36) |
| [M30 / #31](https://github.com/takapom/ima-app/issues/31) | 外部配布 | TestFlight配布・プライバシー・限定エリアのリリースゲートを完了する | [M27 / #28](https://github.com/takapom/ima-app/issues/28), [M28 / #29](https://github.com/takapom/ima-app/issues/29), [M29 / #30](https://github.com/takapom/ima-app/issues/30), [M33 / #34](https://github.com/takapom/ima-app/issues/34), [M32 / #33](https://github.com/takapom/ima-app/issues/33) |
| [M31 / #32](https://github.com/takapom/ima-app/issues/32) | 基盤 | 保存・能力・外部利用の共通ポリシー契約を先に確定する | [M01 / #2](https://github.com/takapom/ima-app/issues/2) |
| [M32 / #33](https://github.com/takapom/ima-app/issues/33) | 外部連携 | 任意Hot Pepper Adapterの店舗照合・LO・施設補足を実装する | [M03 / #4](https://github.com/takapom/ima-app/issues/4), [M12 / #13](https://github.com/takapom/ima-app/issues/13), [M31 / #32](https://github.com/takapom/ima-app/issues/32) |
| [M33 / #34](https://github.com/takapom/ima-app/issues/34) | データ整備 | 対応終電journeyの実データを検証・投入する | [M14 / #15](https://github.com/takapom/ima-app/issues/15), [M34 / #35](https://github.com/takapom/ima-app/issues/35) |
| [M34 / #35](https://github.com/takapom/ima-app/issues/35) | 基盤 | 非本番Worker・EASの最小環境とSecrets設定口を先行整備する | [M02 / #3](https://github.com/takapom/ima-app/issues/3), [M04 / #5](https://github.com/takapom/ima-app/issues/5) |
| [M35 / #36](https://github.com/takapom/ima-app/issues/36) | ライブ検証 | キー設定後の実API・モデル接続を非本番環境で検収する | [M08 / #9](https://github.com/takapom/ima-app/issues/9), [M24 / #25](https://github.com/takapom/ima-app/issues/25), [M34 / #35](https://github.com/takapom/ima-app/issues/35), [M31 / #32](https://github.com/takapom/ima-app/issues/32) |
| [M36 / #37](https://github.com/takapom/ima-app/issues/37) | 保守 | 製品経路の品質を残し重複試験・死コード・フロント層を刈る | [M29 / #30](https://github.com/takapom/ima-app/issues/30) |
| [M37 / #38](https://github.com/takapom/ima-app/issues/38) | バックエンド | OwnerStore Portでprefs/savedの正をowner DOに集約する | [M16 / #17](https://github.com/takapom/ima-app/issues/17), [M31 / #32](https://github.com/takapom/ima-app/issues/32) |
| [M38 / #39](https://github.com/takapom/ima-app/issues/39) | フロント | 端末SQLiteのprefs/savedをOwnerStoreの投影にする | [M37 / #38](https://github.com/takapom/ima-app/issues/38) |
| [M39 / #40](https://github.com/takapom/ima-app/issues/40) | バックエンド | decideをOwnerDOに残し端末は投影にする | [M37 / #38](https://github.com/takapom/ima-app/issues/38) |
