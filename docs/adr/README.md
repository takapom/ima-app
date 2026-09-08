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

現在のアーキテクチャの正は0006、LLM主導の実行方針は0007、初期Toolカタログは0008、提示方針は0009、実行SDKの方針は0011。次の未決論点は[次の設計決定一覧](../design/0002-next-decisions.md)を参照。

新しい決定は次の連番で追加し、既存の決定を覆す場合は双方に `Supersedes` / `Superseded by` を書く。
