# M04保持検証のpolicyと監査

`workers/api/tests/runtime-gate/retention/` はWorker内のSDK適合性Fixture。
Coreの保持メタデータ契約を使用し、実行時計を注入する。

`retention-policy.ts` はサーバー発行のowner/thread/turnと保持情報を検証し、
deny・unknown・期限切れのメッセージを同一IDの固定参照へ置換する。
`retention-fixture.ts` は公開persistMessagesへの期限処理とテスト用時計を提供する。
ここには保存を代行するMapや成功を返すSDK mockを置かない。

`retention-audit.ts` は本文を返さず、marker件数・参照状態・読取り成否を返す。
SQLはFixture専用BEFORE triggerによる書込み観測と全tableの読取りを分ける。
公開KV list/getは保存後の読取りであり、保存前の書込み0を証明するものではない。

policy単体の9ケースは次で再現できる。

```sh
bunx vitest run --config vitest.config.ts workers/api/tests/runtime-gate/retention/retention.test.ts
```

単体の成功だけではSDKの保持要件合格としない。実DOへの接続、stream・履歴・
複数turn・再生成・削除・compactionの検証はruntime側で別途要求する。
このFixtureはM16の本番永続化実装を代替しない。
