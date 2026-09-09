# Think公開APIの比較検証（M04 / #5）

2026-09-10。これはSDK採用判断ではなく、保存制御に使う公開APIを切り分けた検証結果。
実Worker/DOとscripted V3 modelを使い、外部モデルAPIは呼ばない。

## 固定版と再現

WorkerのdevDependenciesに固定したThink 0.17.0、Agents 0.22.0、AI SDK 6.0.182を使用する。
Node 24.11.1、Vitest 4.1.11、Worker pool 0.22.0で次を実行する。

```sh
bunx vitest run --config vitest.think.config.ts
```

5テスト成功。各テストで外部向けglobal fetchを拒否し、呼出し回数0も検査する。
SELFとDO binding経由の実行はローカルで行う。

## 確認した境界

| 構成                                 | 実測結果                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| ThinkのbeforeToolCallのみ            | 読取とsubmitの混在stepが両方実行される。step全体の事前検査には不足                                             |
| 公開wrapLanguageModelのstream buffer | 同じ混在stepを副作用前に拒否し、tool実行0                                                                      |
| 公開SessionProviderで保存前置換      | assistant_messagesと履歴からcanaryを除去できるが、live cacheとstream chunksに残る                              |
| 公開experimental_transform           | text/tool結果をstreamで置換し、履歴・cache・stream chunksからcanaryを除去。ただし次のmodelに必要な事実も消える |
| transformとbeforeStepの併用          | 現turnだけのメモリからtool結果を次のmodel入力へ投影し、必要な事実を渡しつつ上記保存先のcanaryは0               |

SQLの各tableは読取り成否と件数を別々に返す。テストは対象tableの読取り成功と0件を両方要求する。
公開tool定義はsearch_places、get_place_details、submit_cardsの3つ。
業務PortはCore契約に沿った検証用stubであり、M09の本実装ではない。

## 解釈と未達条件

この比較用sanitizerは固定canaryで公開hookの位置を調べるためのFixtureであり、
任意の保存禁止データを処理する本番policyではない。
比較ケースごとに構成を切り替えるため、5テストの成功だけで必須ゲート全体の合格とはしない。

Thinkは第一候補として継続する。次に、共通の構成でstep検査、修復・取消・終端、
HTTP/mobile変換、保存前制御、複数turnの期限処理・再生成を統合して検証する。
compactionと復旧経路も観測対象に含め、未実測を成功として扱わない。

既定Workers AI Providerのv4モデルとAI SDK 6の互換性は別の問題。
本検証では公開getModelでV3 modelを注入するため、既定経路の成功は証明しない。

実装: `workers/api/tests/think-gate/`。
公開hookの参照: [Think lifecycle hooks](https://developers.cloudflare.com/agents/harnesses/think/lifecycle-hooks/)。
