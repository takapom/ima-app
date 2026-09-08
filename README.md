# ima.

大切にしたい人と外出中に、次の行き先を決めるためのiPhoneアプリ。

現在はHTMLモックと設計資料、MVP実装バックログの段階です。アプリ本体・バックエンド・実API連携は未実装です。

- [UIモック](./index.html)
- [設計決定（ADR）](./docs/adr/README.md)
- [MVPのタスク・要件対応表](./docs/planning/README.md)
- [初期3操作の詳細設計](./docs/design/0005-tool-contracts-v1.md)
- [Fixture検証設計](./docs/design/0006-fixture-runtime-validation.md)

フロントはReact Native / ExpoのUI + hooks/state + services、バックエンドはCloudflareを使うヘキサゴナルアーキテクチャ。LLMがsearch_places / get_place_details / submit_cardsを自律的に選び、メッセージまたは候補UIとメッセージを返します。

実装時は最新の決定・後続ADRを優先し、旧Draftの上書き済み仕様を復活させないでください。APIキー等の環境設定後に利用できることを目指します。SDK適合性、データ供給、実機・配布条件の検証はバックログで管理します。
