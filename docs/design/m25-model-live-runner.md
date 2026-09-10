# M25 実モデル runner

## 境界

`workers/api/tests/model-eval-live/` は専用の Worker/Vitest pool からだけ実行する。Worker は既存の `ThreadDO` を継承し、`createLiveOpenAIProvider()` が返す実 OpenAI Responses model を計測 wrapper で包む。Think SDK の lifecycle、agentic loop、tool 実行、保存前制御は既存 production factory に委譲し、評価側でloopを再実装しない。

固定Providerは Places Search/Details の HTTP 応答だけを返す。API key は fixture の上流リクエストにだけ注入され、trace・評価結果・エラーには出さない。評価結果は公開 `AssistantResponseSchema` を検証してから `EvaluationRun` に変換する。候補対応は host が捕捉した `provider`・`recordRef`・runtime `candidateId` と、fixture の同じ provider record identity を厳密に join する。期待辞書は検索結果の上限候補を含められるが、実際に観測したidentityはすべて対応できなければ未評価とし、公開cardのID変換時にも不足を拒否する。店舗名は対応キーに使わず、欠落・重複・矛盾は`CANDIDATE_ID_MAPPING_UNAVAILABLE`として採点を保留する。production factory→Places registration の任意 observerで登録済み `CandidateRecord` をtraceへ渡せる。`workers/api/tests/runtime-native/runtime-production-model-eval.test.ts` は実DOの公開responseまでこのmappingと評価変換を通すが、observer未接続やidentity欠落時は同じ未評価扱いになる。公開DTOから得られない根拠値や保存参照を推測で補わず、変換できない場合はケース失敗としてcoverageを欠損させる。

## 実行プロファイル

実モデルのlive runnerは`new-search`、`reason`、`compare`、`decide-action`、`clarify-ambiguity`、`continuity`の6 profileを明示的に実行対象とし、それぞれ3反復のartifactへ分ける。新規検索はHTTP入力だけで再現でき、実モデルの候補登録が取得できれば厳密なidentity対応を通して評価する。`reason`、`compare`、`decide-action`、`clarify-ambiguity`は同じThreadDOで候補カードを準備するsynthetic prelude、`continuity`はdatasetの初回turnをpreludeとして実行し、いずれも公開responseからcardSetと候補順を検証して対象turnへ渡す。`compare`、`clarify-ambiguity`、`continuity`は少なくとも2候補、`reason`、`decide-action`は要求候補を含むcard setが必要で、固定時計で候補が不足する場合は`PRELUDE_CARD_SET_UNAVAILABLE`として失敗にする。fixtureの時計や候補をlive経路へ差し替えない。preludeは反復数・対象turnのmetrics・採点へ含めず、対象turnのtraceはpreludeとの差分として記録する。複数turn用の評価側 planner は、最初の入力だけをseedし、次の同じThreadDO requestには直前のschema検証済み公開responseの `threadId`・`turnId`・`revision` を引き継ぐ。prompt文字列から前turnを疑似復元しない。

preludeがcards以外を返す、対象responseがschema不正になる、またはmessageから候補identityを安全に得られない場合は、応答を補正せず固定分類のruntime failure／`unverified_mapping`としてartifactへ残す。その他のdataset profileは未接続の`unavailable`であり、live runnerの対象へ暗黙追加しない。キーなしの専用fixtureは、同じformal context経路を外部課金なしで検証する契約として引き続き別bindingで実行する。

キーなしで検証できる `reason`、`compare`、`decide-action`、`clarify-ambiguity` は、専用binding `MODEL_EVAL_CONTEXT_THREADS` の `ModelEvalFixtureThreadDO` で実SDK/DO経路を通す fixture profile とする。最初のprelude turnで実際にcardsを確定し、公開 `AssistantResponseSchema` から `cardSetId` と候補ID順を抽出して、次の `ThreadTurnRequest` の `cardSetId`・`candidateOrder`・選択状態へ構造化して渡す。候補名やprompt本文からIDを補正せず、preludeは評価反復数に含めない。正式入力の実装は [`scenario-input.ts`](../../workers/api/tooling/model-eval/scenario-input.ts)、card contextの検証と選択ID変換は [`card-context.ts`](../../workers/api/tooling/model-eval/card-context.ts)、profile宣言は [`execution-profile.ts`](../../workers/api/tooling/model-eval/execution-profile.ts)、同一DO検証は [`card-context-profiles.test.ts`](../../workers/api/tests/model-eval-live/card-context-profiles.test.ts) にある。

compare・decide-action・clarify-ambiguityのfixtureはpreludeを19:00 JST（`2026-09-10T10:00:00.000Z`）で実行し、対象turnだけ既存の評価時計21:00 JST（`2026-09-10T12:00:00.000Z`）へ進める。時計は専用fixture DOの明示的なturn設定と正式requestの`clientNow`を同時に更新し、production runtimeの時計は変更しない。初期cardsの`displayUntil`・`sessionExpiresAt`を対象時刻と照合し、2時間後の対象candidateのDetailsだけをrefreshする。hostが捕捉したprovider record identityを評価candidateへrecordRefで対応付け、候補順の未知IDは`CANDIDATE_ID_MAPPING_UNAVAILABLE`として保留する。検索通信数が増えないこととcard set不一致の固定失敗も同じテストで確認する。

