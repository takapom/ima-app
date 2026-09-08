# ADR 0004: アプリは技術分割のモジュラーモノリス

- **Status:** Accepted
- **Superseded in part by:** [0006](./0006-lightweight-frontend-hexagonal-backend.md)（内部構成。1リポジトリ・2デプロイ面は維持）
- **Date:** 2026-09-07
- **Deciders:** プロダクトオーナー（本議論）
- **Tags:** architecture, repo
- **Supersedes:** なし（エージェント設計は [0003](./0003-plugins-and-dialogue.md)。これはアプリケーションの置き方）

---

## 1. Context

エージェントは core にあり、プラグインで世界を見る。店を出すときは提案 UI が must。残るのは、その周りを何個のサービスに切るかである。

一人〜少人数、NVP、デプロイは iPhone と Cloudflare の2面しかない。検索・保存・共有・写真をマイクロサービスにすると、境界のコストが本体を超える。

一方、単一ファイルの Worker と画面コンポーネントの山も、プラグイン追加と提案 UI の契約が溶ける。

採択したいのは **モジュラーモノリス（またはそれに近いシンプルなモノリス）** で、切る軸は業務コンテキストではなく **技術（レイヤ）** である。

---

## 2. Decision

**Decision:** デプロイ単位は2つだけ。リポジトリは1つ。内部は技術レイヤでモジュール化する。業務ごとにサービスを切らない。

```
ima/                      1 リポジトリ
  packages/schema         契約（valibot）。唯一の共有
  packages/eval           ゴールデン。デプロイしない
  apps/mobile             デプロイ 1: iPhone
  workers/api             デプロイ 2: Worker + SearchAgent DO
```

iPhone と Worker が分かれるのは、実行環境が違うからである。検索サービス / 保存サービス / 写真サービス、にはしない。写真プロキシも終電 KV も同じ Worker に置く。

### 2.1 技術分割

各デプロイの中は、上から下へ依存する。

```
ui / http          画面、Hono ルート。判断しない
app / agent        ユースケース、ハーネス、ペルソナ。世界を直接叩かない
plugins            エージェントの選択肢（Worker のみ）
infra              位置、sqlite、Share、Places、KV、Gemini
schema             どちらも import。境界で v.parse
```

- `ui` は Places の型を知らない。`SearchResponse` だけ見る
- `http` はランキングしない。`SearchAgent.run` に渡す
- `plugins` は Hono を知らない
- 新しい能力はプラグインモジュールを足す。新しい Worker を足さない
- 新しい画面状態は `apps/mobile` の ui / app に足す。BFF を画面用に増やさない

業務分割（`modules/search`, `modules/save` を別パッケージにして独立デプロイ）はしない。保存は端末、検索はエージェント、共有は OS の Share で、すでに置き場が違う。それをサービス境界に再実装しない。

### 2.2 シンプルさの上限

足してよいモジュール: 上記レイヤの中のファイル。  
足してはいけないデプロイ: 3つ目の Worker、別リポジトリの API、プラグインごとの Cloudflare サービス。

評価と CI は `packages/eval` に置くが、本番には出ない。

---

## 3. Consequences

良い結果:

- デプロイと秘密情報が2箇所で済む
- プラグイン追加が「フォルダを1つ足す」になる
- 提案 UI の契約は schema に残り、画面とエージェントがずれにくい
- 一人で NVP を通せる

悪い結果:

- Worker が太る。検索と写真と cron が同居する。NVP では許容する
- モバイルと Worker の型は schema 経由だけ。アプリから DO を直接叩かない（実行環境が違うための分割を、技術分割の例外にしない）

失敗しやすい形:

- 「きれいだから」と last-train を別 Worker にする
- 画面の都合で BFF を増やす
- レイヤをまたいだ `any` と `as`

---

## 4. 参照

- 設計: `docs/design/0001-iphone-next-spot.md` §4
- 各層の責務と結合: [0005](./0005-layer-responsibilities.md)
- エージェント: [0003](./0003-plugins-and-dialogue.md)
