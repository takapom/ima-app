# ADR 0014: 保存前制御を組み込んだThinkを採用する

- **Status:** Accepted（M04のFixture適合性。実モデル・本番運用の検収は含まない）
- **Date:** 2026-09-10
- **Decision basis:** #5の実SDK検証と主担当レビュー
- **Supersedes (in part):** [0011](0011-cloudflare-led-agent-runtime.md)のSDK未確定状態

## 決定

後続実装はThink 0.17.0を使う。Agents 0.22.0、AI SDK 6.0.182、
Valibot 1.4.2を固定し、モデルは明示的にv3 Providerとして注入する。
Think既定のWorkers AI Provider 4.0.0はAI SDK 6と互換性がないため使わない。
具体的な実モデルProviderの設定・encoding検証はM08で行う。

Thinkの既定動作をそのまま採用する決定ではない。次の制御をWorker Adapterに維持する。

- SDKのnative loopを使い、独自の汎用Agent loopを重ねない。
- 各stepの公開Toolは`search_places`、`get_place_details`、`submit_cards`の3つ。
  MCP・client・workspace操作を追加の公開経路にしない。
- Providerのstep全体を副作用前に検査し、read+submit、複数submit、final+Toolを拒否する。
  Coreへは公開Portとサーバー発行の実行文脈・取消を渡す。
- `committed`で全scenario共通に停止する。成功後の追加文章生成を要求しない。
  invalidはモデルへ返し、修正上限とstep上限を適用する。
- 保存許可を証明できない入力・Tool入出力・生成文を保存前に置換する。
  必要な原文とTool結果は当該turnのモデル入力へだけ投影し、turn終了時に破棄する。
- SDKへの保存とlive cacheの両方へ、同じ置換済み内容を渡す。
  許可された履歴の期限変更は公開Session APIを使う。sidecarに本文を入れない。
- 複数turnの由来を証明できないcompaction summaryは常に`[withheld]`にする。
- 再送記録は本文のdigestと許可された参照だけを保持する。再起動後は同じ確定IDを
  `reference_only`で返し、保存禁止の本文を完全再送しない。

Coreとcontractsの相互依存は作らず、SDK型・保存前処理・公開DTOへの変換はWorkerに置く。
根拠の業務検証はM09、実行予算の本体はM10、実DOのApplication保存はM16が担当する。

## 合格証拠

主担当が2026-09-10 03:11 JSTの通常workspaceで再実行した。

| 対象           | 結果と根拠                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| 共通Think構成  | native 12、保持9、HTTP/mobile 3の計24テスト成功。`6ede1bb`                                                    |
| 公開APIの比較  | 5テスト成功。保存後処理のみ、保存だけの置換、step単位検査なしの不十分な構成も対照として確認。`00599a2`        |
| 原文・Tool結果 | 現turnのモデル到達、保存先からの除去、次turnとDO再生成後の非再注入を確認                                      |
| 再送           | 同一要求・内容違い・古いrevision・DO再生成を確認。モデル追加0、同じ確定ID、本文非再送。単体4テストは`683b153` |
| Core・公開応答 | 公開Portへの注入と取消、根拠IDの整合性、1〜3件のカード、message、空finalを検証                                |
| 全体検査       | 単体108 + Worker 3 + AIChat比較22 + Think比較5 + Think統合24 = 162テスト成功                                  |
| 品質           | workspace型検査、lint、依存境界31ケース、format、Worker dry-run、Expo iOS export成功                          |

型検査でrootのHTTPテストに配列要素の存在確認不足を検出し修正した。
修正後のroot TypeScript検査も成功している。

再現はNode 24系・Bun 1.3.8で`bun install --frozen-lockfile`後、
`bun run test`、`bun run typecheck`、`bun run lint`、`bun run architecture`、
`bun run format`、`bun run build`。依存の完全lockfileを保存している。

## 検証の限界と第二候補

外部通信はFixtureのfetch guardで拒否している。実モデルの品質・課金・応答時間、
実店舗APIの利用条件、本番alarmの削除遅延、バックアップ保持、実機描画は未検証。
これらをM04の成功へ含めない。SDK内の未使用機能を将来有効化する場合は保存面を再検証する。

SQLの未観測は0件の成功と区別し、`_cf_KV`と`_cf_METADATA`は公開読取不可として明示する。
利用可能な公開KVとSQL、履歴、live cache、stream、ログを各Fixtureの範囲で監査した。
保存後にcanaryが消えたことだけを、保存禁止の達成とは扱っていない。

AIChatAgent 0.11.0 + streamTextも比較したが採用しない。保持context付き経路と
HTTP接続の比較テストは成功した一方、contextなしnative入力の保存前制御は未達。
比較テストの成功を、その候補の全面適合と読み替えない。

## 関連資料

- [適合性の検証記録](../design/runtime-compatibility.md)
- [Think公開APIの比較](../design/think-public-api-probes.md)
- [保持policyと監査の境界](../design/retention-fixture-policy.md)
- [package境界](0012-package-dependency-boundaries.md)
- [Cloudflare Think](https://developers.cloudflare.com/agents/harnesses/think/)
