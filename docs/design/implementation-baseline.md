# ima. 実装基準

- 対象: M0（環境・ルール）および M01〜M05（#2〜#6）。前提として M31（#32）の共通ポリシー契約を扱う。
- 作成日: 2026-09-09
- 状態: M01/#2 の実装基準。コード、CI、外部接続の完了を示す文書ではない。

## 結論

実装の正は、最新のユーザー決定、後続の Accepted ADR、矛盾しない設計案の順に置く。ADR の `Supersedes` / `Superseded by` を解決してから設計案を参照し、未採択の提案値は実装既定値または検証待ちとして扱う。`index.html` は iPhone 画面の見た目・状態・操作の参照であり、固定データや疑似ランタイムを本番へ移植しない。

製品は iPhone の React Native + TypeScript（Expo Dev Client）と Cloudflare Worker + Durable Objects の2デプロイ面を持つ、1リポジトリのモジュラーモノリスとする。フロントは UI + hooks/state + services、バックエンドは Core が Port を所有するヘキサゴナル構成である。初期のモデル向け操作は `search_places`、`get_place_details`、`submit_cards` の3つ。LLM が原文・文脈から操作と提示形式を選び、Tool は入力 Adapter、Core Port は別の契約として保つ。

保存・送信・表示・帰属の可否は M31 の provider/field ポリシー表で確定する。許諾を推測せず、未確認は deny/disabled とする。実キー・アカウント依存の確認は M35（#36）へ渡し、Fixture 合格を live 合格と扱わない。

## 1. 仕様の優先順位と読み替え

| 優先 | 根拠                                   | 適用                                                                                                                                                                   |
| ---- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 最新のユーザー決定                     | main 上で作業し、PR/作業ブランチを作らない。1コミットの追加＋削除は2,000行以内、手書きコード・テスト・設定は1ファイル500行以内。stage/commit/push は主担当だけが行う。 |
| 2    | Accepted ADR（後続の部分上書きを反映） | 責務、Tool、提示、ランタイム、package、品質の判断を固定する。                                                                                                          |
| 3    | Accepted ADR と矛盾しない設計案        | 実装既定値・検証ケースの候補として採用可。提案と採択を明記する。                                                                                                       |
| 4    | 旧Draft・HTMLモック                    | 既定の画面形状・操作例を参照する。旧決定や固定実装は採用しない。                                                                                                       |

旧資料にある PR ゲートは、今回の方針では「main に積む各コミットのゲート」へ読み替える。CI に未実装の検査を稼働済みと記録しない。

主な上書きは次のとおり。

- ADR0002 が ADR0001 の対象を「大切にしたい人といる探す役」へ、保存を訪問検証ではなくリストへ更新する。
- ADR0003 が最初の提案前の聞き返しを禁じ、提案後の追記・却下を対話として認める。ADR0009 がメッセージのみの応答を追加する。
- ADR0006 がフロントとバックエンドの責務を更新し、ADR0012 が Core と公開契約を独立 package へ配置する。
- ADR0008 が初期 Tool を3つへ確定する。ADR0011 が Cloudflare 側の実行管理を第一候補とし、独立した ToolLoopAgent の二重管理を退ける。
- ADR0013 が品質製品、CI 必須ゲート、500行・2,000行制限を確定する。実装・検収は M02（#3）の責務である。

## 2. アーキテクチャとデータの流れ

package の依存図と境界の正は [ADR0012](../adr/0012-package-dependency-boundaries.md) の Mermaid を使う。実装順の依存は `M01 → (M02 ∥ M31) → M03 → M04 → M05` で、M05 は契約とRuntime適合性の検収後に着手する。

| package / 面         | 所有する責務                                                                   | 許可されるアプリ内依存             | テストの置き場                         |
| -------------------- | ------------------------------------------------------------------------------ | ---------------------------------- | -------------------------------------- |
| `apps/mobile`        | 画面、hooks/state、HTTP・SQLite・位置・共有 services                           | `packages/contracts`               | mobile の表示・端末 service/E2E        |
| `packages/contracts` | 公開 HTTP DTO、描画型、端末保持メタデータと schema                             | なし（汎用 schema ライブラリは可） | contracts の schema/契約テスト         |
| `packages/core`      | Application、Domain、能力 Port、観測、業務検証、確定ルール                     | なし                               | core の単体テスト                      |
| `workers/api`        | HTTP、認証、DTO変換、Cloudflare/LLM SDK、Tool Binding、外部 Adapter、Bootstrap | `contracts`, `core`                | Worker の SDK/HTTP/DO/provider Fixture |
| `packages/eval`      | Core 専用 Fixture Adapter と評価シナリオ                                       | `core`                             | eval の決定的評価                      |

