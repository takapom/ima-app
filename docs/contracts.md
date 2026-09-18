# 契約とデータの扱い

## 契約の所在

入出力の正確なfield、型、上限はschemaを正とし、この文書では利用手順と意味を扱う。

| 契約                           | 実装                                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 公開HTTP・応答・保持メタデータ | [contracts公開入口](../packages/contracts/src/index.ts)                                                                                |
| prefs・保存一覧・決定          | [owner-http.ts](../packages/contracts/src/owner-http.ts)、[saved-reference-http.ts](../packages/contracts/src/saved-reference-http.ts) |
| HTTPルートとmethod             | [router-match.ts](../worker/infrastructure/adapters/inbound/http/router-match.ts)                                                      |
| 認証・所有者scope              | [auth.ts](../worker/infrastructure/adapters/inbound/http/auth.ts)                                                                      |
| モデル向け3操作                | [tools](../worker/infrastructure/adapters/inbound/tools)、[Core Ports](../worker/core/src/ports)                                       |

## HTTPの利用手順

1. 端末がowner credentialを生成・保持し、`POST /v1/threads`でサーバー発行thread IDを受け取る。
2. `POST /v1/threads/:threadId/turns`で入力を送り、正規化された公開応答を受け取る。
3. `GET /v1/threads/:threadId`または`/replay`で同じthreadの状態を取得する。参照のみの復元も正常な区分として扱う。
4. 保存は`POST /v1/threads/:threadId/saved`、決定は`POST /v1/threads/:threadId/decided`を呼ぶ。
5. `GET /v1/saved`でownerの参照と決定時刻を取得する。内容の再取得は`GET /v1/saved/:savedPlaceRef/refresh`、削除は`DELETE /v1/saved/:savedPlaceRef`を使う。
6. 保存済み条件は`GET /v1/prefs`とrevision CAS付き`PUT /v1/prefs`で管理する。

`cancel`・`resume`・`restart`・`end`はthreadのライフサイクル操作。`resume`は中断状態を継続し、`restart`は新turnを開始する。thread削除は保存一覧の削除と同義にしない。
ルートにはほかに検索互換入口、候補詳細、写真、イベント、App Integrityがあり、全一覧はmatcherを参照する。

内部開発認証は`X-App-Token`、`X-Device-Id`、`X-App-Version`とowner credentialを使う。
`X-Ima-Owner-Credential`は32 random bytesのpaddingなしbase64url。Workerでhashしてowner scopeを導出し、生credentialをログに残さない。
thread ID、device ID、IPだけを所有者の認可根拠にしない。request IDはheaderとbodyの対応を検証する。外部配布のApp Attestは別の検証を必要とする。

## 応答・失敗・冪等性

- `message`は既存カードを保持する`keep`、`cards`は主提案1件＋別案0〜2件へ置換する`replace`。候補0件はcardsにしない。
- 端末は`responseId`と`revision`で重複配送・古い応答を処理する。再送用参照に本文がなければ`reference_only`または`unavailable`とし、本文を推測で補わない。
- IDはowner/threadのscopeを持つ。別threadのcandidate ID・観測を自動流用しない。同じownerの保存参照から新しいcandidateを作り、現在のpolicyで再取得する。
- schemaの追加property、不正なtimestamp、revision競合、冪等キーと本文の不一致を成功へ補正しない。時刻にはoffsetを含める。
- `PublicError`は公開code・HTTP status・request ID・短いmessageを持ち、stack、秘密、他ownerの存在、Provider生エラーを漏らさない。

## 3操作と根拠

`search_places`は新規検索またはopaque cursorによる継続。`get_place_details`はcandidateと要求fieldを指定した読み取り。`submit_cards`は根拠付きのmessage・hero・altsを検証して確定する。

詳細fieldはidentity、opening_hours、price、photos、contact、facilities、walking_route、last_train。未要求の取得、未知fieldの黙殺、営業時間からの入店保証は行わない。
モデルには必要な文脈を投影し、Providerの生ID、秘密、生レスポンス、不要な座標を渡さない。

根拠はcandidate・field・実行文脈・鮮度・由来に結び付ける。読み取りと確定の混在などの実行制約は[アーキテクチャ](architecture.md#ランタイムの制約)に従う。
必須条件変更は原文quoteとsource turnに基づいて検証し、4つ目のToolや保存設定の変更操作にしない。

## 保存・写真・再取得

保持メタデータはsession期限、鮮度、表示期限、保存期限、削除予約、帰属、policy状態、restore modeを持つ。意味と用途別判定は[Providerポリシー](provider-policy.md)に集約する。
保存参照のrefreshはthreadlessな一時preview。別threadや保存レコードへpayloadをコピーせず、公開直前にもowner/ref、表示許可、帰属、固定したsession期限を確認する。

写真は`GET /v1/photos/:token`から画像bytesを返す。成功はJSONではなく、許可されたContent-Type、Expires、request ID headerを持つ。失敗だけが公開JSONエラーになる。
tokenはWorker発行のowner/deviceに結び付くopaque参照であり、Providerのphoto handleや署名URLを端末へ露出しない。写真ごとの帰属を表示する。

schemaや保存形式の非互換変更は明示移行または失効で扱い、castで旧payloadを新契約に見せない。
