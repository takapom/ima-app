# M08 モデル設定

## 状態

M08のモデル設定境界とOpenAI Responses Provider factoryを実装した。
`@ai-sdk/openai` 3.0.69の依存同期と実SDK型検査を確認した。外部モデル通信、課金、本番Secret設定は未実測である。

## 固定設定

| 項目             | 値               |
| ---------------- | ---------------- |
| Provider         | `openai`         |
| API Secret       | `OPENAI_API_KEY` |
| Model            | `gpt-5.6-luna`   |
| Reasoning effort | `low`            |

設定値と欠落時のエラー契約は
[`provider-config.ts`](../../workers/api/src/model/provider-config.ts) にある。
モデル入力へAPI keyを渡さず、ログ・telemetryにも記録しない。Provider未設定時にFixture回答へ切り替えない。

## ローカル設定

ルートの[`.dev.vars.example`](../../.dev.vars.example)を`workers/api/.dev.vars`へコピーし、
ローカル環境でだけ`OPENAI_API_KEY`へ値を設定する。コピー先と実Secretはコミットしない。
リポジトリの[`.gitignore`](../../.gitignore)は`.dev.vars`と`.dev.vars.*`を除外し、
例示ファイルだけを許可している。

空文字、空白文字列、非文字列、未設定はすべて
`ModelProviderConfigurationError`（`MODEL_PROVIDER_KEY_MISSING`）になる。
このエラーはlive設定不備を示し、SDK実行やFixture成功を意味しない。

## Runtimeへの受渡し

Providerが返す`model`と`providerOptions`は、Workerの`createRuntimeTurnComposition`へ一緒に渡す。
`RuntimeThinkConnection.beforeTurn()`が設定をThinkへ渡し、各モデル呼出しに適用する。
固定値は`store: false`、`reasoningEffort: low`、`strictJsonSchema: false`である。
これらはリクエスト単位のProvider設定であり、API keyをモデル入力へ渡すものではない。

[`runtime-native.test.ts`](../../workers/api/tests/runtime-native/runtime-native.test.ts)で、
実Thinkが呼ぶscripted V3 modelの3回すべてに固定設定が届くことを確認した。
これはSDK内の配線検証であり、外部通信の検証とは区別する。

## 検証範囲

[`provider-config.test.ts`](../../workers/api/tests/model/provider-config.test.ts) は、
キーの欠落・空値・型不正、Fixture fallbackの禁止、固定モデル設定をNodeで検証する。
[`provider.test.ts`](../../workers/api/tests/model/provider.test.ts) は実ProviderをモックHTTPへ接続し、
Responsesの固定モデル・reasoning・保存設定、認証ヘッダー、キー欠落、HTTP失敗の伝播を検証する。
Responses APIのlive挙動はM35の外部検収で確認する。

候補選定と互換性の調査根拠は
[`model-provider-candidate.md`](./model-provider-candidate.md) および次の公式資料に記録する。

- [OpenAI models](https://developers.openai.com/api/docs/models)
- [GPT-5.6 Luna capabilities](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [AI SDK OpenAI provider metadata](https://registry.npmjs.org/@ai-sdk/openai/3.0.69)