`core` と `contracts` は相互依存しない。公開 DTO と Core 内部型の変換は Worker が所有し、公開 `exports` だけを使う。相対パス、alias、type import、再export、deep import、循環、未宣言依存で境界を迂回しない。`eval` と検証専用 Fixture/runner は本番成果物へ含めない。一方、実行に必要な Cloudflare/LLM SDK は `workers/api` の本番依存とし、検証専用 SDK/runner だけを本番 bundle 外に置く。5 workspace はデプロイ面を増やさず、デプロイは mobile と Worker の2つに限る。

```text
mobile UI → mobile hooks/state/services → contracts ← workers/api HTTP/Adapter/Tool
                                                     ↓
                                                   core ← eval（検証時のみ）
```

データの流れは `原文・明示条件 → Worker の Context/LLM → Tool Adapter → Core Port/観測 → 応答契約 → mobile state/UI` とする。モデルへ生GPS、秘密、DB handle、provider生レスポンスを渡さず、Core は SDK、Cloudflare、Expo、HTTP の型を持たない。

## 3. ランタイム、Tool、応答

この境界に対する `workers/api` の SDK 互換性・保存前制御・`turnConstraints` の形式は M04 で実測する。

Cloudflare の実行管理を中心に Think を第一候補として M04 が適合性を検証する。公開 API が要件を満たさなければ AIChatAgent + AI SDK `streamText` を第二候補として同じ Fixture を通す。独立 ToolLoopAgent、固定DAG、自作の汎用ループは作らない。SDK Adapter は Worker に閉じ、Core は `AgentRuntimePort` 等の意味ある Port だけを見る。

| モデル公開面        | 役割                             | 境界で守ること                                                                                     |
| ------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `search_places`     | 検索語・対象エリアから候補を取得 | 検索結果を候補観測へ変換。徒歩・終電・入店を保証しない。                                           |
| `get_place_details` | 既知候補の要求 field だけを取得  | `known` / `unknown` / `unsupported` / `not_applicable` / `error` を分け、未要求 field を混ぜない。 |
| `submit_cards`      | 主提案と別案を確定要求           | 同一 thread の観測・根拠・条件を検証し、成功時に一度だけ確定する。                                 |

3操作は固定順で必ず呼ばない。説明・比較・確認だけなら Tool なしのメッセージで完了できる。候補提示は `message + hero 1件 + alts 0〜2件` とし、候補を3件へ水増ししない。メッセージ経路は既存候補を `keep`、submit 成功は `replace` として同じ正規応答契約へ変換する。生HTML、任意コード、汎用HTTP/SQL、未登録能力はモデルへ公開しない。field 結果は `known` / `unknown` / `unsupported` / `not_applicable` / `error` を区別し、たとえば電車移動不要は `not_applicable` として欠損や失敗へ潰さない。

submit の既定検証は、候補ID・scope、同一 thread へ明示的に登録された今回または再利用可能な過去 observation（context、期限、鮮度、権限を再確認）、営業時間、明示された徒歩・終電 hard constraint、除外状態、出典を確認すること。過去観測を同一 run に限定せず、期限切れ・scope違い・条件変更時は再利用しない。条件不足・不明・期限切れは構造化エラーを LLM へ返し、Application が自動検索・条件緩和・候補差し替えをしない。店舗の文章はデータとして扱い、指示へ昇格しない。

## 4. Truth、ポリシー、保存

営業時間、徒歩、終電、価格、写真、施設情報は取得根拠と時刻を持つ。未知・未対応・取得失敗・0件を区別する。営業不明、徒歩必須なのに経路不明、終電必須なのに対応journey不明の候補は提示しない。IPから位置を推測しない。駅→店の経路を店→駅へ逆向きに転用しない。終電データなしの機能を対応済みと表示しない。

M31（#32）が provider/field 別の LLM送信・表示・保存・帰属・期限・地図併用を公式根拠と確認日つきで定義する。未確認は deny/disabled とし、SKU、料金、契約、アカウント許諾を推測しない。内部の保持判断と、端末が使う公開保持メタデータ（許可/deny、`sessionExpiresAt`、`freshUntil`、`displayUntil`、`retentionUntil`、`deletionScheduledAt`、帰属、`restoreMode`、`policyStatus`、由来）を Worker で変換する。M03 は契約、M16 はサーバ保存、M21 は端末適用を担当し、Core を端末へ共有しない。

