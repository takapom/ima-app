# M08モデル接続の候補確認

2026-09-10。M04はADR0014でThink採用を確定済み。この文書はM08実装・実通信の完了を示さない。

## 初期候補

アプリの初期候補はOpenAI Responses APIの`gpt-5.6-luna`、reasoning effortは`low`。
公式資料では費用を重視する用途向けで、function calling・Structured Outputs・streamingを
サポートする。検索語の事前分類や書換えをアプリで行わず、3操作をモデルに渡す用途に検討する。
この選択は実装用sub agentのLuna/max指定とは別。

費用と応答時間を重視した初期候補であり、本アプリでの精度や12秒以内の応答を保証しない。
会話参照・混合意図・根拠忠実性はFixtureと後続の実モデル評価で確認する。

## SDKとの互換性

現在のAI SDKは6.0.182で、model specification v3が必要。
`@ai-sdk/openai@3.0.69`の公開package metadataは`@ai-sdk/provider@3.0.10`を参照する。
Thinkが間接導入したOpenAI Provider 4.0.63はv4系であり、そのままAI SDK 6へ渡さない。

M08ではWorkerの明示的な依存として互換Providerを固定し、公開`createOpenAI`から
Responsesモデルを注入する。Provider未導入のため、現段階ではこの組合せの型検査・
モデル要求のencodingテストは未実施。インストール済みと扱わない。

APIキー未設定時は設定エラーとし、Fixture回答をliveとして返さない。
外部モデルへの実通信・課金・本番Secrets設定は未実施。

## 根拠

- [OpenAIモデル一覧](https://developers.openai.com/api/docs/models)
- [GPT-5.6 Lunaの対応機能](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [OpenAI Provider 3.0.69の公開metadata](https://registry.npmjs.org/@ai-sdk/openai/3.0.69)
- ローカル確認: `npm view @ai-sdk/openai@3.0.69 version dependencies peerDependencies --json`

## Provider導入時のschema検証

AI SDK 6ではOpenAIの`strictJsonSchema`が既定で有効になっている。
[AI SDK 6移行資料](https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0)を確認した。
OpenAIのstrict形式では全プロパティのrequired指定などの制約がある。
[Structured Outputs仕様](https://developers.openai.com/api/docs/guides/structured-outputs)が根拠となる。

現在のM04/M07 wire schemaは任意metadata項目を含むため、そのままstrictで
受理されるとは扱わない。Provider導入時にstrict設定またはwire schemaの変換を明示し、
実Providerの要求生成を検証する。Core/Valibotによる業務検証はどちらの方式でも維持する。
この設定・transport検証は未完了であり、Fixtureの通過で代替しない。
