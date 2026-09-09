# M08 モデル設定

## 状態

M08のモデル設定境界を定義する。実Provider SDKの型検査、外部モデル通信、課金、本番Secret設定は未完了である。
Provider依存の同期後に、Worker Adapterがこの設定境界を使ってProviderを生成する。

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

## 検証範囲

[`provider-config.test.ts`](../../workers/api/tests/model/provider-config.test.ts) は、
キーの欠落・空値・型不正、Fixture fallbackの禁止、固定モデル設定をNodeで検証する。
依存同期前のため、`@ai-sdk/openai`の実Provider型・transport・Responses APIのlive挙動は未検証である。

候補選定と互換性の調査根拠は
[`model-provider-candidate.md`](./model-provider-candidate.md) および次の公式資料に記録する。

- [OpenAI models](https://developers.openai.com/api/docs/models)
- [GPT-5.6 Luna capabilities](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [AI SDK OpenAI provider metadata](https://registry.npmjs.org/@ai-sdk/openai/3.0.69)