保存の既定は「全応答を無条件保存」ではない。保存可能な参照・ユーザー操作・観測要約と、一時表示 payload を分離し、生成文にも参照データの最も厳しい制約を継承する。期限は `min(sessionExpiresAt, providerRetentionUntil)`、鮮度判定は `freshUntil`、05:00 JST 境界は M31 の例で固定する。許諾を確認できない provider 内容は永続化せず、必要なら再取得または未取得表示とする。保存リストは明示操作で管理するが、外部内容の provider 制約を解除しない。

## 5. iPhone と HTML モックの適用範囲

実装する画面契約は `Empty → Working → Results → Decided` の単一キャンバス、自由記述、入力候補、ユーザーバブル、主提案1＋別案最大2、写真領域だけの横スクロール、`ここにする` / `ちがう`、地図/共有、Drawer の今夜履歴・条件・保存である。日本語、390幅、Dark、モックのトークンと24px角丸を参照する。UI は公開 contracts の DTO を描き、業務判断を複製しない。

`index.html` の desktop/机ビュー、固定 Melt/無音/4min データ、420ms の疑似検索、保存の旧3状態、`been`/`never`、HTML の成功トースト、WebView 包装、偽ステータスバーは本番要件ではない。写真は provider の現行参照と帰属を使い、恒久バイト cache を前提にしない。provider field由来の地図は M31 の帰属条件を満たす Google Maps 用に限り、Google の座標・経路・place content を Apple Maps 等へ渡さない。ユーザーが入力した provider 非依存の目的地リンクだけを端末 Share/Linking の候補とする。

## 6. 実装・検証ゲート

| 段階      | 担当           | 完了の意味                                                                                                                                       |
| --------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| M0        | 環境・ルール   | main、manifest、依存/検査方針、担当分離の作業条件を揃える。既存 Issue はない。Secret/生成物の具体的な除外設定は M02 で実装・検収する。           |
| M01 / #2  | docs           | 本書と [要件対応表](../planning/requirements-map.md) で、全資料の担当・上書き・未採択を一意化する。                                              |
| M02 / #3  | workspace/CI   | 5 workspace、exports、依存検査、型/lint/format/test/build/commit-size、違反Fixture、required checks を実装・検収する。設計決定済みで実装未完了。 |
| M31 / #32 | docs/policy    | SDK非依存の policy 表と期待値 Fixture を作る。未確認は deny/disabled、アカウント依存は M35 へ渡す。                                              |
| M03 / #4  | contracts/core | 公開契約と内部 Port/観測を相互依存なしで実装し、正常・境界・不正・保持メタデータを検査する。                                                     |
| M04 / #5  | workers/api    | 実ローカル Worker/DO + scripted model で Tool 公開面、修正、終端、保存前制御を検証し、Think 採用/不適合と再現手順を記録する。                    |
| M05 / #6  | workers/api    | M03契約とM04採用基盤の上で、認証、所有者、入力上限、HTTP envelope、rate limit、DO bootstrap を stub で検証する。                                 |

品質ゲートは format、lint（500行を含む）、architecture、typecheck、test、build、commit-size（ADR上のpr-sizeを読み替え）。各コミットの親ツリーとの差分で追加＋削除を数え、2,000行を許可、2,001行を失敗とする。文書・テスト・生成物・lockfileも数え、取得不足は成功にしない。コミット前にローカル検査し、main push後にmain上で同じ必須CIとrequired checksを実行して検収する。CIをmain反映前の別PR/merge-baseゲートにはしない。PRやmerge-baseを前提にした運用、作業ブランチ、別担当のstage/commit/pushは導入しない。CI が main 上の検収結果の正で hooks は補助とする。未実装のCI、実API、実モデル、実機、Apple資格、外部許諾は成功と報告しない。

内部MVPはキー設定後に Worker/Fixture と開発認証で動く範囲を指す。外部 TestFlight は App Attest、署名、プライバシー、対応終電実データ、provider の許諾/帰属確認を別ゲートとする。M31 の policy と M35 の実API検収を満たさない能力は有効化しない。

## 7. 実装既定値と未採択の詳細

以下は v1 の実装を分岐させないための既定値であり、Accepted ADR の性能保証ではない。M04/M25 の測定、M31 のポリシー、M35 の実接続結果で変更した場合は理由と対象を更新する。

