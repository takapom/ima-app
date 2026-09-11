# ima.

大切にしたい人と外出中に、次の行き先を決めるためのiPhoneアプリ。

アプリ本体・バックエンドを実装中です。ローカルでは固定データの検索経路を確認できます。実API連携・実機検収などの残件は[実装監査](./docs/design/m29-implementation-audit.md)を参照してください。

ローカルWebの起動には、Expoと固定データ用Workerの両方が必要です。[設定・起動手順](./docs/design/m28-dev-fixture.md#ローカルwebの起動)に従ってください。

- [UIモック](./index.html)
- [設計決定（ADR）](./docs/adr/README.md)
- [MVPのタスク・要件対応表](./docs/planning/README.md)
- [初期3操作の詳細設計](./docs/design/0005-tool-contracts-v1.md)
- [Fixture検証設計](./docs/design/0006-fixture-runtime-validation.md)

フロントはReact Native / ExpoのUI + hooks/state + services、バックエンドはCloudflareを使うヘキサゴナルアーキテクチャ。LLMがsearch_places / get_place_details / submit_cardsを自律的に選び、メッセージまたは候補UIとメッセージを返します。

実装時は最新の決定・後続ADRを優先し、旧Draftの上書き済み仕様を復活させないでください。APIキー等の環境設定後に利用できることを目指します。SDK適合性、データ供給、実機・配布条件の検証はバックログで管理します。
