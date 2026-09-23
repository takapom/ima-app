---
name: ima-provider-swap
description: ima-appの外部Provider追加・差し替え・撤去を、Coreを保ったまま2,000行以内のコミット列で進める。
---

# ima. Providerの差し替えと撤去

外部Provider（店舗検索・詳細・写真）を追加、差し替え、撤去するときに読む。
Google からHot Pepperへの差し替え（#43）で確立し、徒歩経路・終電の撤去（#55）でも使った順序。

## 原則

- **Coreの契約を変えない。** 差し替えは[Port](../../../worker/src/application/ports/operations.ts)の実装を入れ替える作業。`PlaceSearchPort`/`PlaceDetailsPort`の形を変えたくなったら、それはProvider差し替えではなく契約変更として別に扱う。
- **追加してから撤去する。** 新旧が併存する中間コミットを許し、各コミットでテストが通る状態を保つ。
- **撤去は葉から幹へ。** 参照が残っている実装を先に消さない。
- 責務と依存方向は[アーキテクチャ](../../../docs/architecture/architecture.md)、用途別policyは[Providerポリシー](../../../docs/provider-policy.md)に従う。

## 順序

各段階を1コミット以上に分け、`<type>(<scope>): <変更> (#<sub-issue番号>)`で実在番号を付ける。

1. **policy定義** — 用途別の利用範囲と保持期限を決める。実装より先に境界を固定する。
2. **新Adapter追加** — `worker/src/adapters/out/providers/<provider>/`にPort実装とHTTPを置く。既存経路は触らない。業務層へSDK・環境変数・直接I/Oを持ち込まない。
3. **構成を能力に絞る** — [composition](../../../worker/src/composition)で新Providerが提供できる能力を宣言する。提供しない機能は停止側に倒す。
4. **実行経路の切替** — `worker/src/composition/`の注入先を新Adapterへ向ける。旧実装はまだ残す。
5. **fixture更新** — 開発用fixture → SDK/DO統合fixture → 実モデル評価fixtureの順に新形式へ揃える。
6. **旧実装の撤去** — 合成経路 → Adapter → HTTP → 専用型 → 応答の正規化、の順に消す。1段ごとにコミットする。
7. **UI側の停止** — 接続しなくなった条件入力・表示をmobileから外す。存在しない機能を操作できる状態で残さない。
8. **文書更新** — [Providerポリシー](../../../docs/provider-policy.md)、[運用](../../../docs/operations.md)、[アーキテクチャ](../../../docs/architecture/architecture.md)の現行接続を実態へ合わせる。

## コミット分割

2,000行制限のため、2・6は必ず複数コミットになる。判断基準は「そのコミット単体でテストが通り、変更理由を一つの説明でレビューできるか」。
撤去側は削除行が積み上がるので、Adapter・HTTP・型・正規化を別コミットにする。圧縮や必要な試験の切離しで制限を回避しない。

## 完了条件

- 新Providerの検索・詳細・写真が固定データで通り、`bun run check`の対象ゲートが合格している。
- 旧Providerの型・HTTP・Adapter・fixture・smoke runnerが残っていない。`grep`で旧Provider名の残存を確認する。
- 提供しなくなった機能が、UI・条件入力・公開DTO・policyのすべてで停止している。
- 実接続の検収は別ゲート。固定データの成功を実API成功に数えない。判定と証跡は[ima-verification-evidence](../ima-verification-evidence/SKILL.md)に従う。
- 現在の外部接続はOpenAIとHot Pepperのみ。Providerを接続・撤去した場合は、この記述を含む文書を同じ作業で更新する。