| 項目           | v1既定値                                                                                                                                                                                                                                                                    | 採用理由・変更担当                                                                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 提示           | message-only または cards（hero1、alts0〜2、submit は cards のみ）                                                                                                                                                                                                          | ADR0009 と design0004/0006 を整合。契約は M03、SDK検証は M04。                                                                                                             |
| submit 根拠    | 同一 scope の候補/観測、期限内の出典、営業時間、必要な徒歩/終電、除外なし                                                                                                                                                                                                   | 「取得した事実だけを出す」を機械検証可能にする。M03/M06/M09。                                                                                                              |
| セッション期限 | 作成後最初の 05:00 JST。保存リストは独立。ただし provider retention の短い方を適用                                                                                                                                                                                          | 翌日に今夜の文脈を持ち越さない。M31/M16/M21。                                                                                                                              |
| 実行予算       | wall 12秒（最終回答用に2秒を予約）、モデル最大6 step、read 合計8回・同時2、search/details各3/4秒、provider HTTP試行合計20、通信/5xxの自動再試行は最大1回、submit修正最大2回、Tool結果は概ね12KB以内                                                                         | design0005/0006 の初期案を実装既定値として採用。性能・費用の保証ではなく M04/M10/M25 で調整。                                                                              |
| 実行制御       | Tool metadata は readOnly/timeout/costUnits/schemaVersion を持ち、同一scope・入力・文脈・鮮度のreadはsingle-flight、callId再送は同じ結果。429はRetry-Afterが残予算内なら待機し、引数/参照エラーは自動再試行しない。旧revisionはcancelし、submitと未完了readを同時確定しない | design0005 §8/0006 の安全側既定。M04/M10でSDKの公開APIとして実測する。                                                                                                     |
| 失敗           | unknown/unsupported/error/0件を分離し、候補を捏造・自動緩和しない                                                                                                                                                                                                           | Truth SLA と provider差を守る。M03/M04/M05。                                                                                                                               |
| LLM fallback   | Think不適合時は AIChatAgent + streamText。regex固定fallback、独立ToolLoopAgent、常時LLMオフは採用しない                                                                                                                                                                     | ADR0011を優先。必要な決定的処理は Core/Fixture に置き、M04で再現する。`turnConstraints` のモデル出力形式・SDKへの適用hook・schema互換は未検証で、M04が成功を先取りしない。 |

旧設計の次の詳細は実装基準から除外する。

- 0004 の自作汎用ループ、0010 の独立 ToolLoopAgent、固定DAG、常時3件、訪問 `行った/入れた/合った` の3状態、全レスポンス無条件保存。
- 写真バイト・座標・写真名の一律長期 cache、D1 生原文14日を既定値とすること、user本文だけを保存対象にすること。いずれも M31 の field/provider policy が先である。
- 固定 regex fallback、LLM 既定 off、IP位置推測、駅→店の逆向き経路、LO を閉店/退店期限へ変換すること。
- `index.html` の固定データ、desktop、WebView、`been`/`never`。データ取得・成功表示を本番証拠として扱わない。

## 8. 未解決と引継ぎ

- Think の公開API、Tool allowlist、保存前制御、キャンセル、再開、schema互換、`turnConstraints` のSDK形式/適用可否は M04 の実測待ち。両候補が不適合なら自作ループへ逃げず、証拠と設計変更を記録する。
- provider ごとの LLM送信、表示、保存、帰属、地図併用、SKU/料金、アカウント許諾は M31 の公式根拠表と M35 の設定済み環境で確認する。未確認を許可扱いしない。
- Places検索は M11、詳細は M12、方向付き徒歩は M13、終電 journey は M14、写真は M15、HP/Hot Pepper は M32 が主担当で、M24/M33〜M35 が契約・実データ・live検収を連携する。合成 Fixture は live の代替ではない。
- 提案値の12秒・6 step・各保持期間は測定で調整可能だが、変更時は適用する契約・テスト・Issueを同時に更新する。

## 9. 根拠資料の索引

- Accepted ADR の一覧と上書き関係: [ADR README](../adr/README.md)
- package/依存: [ADR0012](../adr/0012-package-dependency-boundaries.md)
- 品質: [ADR0013](../adr/0013-quality-harness-and-size-limits.md)
- iPhone/UIのDraft: [design0001](./0001-iphone-next-spot.md)、参照モック: [index.html](../../index.html)
- 残る決定: [design0002](./0002-next-decisions.md)
- 応答: [design0003](./0003-response-patterns.md)、[design0004](./0004-autonomous-response-loop.md)
- Tool契約: [design0005](./0005-tool-contracts-v1.md)
- Runtime Fixture: [design0006](./0006-fixture-runtime-validation.md)
- M01〜M05/M31の最新 Issue 本文: [#2](https://github.com/takapom/ima-app/issues/2)、[#3](https://github.com/takapom/ima-app/issues/3)、[#4](https://github.com/takapom/ima-app/issues/4)、[#5](https://github.com/takapom/ima-app/issues/5)、[#6](https://github.com/takapom/ima-app/issues/6)、[#32](https://github.com/takapom/ima-app/issues/32)。ローカルmanifestは取得時点の検証入力であり、GitHub反映済みとは扱わない。
