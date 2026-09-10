# M14 終電 journey の Core C1 境界

M14 C1 は、検証済み終電 journey の Core 契約・運行日判定・純粋な時刻計算を定義する。Worker の取込、更新、rollback、expiry、実駅データ投入は後続単位であり、この段階では本番データをseedしない。

```mermaid
flowchart LR
  Import[Worker import] --> Record[JourneyRecord]
  Record --> Validate[Core service-date validation]
  Validate --> Calculate[Core timing calculation]
  Calculate --> Submit[既存 LastTrainInfo / stay validation]
  Registry[実駅・運行データ] -.後続 M14/M33.-> Import
```

## C1契約

`serviceDate` は日本の運行日として扱い、ISO timestampをAsia/Tokyoの暦日に変換して同日または翌日だけを許可する。したがって深夜跨ぎは許可するが、運行日から離れた年月日の出発・到着は拒否する。weekdayは`serviceDate`からCoreで導出し、入力contextのweekdayが一致しなければ運行可能としない。日時の`Z`と`+09:00`の表記差は同じ瞬間として検証する。

`transfers`は全乗車区間を表す有向列である。最初の区間は`fromStationRef`から始まり、各区間の到着駅と次区間の出発駅を連結し、最後は`homeStationRef`へ到着しなければならない。時刻は非減少で、最終区間の到着時刻は`arrivesHomeAt`と一致させる。乗継がない直通journeyでは、出発から到着までの時刻関係のみを検証する。

`validFrom`と`validThrough`は両端を含み、`serviceDate`をその範囲外に置いたrecordはimport時点で`INVALID_EVIDENCE`として拒否する。`verifiedAt`からの検証可能期間は7日未満で、ちょうど7日経過したrecordは`STALE_EVIDENCE`となる。

同駅の終電計算は`not_applicable`として扱えるが、店から駅までの徒歩検証済みを意味しない。availabilityには徒歩検証が必要であることを残す。

## 独立した時刻計算

`arrivePlaceAt`は評価時刻に現在地から店舗までの実経路秒数を加える。`leaveBy`は最終出発から店→駅の経路秒数と180秒bufferを引く。`availableStaySeconds`は既存`LastTrainInfo`契約どおり、`leaveBy - arrivePlaceAt`を秒単位でfloorする。`usable`はこの終電基準の滞在条件だけで判定する。

閉店時刻は`availableStayUntilClosingSeconds`および早い退出境界として別に保持し、既存の営業時間・minimum-stay validatorが閉店と終電の早い方を検証する。ラストオーダーは到着時の注文可否だけを判定し、退店時刻や終電退出時刻へ変換しない。

Core C1の公開入口は`packages/core/src/domain/index.ts`と`packages/core/src/application/index.ts`から提供する。Workerの実provider、駅resolver、取込・保存・更新処理はこの契約へ接続する後続単位で実装する。

## C2 Worker dataset boundary

Worker C2は、取込・更新・rollback・expiryを`validateJourneyRecord`へ通し、active datasetを一つのDurable Object SQLite transactionでrevision CASする。revision履歴を先に挿入してからactive pointerを別操作で更新する構成は採用しない。transactionが途中で失敗した場合はactive pointerと履歴の双方を変更しない。

KVは現在、既存datasetを読むためのread-only adapterとしてのみ用意する。KVへのpublish経路や本番の運用入口は未接続であり、実駅・時刻表データのseedもしない。C3で本番のdataset所有DO、管理入口、`LastTrainJourneyPort`/Routes取得との接続を定義する。

## C3a 共有datasetの所有と管理入口

時刻表はthreadごとの状態ではなく、固定名 `m14-last-train-v1` のSQLite-backed `JourneyDatasetDO` が一つのactive revisionと履歴を所有する。Workerの管理入口は `/internal/m14/last-train` に限定し、通常の `/v1/*` routerへ渡さない。入口はAPP_TOKENやowner credentialと別の管理credentialを検証し、入力の `import`、`update`、`rollback`、`expire` はstrict schemaで受け、時刻はrequest bodyから読まずWorkerのserver clockを一度だけ採取してDO RPCへ渡す。

管理入口はdataset payloadを公開HTTPへ返さず、revision・件数・構造化issueだけを返す。通常のturnはこのDOへ書き込まず、後続C3bの`LastTrainJourneyPort`が固定名DOのread RPCを注入して、現在のservice-date contextとCoreの共通検証器へ接続する。M33の実時刻表投入まではactive datasetが空または期限切れならdisabledを返し、fixtureを本番seedにしない。

import/update/rollbackが成功したときは、active recordの`verifiedAt + 7日`へDO alarmを予約し、期限を過ぎた検証時刻は即時alarmとして拾う。`validFrom`/`validThrough`はCoreのservice-date適用判定へ委譲し、別のalarm期限にはしない。したがって`validThrough`を含むserviceDateの跨日journeyは、到着が翌日でもCoreの契約どおり扱う。alarmはWorkerの実時計でexpire commandを実行し、read時の鮮度判定とは独立させる。rollbackで再予約し、空datasetまたは将来期限がない場合はalarmを解除する。alarm同期に失敗した管理操作は成功を返さず、適用済みrevisionを含むHTTP 500の`alarm_failed`を返す。alarm実行中の同期失敗は`alarm()`がthrowしてCloudflareのalarm再試行対象にし、管理callerは返されたrevisionを踏まえてexpire等を再実行して再同期する。Fixtureでは本番clockを置き換えず、protected clock seamだけをalarm呼出し時に上書きして境界を検証する。

## C3b Portの経路合成

`createLastTrainJourneyPort`はnamed dataset DOの`read(context)`とM13の経路Portを受け、現在地→候補、候補→乗車駅`fromStationRef`を取得してCoreの時刻計算へ渡す。serviceDate・祝日情報はHostが明示し、未設定値を推測しない。経路取得後にdatasetを再読し、消えたjourneyを使わない。Provider予算はM13が予約し、このPortでは二重予約しない。

Workerの`routeExecutionFor`は親と子executionのオブジェクト同一性を維持してキャンセル信号を橋渡しする。schema検証後のcloneへ置き換えるとWeakMapの信号を失うため、検証済みの元オブジェクトを経路Portへ渡す。CoreへAbortSignalを持ち込まない。

Port fixtureでは21:00から徒歩600秒で21:10到着、23:50発から徒歩180秒とbuffer180秒を引いて23:44退出、滞在可能9,240秒を検証した。現在のCore Port戻り値では同駅を成功値に表現できず、徒歩取得後に制約エラーを返す。次の接続単位で固有の`not_applicable`結果とDetails fieldへの変換を追加する。production factory・実駅resolverへの結線と実API検証は、このPort単体の合格には含めない。