`compare`はA/B両候補を対象turnでDetails refreshし、両候補の新しい`opening_hours` evidenceを公開messageへ伝える。`decide-action`は正式contextの選択IDだけをAへ変換し、`clarify-ambiguity`は候補を選択せず追加Detailsを行わない。これらのfixtureは同一DO、正式request、provider record identityの接続を検証するもので、モデルの意味評価を成功へ補正しない。対象messageから安全なcandidate mappingを作れない場合は`unverified_mapping`を維持する。

条件変更と混合意図は、実モデルlive profileへ昇格させず、専用のkeyless fixtureとして一つのcards turnを検証する。[`condition-context.test.ts`](../../workers/api/tests/model-eval-live/condition-context.test.ts) は既存のcanonical時刻・正式scenario contextをそのまま使い、`prefs.budget` と model projectionのbudgetが `normal` であること、静かさを含む実際のPlaces検索クエリ、provider responseから得たpriceのfresh evidenceを確認する。候補は表示名で補正せず、hostが捕捉した `eval-place-a` のrecordRefと公開cardのruntime candidate IDをmappingする。検索結果のquietnessは店舗事実へ昇格せず、condition/mixed fixtureが通ることも実モデルの意味理解や評価合格を示さない。Detailsのcandidate limitはこのcanonical時刻で利用できる候補を選ぶためのfixture制御であり、実モデルの結果をcorrectifyする経路ではない。

詳細状態、期限切れ根拠、位置情報ポリシー、保存参照、prompt injection は必要な実状態または専用profileが未接続のため `unavailable` と明示する。未対応シナリオを本文注入だけで実行可能に見せず、dataset全体のゲートを通過したとは報告しない。

`candidate-failure` は keyless の fixture profile として、実際の固定 Places transport が返す 503 を production adapter の typed `UPSTREAM_UNAVAILABLE` へ通し、モデルがその構造化エラーを受けて安全な候補未取得メッセージを返す境界だけを検証する。200 の空検索は別状態として扱い、候補・Details・raw provider bodyを生成または公開しない。この profile は `liveEvaluationProfileFor` の対象外であり、fixture の成功は実モデルの品質評価や live 実行可能性を意味しない。

座標はWorker入力に固定fixtureとして入る場合があるが、Coreのmodel projectionを通ったpromptをhost traceで監査する。`lat`、`lng`、精度、取得時刻、owner scopeのキーを検出した場合は重大なGPS露出として記録する。

GPS拒否はlive profileへ昇格させず、`ModelEvalFixtureThreadDO` の実DO fixtureで境界を検証する。`ScenarioContext.areaText` は地域を明示的に入力し、地域未指定のGPSケースは`null`とする。`available`かつ`refuse-to-model`の場合もモデル投影は`status: denied`・地域`null`となり、生座標を含まない。`current_location`検索を試す境界では、位置情報不足の固定エラーをモデル側で安全化して受け、外部provider fetchが0回のまま地域確認へ進むことを確認する。これは拒否結果を成功に補正するfixtureではなく、実DOのモデル呼出し・公開message・fetch回数・座標キー監査を通す契約テストであり、productionの位置情報policy接続と実Apple/Provider実行は未検証のまま残る。

## opt-in と検証

通常のNode/Vitest suiteはlive runnerをimportしない。専用設定は`vitest.model-eval-live.config.ts`と`workers/api/wrangler.model-eval-live-test.jsonc`で提供する。fixture bindingと実モデルbindingは同じ専用pool内でも分離し、fixtureはAPI keyなしで実行する。

```sh
MODEL_EVAL_LIVE=1 OPENAI_API_KEY=... \
  bunx vitest run --config vitest.model-eval-live.config.ts
```

`MODEL_EVAL_LIVE` または `OPENAI_API_KEY` が欠ける場合は `LIVE_FLAG_REQUIRED` / `MODEL_PROVIDER_KEY_MISSING` としてskipする。実モデルを実行していない状態を成功と扱わず、costは常に未計測 `null` とする。人手レビュー入力がない場合もレビュー未完了のまま出力する。

probeは`m25.live.v1`のJSON artifactとして、profile、全attemptのtrace/profile/検証済み公開response、評価済みruns、固定エラー付きfailures、profile限定のcoverage/reportを一つのレコードにまとめる。候補ID対応表不足は`unverified_mapping`、不正な公開responseを含む実行失敗は`runtime_failed`として区別し、実行失敗でもartifactを先に出力する。model callの提案tool数と実行tool数は分離し、実行数を測れない場合は`null`とする。streamがfinishなしで閉じた場合や途中errorになった場合はtraceを未完了にする。

累計traceのnullable指標は、開始前にmodel callがない場合だけ対象turnの値として扱い、既知の過去callがあるのに差分を求められない場合は`null`にする。カウンタや配列の逆行、前置きと対象turnを区別できない位置情報は評価失敗として記録する。1ケースのruntime failureで後続profileのartifact生成を止めず、各artifactに失敗と未評価状態を残す。
