# M16 C1: Durable CommitPort と削除境界

## 責務

`workers/api/src/thread-runtime/commit-port.ts` はCoreの`CommitPort`をDO SQLへ接続するWorker adapterである。受け取るのは検証済みのresponse ID、revision、presentation、candidate/observationの参照だけで、応答本文やprovider payloadは保存しない。

新規確定は、所有者・thread・削除状態・expected revision・running runtime rowを同一`transactionSync`内で確認し、`thread_state`のCAS、`runtime_commit`の参照ledger、`runtime_turn`のcompleted metadataを一回で更新する。既存idempotency keyの同一内容は、card-set sidecarの再登録なしでreference replayする。内容不一致は`IDEMPOTENCY_CONFLICT`、revisionやruntime状態不一致は`STALE_REVISION`とする。

カード応答のserver-issued card-set IDはcommit前にWorkerから一時sidecarへ渡す。未commitのcancel、validation failure、disposeではsidecarを解放し、確定transaction後に残さない。

## 削除

`ThreadDO.deleteThread`は先にtombstoneを確定し、SDK停止・実行終了待ち・公開SDK履歴clearが成功した後に同一DOの`runtime_commit`を全件削除する。途中のcleanupが失敗した場合はledgerを残してエラーを返し、同じdelete idempotency keyの再試行でcleanupを完了できる位置に置く。削除後はowner確認、replay、commitとも拒否する。

## C1で確認した範囲

- 実DO SQLで初回CAS、runtime metadata、reference replay、keep message、card-set sidecarを確認。
- running row欠落、revision不正、cancel_requested、内容不一致、削除後replayを確認。
- completed rowへ異なるresponse ID、revision、card-set IDを渡した場合、結果を返さず元のruntime metadataとledgerを保持することを確認。
- 実Think native fixtureから実Durable CommitPortへ接続し、cardsの正常確定、再送、cancel経路を確認。
- `controller`のself-finalization判定は、thread revisionとcompleted rowのresponse revisionが一致する場合だけ許可する。

## 未確認・後続境界

この単位はlive providerを呼ばず、OpenAIの実鍵、provider retention、SDK全保存面のcanary、05:00 JST alarm、期限到達時の再生成・物理削除は含まない。production `RuntimeThinkHost`へ実provider/read ports/compositionを組み込む作業と、SDK history/tool/compaction/workspace/replay/KV/logのdeny-by-default監査は、同じM16内の後続単位で実装・実測する。
