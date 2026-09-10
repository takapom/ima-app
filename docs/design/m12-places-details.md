# M12 Places Details Adapter：C1/C2境界

## 状態

この文書は、M12で最初にレビュー可能にする単位を定める。fixtureは生成データであり、Googleのアカウント・API key・課金設定・本番帰属設定の承認を意味しない。

```mermaid
flowchart LR
  A[Google Place JSON fixture] --> B[wire allowlist]
  B --> C[identity / hours / price / contact / photo normalizer]
  C --> D[Worker normalized values]
  D --> E[後続HTTP client / Core Port adapter]
  F[facilities / walking / last_train] --> G[unsupported]
```

## C1の責務

`workers/api/src/providers/places/wire.ts` は、M11検索とM12詳細取得が共有するGoogle Places REST `Place` のraw境界である。必要なsubsetだけを読み、未知propertyはstripする。Google応答はnormalizerへ渡す前にparseし、正規化結果にはCoreが扱わないprovider payloadを残さない。`parseGooglePlaceWireField` は要求field単位でparseするため、無関係fieldの不正値が有効な結果を消さない。

`identity.ts` はdisplay name、Hostが注入したarea label、住所、primary type、business status、HTTPSのGoogle Maps source URLを既存Core `PlaceIdentity`へ変換する。areaは`formattedAddress`から推測しない。`FUTURE_OPENING`はCoreに対応する状態がないため`unknown`へ変換し、元statusはWorker内部metadataだけに残す。移転先も内部resolver用metadataに保持するが、自動追跡や候補差し替えは行わない。

`values.ts` はGoogleのprice level、完全な同一通貨のprice range、contact link/phone、photo metadataを変換する。有限な上限がないprice rangeはknown rangeにせず、levelだけを保持できる。円換算や金額の推測はしない。写真はCoreのphoto referenceと帰属だけを最大3件保持し、表示可能なauthor attributionがない写真はwithholdする。photo referenceはprovider内部handleであり、公開`photoToken`への変換はWorker response/M15境界の責務である。

normalizerは`known`、`unknown`、明示的なschema/source-conflict errorを返す。Observation生成、Registry書込み、SDK呼出し、Application state変更は行わない。Observation ID、`fetchedAt`、freshness、retention、`reuse_valid`は後続のM06/M07 compositionが注入する。

## 契約の引き継ぎ

Coreのdetails契約は候補1〜5件と要求field集合の完全一致を要求する（`GetPlaceDetailsInputSchema`、`matchesDetailsRequest`）。後続adapterは正規化値をCore `FieldResult` observationへ変換し、候補単位のpartial resultを保持する。`facilities`、`walking_route`、`last_train`はGoogle adapterでは明示的なunsupported結果にする。

M11はGoogle root attributionの別型を持たず、共有wire shapeを使う。特にGoogleの`attributions`は`{provider, providerUri}` object配列であり、`timeZone`はPlace root fieldである。営業時間の検索transportはraw itemを保持せず、M12の共有wireから正規化する。

## C2 営業時間の正規化

`workers/api/src/providers/places/hours.ts` は `currentOpeningHours.periods` を主入力とする。M11 adapterからはserver clockのRFC3339文字列を受け取り、単体検証では同じ値を`{ evaluatedAt }`として渡せる。各periodの日時をPlace rootのIANA `timeZone`で解決し、Coreの `OpeningHours.intervals` へ絶対RFC3339の半開区間として出力する。close省略の24時間periodは`endAt: null`で表し、翌0時を実閉店として生成しない。入力のperiod順や `weekdayDescriptions` のロケール順を曜日順と解釈しない。通常週の表示文がある場合は`regularOpeningHours`を優先し、`currentOpeningHours.specialDays`や特殊日periodで通常週を上書きしない。

Googleのprotobuf scalar省略値（`day`、`hour`、`minute`）は0として扱う。`close`なしの`day=0/hour=0/minute=0`だけを公式の常時営業マーカーとして`endAt: null`へ変換し、日付が省略されている場合は評価時刻のPlace現地日を開始日にする。日付のない非24時間period、無効な日付、IANA timezone不在は`unknown`とする。DSTの不存在時刻と重複時刻は一意に解決できないため`unknown`とする。

`truncated`なopen端点はGoogleが返した有効な窓の開始境界として扱えるが、`truncated`なclose端点を実閉店時刻として保存しない。そのperiodを`unknown`にして、切詰めによる閉店時刻の捏造を防ぐ。`nextOpenTime`/`nextCloseTime`はRFC3339として検証し、`openNow`と反対側の境界、過去の境界、現在periodの境界、空periodとの不整合は`SOURCE_CONFLICT`とする。

`hours.test.ts` は東京の通常週・特殊日・跨日・24時間、protobuf省略値、切詰め、空period、欠落/不正timezone、DSTの不存在/重複時刻、境界不整合を2026年固定fixtureで検証する。実API・API key・Secretsは使用しない。

## 参照

- [M12 issue #13](https://github.com/takapom/ima-app/issues/13)
- [Place Details (New)](https://developers.google.com/maps/documentation/places/web-service/place-details)
- [Places REST resource](https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places)
- [Place Photos (New)](https://developers.google.com/maps/documentation/places/web-service/place-photos)
- [Places policies](https://developers.google.com/maps/documentation/places/web-service/policies)
- [Core details Port](../../packages/core/src/ports/operations.ts:104)
