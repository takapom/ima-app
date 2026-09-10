# M25 実モデル runner

## 境界

`workers/api/tests/model-eval-live/` は専用の Worker/Vitest pool からだけ実行する。Worker は既存の `ThreadDO` を継承し、`createLiveOpenAIProvider()` が返す実 OpenAI Responses model を計測 wrapper で包む。Think SDK の lifecycle、agentic loop、tool 実行、保存前制御は既存 production factory に委譲し、評価側でloopを再実装しない。

固定Providerは Places Search/Details の HTTP 応答だけを返す。API key は fixture の上流リクエストにだけ注入され、trace・評価結果・エラーには出さない。評価結果は公開 `AssistantResponseSchema` を検証してから `EvaluationRun` に変換する。production registryのcandidate IDとfixture dataset IDを結ぶ公開対応表がまだないため、カード応答は`CANDIDATE_ID_MAPPING_UNAVAILABLE`として採点を保留する。公開DTOから得られない根拠値や保存参照を推測で補わず、変換できない場合はケース失敗としてcoverageを欠損させる。

## 実行プロファイル

初回の実行可能プロファイルは `new-search` の3反復である。新規検索はHTTP入力だけで再現できるが、candidate ID対応表がない間は実行結果を未評価artifactとして出力する。`continuity`、`reason`、`compare`、保存店参照、条件変更は、前turnの公開cardSet・保存参照を同じThreadDOへ確定的にseedする接続が必要であり、この単位では実行対象に含めない。dataset全体のゲートを通過したとは報告しない。

座標はWorker入力に固定fixtureとして入る場合があるが、Coreのmodel projectionを通ったpromptをhost traceで監査する。`lat`、`lng`、精度、取得時刻、owner scopeのキーを検出した場合は重大なGPS露出として記録する。

## opt-in と検証

通常のNode/Vitest suiteはlive runnerをimportしない。専用設定は`vitest.model-eval-live.config.ts`と`workers/api/wrangler.model-eval-live-test.jsonc`で提供する。

```sh
MODEL_EVAL_LIVE=1 OPENAI_API_KEY=... \
  bunx vitest run --config vitest.model-eval-live.config.ts
```

`MODEL_EVAL_LIVE` または `OPENAI_API_KEY` が欠ける場合は `LIVE_FLAG_REQUIRED` / `MODEL_PROVIDER_KEY_MISSING` としてskipする。実モデルを実行していない状態を成功と扱わず、costは常に未計測 `null` とする。人手レビュー入力がない場合もレビュー未完了のまま出力する。

probeは`m25.live.v1`のJSON artifactとして、profile、全attemptのtrace/profile/検証済み公開response、評価済みruns、固定エラー付きfailures、profile限定のcoverage/reportを一つのレコードにまとめる。候補ID対応表不足は`unverified_mapping`、不正な公開responseを含む実行失敗は`runtime_failed`として区別し、実行失敗でもartifactを先に出力する。model callの提案tool数と実行tool数は分離し、実行数を測れない場合は`null`とする。streamがfinishなしで閉じた場合や途中errorになった場合はtraceを未完了にする。
