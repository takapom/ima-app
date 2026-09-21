# 契約とデータの扱い

## 契約の所在

入出力の正確なfield、型、上限はschemaを正とし、この文書では利用手順と意味を扱う。

| 契約                           | 実装                                                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 公開HTTP・応答・保持メタデータ | [contracts公開入口](../../packages/contracts/src/index.ts)                                                                                   |
| prefs・保存一覧・決定          | [owner-http.ts](../../packages/contracts/src/owner-http.ts)、[saved-reference-http.ts](../../packages/contracts/src/saved-reference-http.ts) |
| HTTPルートとmethod             | [router.ts](../../worker/src/adapters/in/http/router.ts)の`app.route()`から機能別Honoルーターへ辿る                                          |
| 認証・所有者scope              | [auth.ts](../../worker/src/adapters/in/http/auth.ts)                                                                                         |
| モデル向け3操作                | [tools](../../worker/src/adapters/in/tools)、[Core Ports](../../worker/src/application/ports)                                                |

## HTTPの利用手順

1. 端末がowner credentialを生成・保持し、`POST /v1/conversations`で会話IDを取得する。
2. `POST /v1/conversations/:conversationId/turns`へ新しい発言と現在の条件を送り、202でrunを受け取る。ユーザー発言は実行前に保存される。
3. `GET /v1/conversations`で一覧、`GET /:conversationId`でメタデータ、`GET /:conversationId/messages`で保存済み発言を取得する。末尾2ルートも`/v1/conversations`配下。
4. `GET /:conversationId/runs/:runId/events`の認証付きSSEで状態と検証済み完成応答を受け取る。切断時は同じrunをGETで再照会し、追加生成しない。文字単位のトークン配信ではない。
5. `POST /:conversationId/runs/:runId/cancel`で生成を中断する。会話選択や通信断は中断操作と区別する。`DELETE /:conversationId`で会話を削除する。
6. 保存は`POST /v1/threads/:threadId/saved`、決定は`POST /v1/threads/:threadId/decided`を呼ぶ。
7. `GET /v1/saved`でownerの参照と決定時刻を取得する。内容の再取得は`GET /v1/saved/:savedPlaceRef/refresh`、削除は`DELETE /v1/saved/:savedPlaceRef`を使う。
8. 保存済み条件は`GET /v1/prefs`とrevision CAS付き`PUT /v1/prefs`で管理する。

会話APIの正は[conversation-http.ts](../../packages/contracts/src/conversation-http.ts)と[conversation-routes.ts](../../packages/contracts/src/conversation-routes.ts)。会話一覧は更新日時＋IDのcursor、発言はsequenceのbeforeでページ取得する。ownerや全履歴を送信bodyへ入れない。別ownerの会話は404。会話revision競合・同時送信・同じ冪等キーの入力不一致は409。
会話の送信キー・clientMessageIdは結果不明の再送でも維持する。未完了runは会話ごとに1つ。completedは履歴DBへの回答保存確認後に返る。表示用の完成DTOは短時間の配送用であり、DO再起動後は保存可能な本文と参照だけで復元する。
既存の`POST /v1/threads`・`POST /v1/threads/:threadId/turns`・read/replayはThread単位の入口として維持する。

`cancel`・`resume`・`restart`・`end`はthreadのライフサイクル操作。`resume`は中断状態を継続し、`restart`は新turnを開始する。thread削除は保存一覧の削除と同義にしない。
ルートにはほかに検索互換入口、写真、イベント、App Integrityがある。機能別ルーターがmethodとpathを登録し、共通HTTP境界が認証・入力検証・公開エラーへの変換を行う。

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

根拠はcandidate・field・実行文脈・鮮度・由来に結び付ける。読み取りと確定の混在などの実行制約は[アーキテクチャ](../architecture/architecture.md#ランタイムの制約)に従う。
必須条件変更は原文quoteとsource turnに基づいて検証し、4つ目のToolや保存設定の変更操作にしない。

## 保存・写真・再取得

保持メタデータはsession期限、鮮度、表示期限、保存期限、削除予約、帰属、policy状態、restore modeを持つ。意味と用途別判定は[Providerポリシー](../provider-policy.md)に集約する。
保存参照のrefreshはthreadlessな一時preview。別threadや保存レコードへpayloadをコピーせず、公開直前にもowner/ref、表示許可、帰属、固定したsession期限を確認する。

写真は`GET /v1/photos/:token`から画像bytesを返す。成功はJSONではなく、許可されたContent-Type、Expires、request ID headerを持つ。失敗だけが公開JSONエラーになる。
tokenはWorker発行のowner/deviceに結び付くopaque参照であり、Providerのphoto handleや署名URLを端末へ露出しない。写真ごとの帰属を表示する。

schemaや保存形式の非互換変更は明示移行または失効で扱い、castで旧payloadを新契約に見せない。
