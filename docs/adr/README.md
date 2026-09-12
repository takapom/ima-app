# Architecture Decision Records

| ID | タイトル | 状態 | 日付 | 添付 |
|---|---|---|---|---|
| [0001](./0001-in-the-moment-next-spot.md) | その場の次スポット決定アプリ | Accepted（0002 が部分上書き） | 2026-09-06 | [UI HTML](./0001-ui.html) |
| [0002](./0002-cherished-person-lighter-load.md) | 大切にしたい人、探す役の負荷、リスト | Accepted | 2026-09-06 | |
| [0003](./0003-plugins-and-dialogue.md) | ツールはプラグイン、提案のあとに対話する | Accepted | 2026-09-07 | |
| [0004](./0004-modular-monolith.md) | アプリは技術分割のモジュラーモノリス | Accepted | 2026-09-07 | |
| [0005](./0005-layer-responsibilities.md) | レイヤの責務と結合 | Accepted | 2026-09-07 | |
| [0006](./0006-lightweight-frontend-hexagonal-backend.md) | 軽量なフロントエンドとヘキサゴナルなバックエンド | Accepted（0004・0005を部分上書き） | 2026-09-08 | |
| [0007](./0007-llm-led-tool-orchestration.md) | LLM主導の探索と能力に基づくTool設計 | Accepted | 2026-09-08 | |
| [0008](./0008-initial-tool-catalog.md) | 初期のモデル向け操作を3つに限定する | Accepted（0007を部分上書き） | 2026-09-08 | |
| [0009](./0009-contextual-response-presentation.md) | 質問に応じて候補UIとメッセージを組み合わせる | Accepted（詳細契約は未決） | 2026-09-08 | |
| [0010](./0010-sdk-based-agent-runtime.md) | AI SDKとCloudflare Agents SDKで実行基盤を構成する | Accepted | 2026-09-08 | |
| [0011](./0011-cloudflare-led-agent-runtime.md) | Cloudflare側にAgentの実行管理を集約する | Accepted（0010を部分上書き） | 2026-09-08 | |
| [0012](./0012-package-dependency-boundaries.md) | package境界で依存方向を固定する | Accepted（0006の配置を部分上書き、0015がevalを部分上書き） | 2026-09-09 | |
| [0013](./0013-quality-harness-and-size-limits.md) | 品質ハーネスとファイル・PR行数制限 | Accepted（0012の未決事項を確定） | 2026-09-09 | |
| [0014](./0014-think-runtime-adoption.md) | 保存前制御を組み込んだThinkを採用する | Accepted（M04 Fixture適合性） | 2026-09-10 | |
| [0015](./0015-eval-package-retired.md) | eval package を廃止する | Accepted（0012のeval配置を部分上書き） | 2026-09-12 | |
| [0016](./0016-owner-store-persistence.md) | owner 単位の残すデータの正を Durable Object に置く | Accepted（0005の端末正・0006の保存実装を部分上書き） | 2026-09-12 | |

現在の責務分割の正は0006、残す個人データの正は0016、package配置・依存方向は0012（eval配置は0015が部分上書き）、品質ハーネス・行数制約は0013、LLM主導の実行方針は0007、初期Toolカタログは0008、提示方針は0009、実行SDKの方針は0011、採用条件は0014。次の未決論点は[次の設計決定一覧](../design/0002-next-decisions.md)を参照。

新しい決定は次の連番で追加し、既存の決定を覆す場合は双方に `Supersedes` / `Superseded by` を書く。
