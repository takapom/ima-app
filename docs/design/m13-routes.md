# M13 Routes ComputeRouteMatrix 境界

2026-09-10。M13の最初の実装単位は、WorkerからGoogle Routes ComputeRouteMatrixへ送るWALKリクエストと、返却された有向行列をCoreへ渡せる形へ正規化する責務に限定する。店舗候補の採用、位置の鮮度・精度、滞在条件、表示文言はCoreが所有する次の単位で扱う。

```mermaid
flowchart LR
  Core[Core WalkingRoutePort] --> Adapter[Worker Routes adapter]
  Adapter --> Transport[固定WALK HTTP transport]
  Transport --> Google[Google Routes ComputeRouteMatrix]
  Google --> Parse[一度だけのresponse parse]
  Parse --> Normalize[有向index正規化]
  Normalize --> Core
  Budget[Runtime budget] -. 1 request + origin×destination elements .-> Transport
```

## リクエスト

`POST https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix`へ、`travelMode: WALK`と緯度経度のwaypoint配列を送る。endpointとfield maskは固定し、redirectは`error`にする。field maskは`originIndex,destinationIndex,status,condition,distanceMeters,duration`に限定する。現在位置から候補、候補から帰宅駅という方向を保つため、配列の順序とindexを入れ替えない。origin内、destination内のrefは一意でなければならないが、同じ場所が両配列に出現することは許可する。

呼出元は実行前に`routeElementCount(request)`で`origins.length * destinations.length`を求め、provider HTTP request 1件と同数のroute elementsをRuntime budgetへ予約する。transportはretryを実行せず、Retry-Afterを型付きエラーへ渡して再試行判断をRuntime側へ残す。

## レスポンスと正規化

Googleのレスポンス配列はpairの到着順を保証しないため、`originIndex`と`destinationIndex`で再構成し、Coreへはorigin-major/destination-majorの全requested pairを返す。RESTのper-element failureは行列全体を捨てず、次の結果へ分類する。

| provider結果                      | 正規化結果                  |
| --------------------------------- | --------------------------- |
| `ROUTE_EXISTS`かつ有効なduration  | `route`                     |
| `ROUTE_NOT_FOUND`                 | `unreachable`               |
| 非0 status、型不正のindexed field | `element_error`             |
| requested pairに要素がない        | `missing`                   |
| duplicate/index範囲外など構造不正 | 行列全体を`SCHEMA_MISMATCH` |

`originIndex`と`destinationIndex`はProtoJSONのimplicit scalar defaultに合わせて省略時を0として扱う。`duration`はpresenceを持つprotobuf Duration messageなので、`ROUTE_EXISTS`で省略・不正なら`element_error`とする。距離はscalarのため省略時を0として扱う。durationの小数秒はCoreの安全な整数秒を下回らないようceilする。表示上の分への変換はこのadapterでは行わず、公開/Core側で`ceil(seconds / 60)`を適用する。

parserはproviderの未許可フィールドや本文を保持せず、pair単位で検出したstatus・distance・durationの型不正だけを`parseError`として残す。normalizerは検証済みのparsed responseを受け取り、raw JSONを再parseしない。raw入力を受ける補助関数もparseを一度だけ行ってから同じnormalizerへ渡すため、要素エラーが成功routeへ変わらない。

## 期限・取消と次の境界

timeoutはfetchだけでなくresponse bodyの読取とJSON parseまで含む。呼出元の`AbortSignal`は同じ処理へ伝播し、期限切れ・取消・HTTP失敗・schema失敗を型付きエラーへ変換する。upstream本文やAPI keyはエラーへ含めない。

locationのfreshness、accuracy、revisionの照合と、Coreの`WalkingRoutePort`へ接続するcurrent→candidate / candidate→stationの業務制約は次の実装単位で行う。このtransport単位だけで候補の営業可否や徒歩表示を確定しない。

## 公式仕様

- [Compute Route Matrix REST reference](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRouteMatrix)
- [Compute Route Matrix guide](https://developers.google.com/maps/documentation/routes/compute_route_matrix)
- [Choose fields to return](https://developers.google.com/maps/documentation/routes/choose_fields)
- [ProtoJSON format and implicit scalar defaults](https://protobuf.dev/programming-guides/json/)
