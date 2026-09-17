# ima.

大切にしたい人と外出中に、次の行き先を決めるためのiPhoneアプリ。
自由記述をもとに探索し、メッセージまたは主提案1件＋別案最大2件で応答します。

React Native / ExpoとCloudflare Workerで構成しています。ローカルではAPIキー不要の固定データで検索・カード表示を確認できます。起動にはExpoとWorkerの両方が必要です。

- [開発・ローカル起動](docs/development.md)
- [製品仕様](docs/product.md)
- [ディレクトリ構成・アーキテクチャ](docs/architecture.md)
- [契約とデータの扱い](docs/contracts.md)
- [Providerポリシー](docs/provider-policy.md)
- [環境・検証・配布・復旧](docs/operations.md)
- [作業規則](AGENTS.md)

実API・実モデル・実機・外部配布の検収は、固定データでの動作と区別します。未実装事項、検証結果、依存関係、完了状態は[GitHub Issues](https://github.com/takapom/ima-app/issues)で管理します。
