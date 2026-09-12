# ADR 0016: owner 単位の残すデータの正を Durable Object に置く

- **Status:** Accepted
- **Date:** 2026-09-12
- **Deciders:** プロダクトオーナー（本議論）
- **Issue:** #38 (M37)
- **Supersedes (in part):** [0005](./0005-layer-responsibilities.md) の「リストと条件の正は端末」
- **Related:** [0006](./0006-lightweight-frontend-hexagonal-backend.md) の「保存は出力Port」は維持。[0012](./0012-package-dependency-boundaries.md) の package 境界は維持。M16 の saved identity のみ保存は維持。

## Decision

その人が残すデータの正は、owner 単位の Durable Object 上の状態である。対象は prefs と saved place identity。

Worker の HTTP / Application は `OwnerStore` Port（async）だけを呼ぶ。DO stub と D1 型を handler に出さない。Port は `workers/api` が所有する。Core に OwnerStore / Cloudflare / D1 を置かない。

今の Adapter は既存 `SavedReferenceDO`（binding `SAVED_REFERENCES`、名前 `saved-reference-owner:{ownerScopeRef}`）。class 名は今は変えない。後続で D1 Adapter を同じ Port に挿せる。今は D1 を追加せず、空の D1 実装も置かない。

Port の操作:

- prefs: `readPrefs` / `putPrefs`（revision CAS）
- saved: `listSaved` / `register` / `read` / `remove` / `replay`（既存 saved 操作）

正の置き場:

- ThreadDO は今夜の実行器。prefs を ThreadDO SQL にコピーして正にしない。chat 本文は今夜限り。
- 端末 SQLite は投影。独立した正にしない（詳細実装は #39）。
- 検索リクエストの `prefs` は今夜の上書き。OwnerStore への暗黙 write にしない。
- 店の事実の正は Provider。OwnerStore に payload を置かない。

汎用 Repository 枠、skip_tonight、thread 索引、class rename はこの ADR の採択範囲外。

## Consequences

0005 の「リストと条件の正は端末」は、残すデータについては owner DO が正、端末 SQLite は投影へ読み替える。0006 の「保存は出力Port」は維持し、DO SQL 直結だった実装を OwnerStore Port 経由に直す。0012 の package 境界と M16 の saved identity のみ保存は維持する。

handler は永続化技術を知らない。D1 差し替えは Adapter 追加で行い、今は実装しない。

## 次の作業

`workers/api` に `OwnerStore` Port を置き、既存 `SavedReferenceDO` Adapter を挿す。端末 SQLite の投影は #39。D1 Adapter・class rename は今はやらない。
