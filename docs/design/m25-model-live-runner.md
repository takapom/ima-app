# M25 実モデル runner

## 境界

`workers/api/tests/model-eval-live/` は専用の Worker/Vitest pool からだけ実行する。Worker は既存の `ThreadDO` を継承し、`createLiveOpenAIProvider()` が返す実 OpenAI Responses model を計測 wrapper で包む。Think SDK の lifecycle、agentic loop、tool 実行、保存前制御は既存 production factory に委譲し、評価側でloopを再実装しない。

固定Providerは Places Search/Details の HTTP 応答だけを返す。API key は fixture の上流リクエストにだけ注入され、trace・評価結果・エラーには出さない。評価結果は公開 `AssistantResponseSchema` を検証してから `EvaluationRun` に変換する。候補対応は host が捕捉した `provider`・`recordRef`・runtime `candidateId` と、fixture の同じ provider record identity を厳密に join する。期待辞書は検索結果の上限候補を含められるが、実際に観測したidentityはすべて対応できなければ未評価とし、公開cardのID変換時にも不足を拒否する。店舗名は対応キーに使わず、欠落・重複・矛盾は`CANDIDATE_ID_MAPPING_UNAVAILABLE`として採点を保留する。production factory→Places registration の任意 observerで登録済み `CandidateRecord` をtraceへ渡せる。`workers/api/tests/runtime-native/runtime-production-model-eval.test.ts` は実DOの公開responseまでこのmappingと評価変換を通すが、observer未接続やidentity欠落時は同じ未評価扱いになる。公開DTOから得られない根拠値や保存参照を推測で補わず、変換できない場合はケース失敗としてcoverageを欠損させる。

## 実行プロファイル

`new-search` の3反復だけが実モデルのlive profileである。新規検索はHTTP入力だけで再現でき、実モデルの候補登録が取得できれば厳密なidentity対応を通して評価する。複数turn用の評価側 planner は、最初の入力だけをseedし、次の同じThreadDO requestには直前のschema検証済み公開responseの `threadId`・`turnId`・`revision` を引き継ぐ。prompt文字列から前turnを疑似復元しない。

キーなしで検証できる `reason` と `continuity` は、専用binding `MODEL_EVAL_CONTEXT_THREADS` の `ModelEvalFixtureThreadDO` で実SDK/DO経路を通す fixture profile とする。最初のprelude turnで実際にcardsを確定し、公開 `AssistantResponseSchema` から `cardSetId` と候補ID順を抽出して、次の `ThreadTurnRequest` の `cardSetId`・`candidateOrder`・選択状態へ構造化して渡す。候補名やprompt本文からIDを補正せず、preludeは評価反復数に含めない。正式入力の実装は [`scenario-input.ts`](../../workers/api/tooling/model-eval/scenario-input.ts)、profile宣言は [`execution-profile.ts`](../../workers/api/tooling/model-eval/execution-profile.ts)、同一DO検証は [`context-seed.test.ts`](../../workers/api/tests/model-eval-live/context-seed.test.ts) にある。

このfixtureは19:00 JSTの時計で2候補を確定し、continuityの「2つ目」は公開card順の第二候補だけをDetailsでrefreshする。hostが捕捉したprovider record identityを評価candidateへrecordRefで対応付け、返答のevidenceにはその候補のrefresh済み `opening_hours` observationを含める。検索通信数が増えないこととcard set不一致の固定失敗も同じテストで確認する。

card set、条件変更、詳細状態、期限切れ根拠、失敗応答、位置情報ポリシー、保存参照、prompt injection は必要な実状態または専用profileが未接続のため `unavailable` と明示する。未対応シナリオを本文注入だけで実行可能に見せず、dataset全体のゲートを通過したとは報告しない。

座標はWorker入力に固定fixtureとして入る場合があるが、Coreのmodel projectionを通ったpromptをhost traceで監査する。`lat`、`lng`、精度、取得時刻、owner scopeのキーを検出した場合は重大なGPS露出として記録する。

## opt-in と検証

通常のNode/Vitest suiteはlive runnerをimportしない。専用設定は`vitest.model-eval-live.config.ts`と`workers/api/wrangler.model-eval-live-test.jsonc`で提供する。fixture bindingと実モデルbindingは同じ専用pool内でも分離し、fixtureはAPI keyなしで実行する。

```sh
MODEL_EVAL_LIVE=1 OPENAI_API_KEY=... \
  bunx vitest run --config vitest.model-eval-live.config.ts
```

`MODEL_EVAL_LIVE` または `OPENAI_API_KEY` が欠ける場合は `LIVE_FLAG_REQUIRED` / `MODEL_PROVIDER_KEY_MISSING` としてskipする。実モデルを実行していない状態を成功と扱わず、costは常に未計測 `null` とする。人手レビュー入力がない場合もレビュー未完了のまま出力する。

probeは`m25.live.v1`のJSON artifactとして、profile、全attemptのtrace/profile/検証済み公開response、評価済みruns、固定エラー付きfailures、profile限定のcoverage/reportを一つのレコードにまとめる。候補ID対応表不足は`unverified_mapping`、不正な公開responseを含む実行失敗は`runtime_failed`として区別し、実行失敗でもartifactを先に出力する。model callの提案tool数と実行tool数は分離し、実行数を測れない場合は`null`とする。streamがfinishなしで閉じた場合や途中errorになった場合はtraceを未完了にする。
