# contracts v1（M03 / #4）

- 状態: 実装スライスの契約。`v1` は現在の公開契約リテラルであり、SDK実装・実API・外部許諾の完了を意味しない。
- 根拠: [ADR0012](../adr/0012-package-dependency-boundaries.md)、[ADR0013](../adr/0013-quality-harness-and-size-limits.md)、[design0005](./0005-tool-contracts-v1.md)、[design0006](./0006-fixture-runtime-validation.md)、[M03/#4](https://github.com/takapom/ima-app/issues/4)。後続ADRとM31 policyを優先する。

## 境界

`packages/contracts` は mobile と Worker の間で交換するHTTP・描画・端末保持メタデータだけを公開する。`packages/core` はPort、内部Observation、Issue、Result/FieldResult、Tool I/O、条件検証を所有し、contractsへ依存しない。Worker AdapterがDTOと内部型を変換するため、SDK型、provider生レスポンス、生provider ID、DB handle、Core内部観測は公開応答・モデル引数へ漏らさない。端末からWorkerへの認証headerと位置入力は、明示したHTTP入力契約として受け取る。

公開するのは `SearchRequest`、`SearchResponse`、`AssistantMessageResponse`、`AssistantCardsResponse`、画面用value、opaque evidence ref、保持/帰属メタデータ、events、HTTP errorである。Toolの3操作と`turnConstraints`はCore内のモデル境界契約であり、同じv1規則を使うが、mobileがimportできるcontractsの公開入口へ再exportしない。

## ID・版・時刻

- `schemaVersion` は現在 `v1` のliteralだけを受け付ける。将来の非互換版は新しいschemaと明示的な移行/失効処理を追加し、未知版をcastで受理しない。
- thread/turn/response/request/call/candidate/observation/search/saved refはアプリが発行するopaque ID。provider IDを公開IDにしない。`revision` は1以上のsafe integerで、古いrevisionの応答は確定しない。
- 時刻はISO timestampの形だけでなく、月日・時刻として解釈可能なカレンダー日付も検査する。clientNowは参考入力であり、Workerのserver clockと混同しない。
- `EvidenceRef` は`evidenceId`、表示可能な帰属、保持メタデータだけを持つ。provider recordRef、contextKey、取得内部値は含めない。

## 保持・帰属メタデータ

`RetentionMetadataSchema` は次を必須にする。

| field                                              | 意味                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `retentionDecision`                                | `allow` / `deny` / `unknown`。unknownは実効deny                    |
| `retentionMode`                                    | provider制限、owner-scoped ID、session限定、保存なし               |
| `sessionExpiresAt` / `freshUntil` / `displayUntil` | 今夜の表示窓、事実として使える鮮度、表示期限                       |
| `retentionUntil` / `deletionScheduledAt`           | 保存利用期限と削除予約。provider内容はsession/provider上限の短い方 |
| `restoreMode` / `policyStatus` / `attribution`     | reference-only復元、M31 policy状態、表示時の帰属                   |

`allow` のprovider payloadは`retentionUntil`を必須とし、`identifier_indefinite_owner_scoped` の明示保存参照だけは期限なしを許す。`deny`/`unknown` は保存期限（`retentionUntil`）と削除予約を持たないが、セッション内の一時表示のため`freshUntil`/`displayUntil`を持てる。これらもsession期限を越えず、生成文の表示・鮮度期限はsource evidenceより延長しない。M31の確認前はfixture-only、liveはdisabledであり、contractsのparse成功をprovider許諾と扱わない。

画面用fieldは `known`、`unknown`、`unsupported`、`not_applicable`、`error` を区別する。`not_applicable`（例: 電車移動不要）を欠損やprovider失敗へ変換しない。known値には最小限の`EvidenceRef[]`を付け、内部Observation全体は返さない。

## 公開応答

`AssistantMessageResponse` は `kind=message`、`presentation=keep`、メッセージ1〜4件を持つ。`AssistantCardsResponse` は `kind=cards`、`presentation=replace`、messageと`hero` 1件＋`alts` 0〜2件を持つ。カードは`candidateId`だけでなく、画面描画可能なidentity等のfactsを持ち、known factには根拠を必須にする。候補IDは重複不可、別案には`diff`根拠が必要である。候補0件はcardsにしない。成功後に追加の文章生成を必須にしない。

`SearchResponse`の外側は`requestId`・warningsだけを持ち、schema version、thread/turn/response ID、revisionは正規化されたassistant responseに一度だけ置く。thread read/replayも外側のthread/revisionを正とし、各recordにthread IDやschema versionを重複させない。

同じ正規応答に変換してからmobileへ渡し、`responseId`と`revision`で再配送・古い応答を冪等に処理する。`message=keep`は既存カードを保持し、`cards=replace`はカード集合を置換する。submit成功は表示確定であり、ユーザーの訪問・保存・共有を意味しない。

thread read/replayのrecordは`restoreMode=full`なら本文を持つ。保存禁止payloadを再起動後に完全再送せず、確定した同じ`responseId`＋`revision`だけを返す場合は`restoreMode=reference_only`または`unavailable`とし、message/cards本文を含めない。snapshotの子recordは親revision以下で、responseIdは重複させない。

## Core内の3 Tool契約

Coreのモデル境界では次の3操作だけを公開する。入力値とHarness注入値を分け、Tool callの`callId`はApplication発行とする。

```text
search_places:
  search: { mode, query(1..200), area(current_location+radius 100..3000 | named_area),
            openNow, limit 1..10, excludeCandidateIds 0..50 }
  continue: { mode: "continue", cursor }

get_place_details:
  { requests 1..5 [{ candidateId, fields 1..8 unique }],
    freshness: reuse_valid | refresh,
    travelContext?: { departure: "now", homeStationRef?, minimumStayMinutes? } }

submit_cards:
  { message 1..4 EvidenceText(1..300), hero, alts 0..2 }
```

`get_place_details` のfieldは `identity`、`opening_hours`、`price`、`photos`、`contact`、`facilities`、`walking_route`、`last_train` の固定列挙。要求されないfieldを返さず、未知fieldを無視しない。searchの結果は徒歩・終電・入店を保証しない。

`turnConstraints` は4つ目のToolではない。モデルaction envelopeのmetadataとして、`maxWalkMinutes`、`homeStationRef`、`minimumStayMinutes`のいずれか、`sourceTurnId`、原文`quote`を持つ案をCoreがstrict検証する。ユーザー発話にない条件解除、保存設定の変更、SDKが理解できない形式は受理しない。モデル出力形式・SDK hook・schema互換はM04で実測し、ここでSDK適合を先取りしない。

## HTTPルートと認証

M05はhandlerを注入し、Workerで認証・parse・DTO変換・error envelopeを行う。contractsはrouting実装を持たない。

| method | path                               | request                           | 成功                                                                       | 境界エラー                                        |
| ------ | ---------------------------------- | --------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------- |
| POST   | `/v1/threads`                      | `CreateThreadRequest`             | server-issued thread、201                                                  | 400/401/409/413/429/5xx                           |
| POST   | `/v1/threads/:threadId/turns`      | path＋`ThreadTurnRequest`         | `SearchResponse` 200                                                       | 400/401/403/404/409/413/415/422/429/5xx           |
| POST   | `/v1/search`                       | `SearchRequest`                   | `SearchResponse` 200（候補欠件も契約内）                                   | 400/401/403/409/413/415/422/429/5xx               |
| GET    | `/v1/photos/:token`                | token path                        | 200、許可済みContent-Typeの画像bytes＋`X-Ima-Request-Id`/`Expires` headers | 401/403/404/410/429/5xx（410=`EXPIRED`）          |
| GET    | `/v1/places/:candidateId`          | candidate path＋unique field mask | 再取得した公開place value、200                                             | 401/403/404/409/429/5xx                           |
| GET    | `/v1/saved/:savedPlaceRef/refresh` | owner-scoped saved reference      | thread間でcandidateIdを流用せず再取得、200                                 | 401/403/404/409/410/429/5xx                       |
| POST   | `/v1/events`                       | `EventsRequest`                   | bodyなし204                                                                | 400/401/413/429。イベント失敗は検索表示を止めない |
| GET    | `/v1/threads/:threadId`            | thread path                       | thread snapshot、200                                                       | 401/403/404/410                                   |
| GET    | `/v1/threads/:threadId/replay`     | thread path                       | 公開応答の再配送、200                                                      | 401/403/404/410                                   |
| POST   | `/v1/threads/:threadId/cancel`     | `LifecycleCommand`                | 200、revision状態                                                          | 401/403/404/409                                   |
| POST   | `/v1/threads/:threadId/resume`     | `LifecycleCommand`                | 200、同一thread継続状態                                                    | 401/403/404/409                                   |
| POST   | `/v1/threads/:threadId/restart`    | `LifecycleCommand`                | 200、新turn状態                                                            | 401/403/404/409                                   |
| POST   | `/v1/threads/:threadId/end`        | `LifecycleCommand`                | 200、終了状態                                                              | 401/403/404/409                                   |
| DELETE | `/v1/threads/:threadId`            | `LifecycleCommand`                | bodyなし204                                                                | 401/403/404/409                                   |

`PublicError` は`schemaVersion`、`requestId`、HTTP status、公開error code、短いmessageだけを返す。schemaでstatusとcodeの組み合わせを固定し、Secrets、stack、他threadの存在やprovider内部情報を返さない。401は認証不足、403はowner scope不一致、409はrevision/idempotency/schema/キャンセル競合、410は写真・cursor・根拠の期限切れ、413はサイズ超過、415はcontent type、422はstrict schema/業務入力、429はrate limit、502/504はprovider/timeout、500はWorker失敗に使う。`restart`は新turnを開始し、`resume`は同一threadの中断状態を継続する。保存参照のrefreshはowner-scoped `savedPlaceRef`を明示し、candidateIdをthread間で自動移送しない。

写真の成功bodyはJSONではない。`PhotoBinaryRouteResponse`の`bodyKind=binary`と`PhotoResponseDescriptor`はWorker/renderer間で検証するメタデータ（token、content type、期限、request ID）で、HTTPでは許可された`Content-Type`、`Expires`、`X-Ima-Request-Id`へ射影し、画像bytesをbodyにする。JSONは失敗時の`PublicError`だけに使う。写真tokenはWorker発行のopaque値で、provider handleや署名URLをmobileへ露出しない。

利用手順は、端末がowner credentialを生成して`POST /v1/threads`を呼び、返されたserver-issued `threadId`で`POST /v1/threads/:threadId/turns`を呼ぶ順序とする。`GET .../read`相当のread/replayは同一threadの公開recordを再配送する。`resume`は中断したturnを同一threadで継続し、`restart`は新turnを開始する。保存店のrefreshは保存参照から公開factsを再取得し、別threadのcandidate IDを持ち込まない。

既存のInternal TF契約として、`APP_TOKEN` envの値を`X-App-Token`へ送り、`X-Device-Id`（レート制限の補助情報）と`X-App-Version`も常時送る。`X-App-Token`はWorkerの共有app token検証に使い、mobileの公開IDや推測値を認可根拠にしない。内部MVPのowner credentialは端末が32 random bytesを生成し、paddingなしbase64url（43文字）で`X-Ima-Owner-Credential`へ追加送信する。WorkerだけがSHA-256でhashし、hashからowner scopeを導出する。threadId単独やIP推測は認可根拠にしない。`X-Ima-Request-Id`も境界で検証する。App AttestはM27/M05の別ゲートであり、Internal TFの開発認証を置換しない。

## JSON・移行・検証

具体例は次を最低限固定する。

1. Searchの正常、named area、位置拒否、continue、cursor期限、0件。
2. Detailsのfieldごとのknown/unknown/unsupported/not_applicable/error、追加property、未知field、候補重複。
3. submitのmessage-only、cards、invalid evidence→repair、成功、重複候補、古いrevision、再配送。
4. HTTPのrequest ID、owner scope、error status、cancel/restart/end/delete、events、photo/保存参照の期限。

ABI・保存データ・schema/capability versionの非互換変更は、旧payloadを黙ってcastせず、明示移行または失効して`SCHEMA_MISMATCH`を返す。Fixtureの合格はSDKの保存前制御、provider許諾、live APIの合格ではない。M04の実SDK検証結果を受け、Coreのmodel envelopeやAdapter変換を更新する。
