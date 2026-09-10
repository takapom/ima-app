# M15 写真配信：C1/C2

## 状態

C1は写真の公開tokenと、ThreadDO単位の期限付き参照を定義する。C2aはproviderの実HTTP取得とWorker内stream境界まで実装済みで、ThreadDOの実RPC接続とruntime発行経路はC2bの未完了範囲である。

```mermaid
flowchart LR
  A[Core photoRef] --> B[HMAC token codec]
  B --> C[threadIdからStoreを解決]
  C --> D[ThreadDO instance memory store]
  D --> E[photoRefをC2a transportへ渡す]
  D -. eviction .-> F[REFERENCE_UNAVAILABLE / 410]
```

## C1契約

`workers/api/src/providers/photo/token.ts` は、最大30分のTTLとHMAC署名を持つ短いtokenを発行する。tokenにはproviderの`photoRef`、owner credential、deviceの原文を入れない。`threadId`は公開opaque IDとして対象ThreadDOを解決するために署名payloadへ含める。ownerとdeviceは短いdigestでscopeを検証する。

token発行・検証は`PhotoReferenceStoreResolver.resolve(threadId)`でThreadDO単位のstoreを選ぶ。storeにはtoken handle、owner、thread、device digest、provider `photoRef`、expiryだけを保持する。worker global MapやHTTP requestごとのstoreを前提にしない。

`workers/api/src/providers/photo/reference-store.ts` のmemory実装はThreadDOインスタンスへの注入を想定し、最大256件を保持する。evictionまたはDO再起動で参照が失われた場合は`REFERENCE_UNAVAILABLE`として扱い、C2のHTTP境界で410へ変換して最新Detailsから再発行する。provider bytesはこのstoreへ保存しない。

Base64URLはdecode後の再encode一致を検証し、非canonical表現を受け付けない。最大長のGoogle photo nameと最大scopeでもtoken上限512文字以内に収まることを回帰テストで確認する。

## C2への引き継ぎ

`workers/api/src/providers/photo/media.ts` と `transport.ts` はC2所有であり、C1のstage対象に含めない。C2では、authenticated owner/deviceとtoken scopeの確認、対象ThreadDOの実resolver接続、Google photo endpointのstreaming、size/timeout/cancel、redirect先へのAPI key非転送、410/429/error envelope、帰属metadataを実HTTP/bootstrap境界で検証する。

## C2a検証済み範囲

`transport.ts` はmetadata取得と画像取得を一つのdeadlineで管理し、API keyをmetadataリクエストのheaderだけへ設定する。画像URLは `https://lh3.googleusercontent.com` のHTTPS・標準port・認証情報なしに限定し、URL redirectと任意hostを受け付けない。metadata JSON、画像のContent-Type、Content-Length、stream読取の各上限を検査し、timeout/cancel時はAbortControllerだけに依存せずreader.cancel()まで実行する。レスポンス到着とabortが競合する場合もreader/listener登録直後の状態を再確認する。

`photo/http.ts` は認証済みowner/deviceと署名tokenを検証してからprovider streamを返し、`router.ts` は公開descriptorと期限を検証する。期限切れまたはdescriptor不正時には未消費streamをcancelし、レスポンスは `private, no-store` とする。transport・adapter・HTTP routerの関連テストをローカルNodeで実行済みである。

## C2b未完了範囲

実ThreadDOのper-instance参照store RPC（owner/thread/deleted/時刻検証、delete時clear）、bootstrapでのcodec/handler生成、Coreの写真観測からの非同期token事前発行と公開DTO mapper接続は、ThreadDO/runtime compositionとの契約調整後に実装する。provider bytesをDOへ保存せず、参照失効・DO eviction・削除後は410として再取得へ戻す。

## 参照

- [M15 issue #16](https://github.com/takapom/ima-app/issues/16)
- [Place Photos (New)](https://developers.google.com/maps/documentation/places/web-service/place-photos)
- [Photo token source](../../workers/api/src/providers/photo/token.ts)
- [Photo reference store source](../../workers/api/src/providers/photo/reference-store.ts)
