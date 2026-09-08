# ADR 0005: レイヤの責務と結合

- **Status:** Accepted
- **Superseded in part by:** [0006](./0006-lightweight-frontend-hexagonal-backend.md)（フロントの簡素化とバックエンドの依存方向。最新の責務は0006を参照）
- **Date:** 2026-09-07
- **Deciders:** プロダクトオーナー（本議論）
- **Tags:** architecture, coupling
- **Supersedes:** なし。置き場は [0004](./0004-modular-monolith.md)。この記録は各層が何を所有し、誰を呼んでよいか

---

## 1. Context

0004 で技術分割のモジュラーモノリスを採った。残るのは、`ui / http` `app / agent` `plugins` `infra` `schema` の **責務** と **結合** である。ここが曖昧だと、エージェントが core、提案 UI が must、という契約が import で崩れる。

---

## 2. Decision

**Decision:** 依存は上から下へだけ。二つのデプロイは **schema と HTTP だけで会う。** レイヤの公開面以外を import しない。

```
mobile:  ui → app → infra → schema
worker:  http → agent → plugins → infra → schema
                 ↘ submit_cards（agent 内。世界プラグインではない）
```

禁止:

- 下の層が上を import する
- `apps/mobile` が `workers/api` を import する（逆も）
- `ui` が `infra` を直 import する
- `http` が `plugins` や Places を直 import する
- `plugins` が `http` / Hono / `SearchAgent` を import する
- `as` で schema を跨ぐ

### 2.1 schema

**所有:** 両デプロイが話す言葉。`SearchRequest` / `SearchResponse` / `PlaceCard` / プラグイン I/O / Event。副作用なし。

**呼んでよい:** なし（valibot だけ）。

**呼んではいけない:** React、Hono、cloudflare:workers、expo。

**結合:** ゼロ出。唯一の共有パッケージ。境界では必ず `v.parse`。

### 2.2 infra

**所有:** 外側との I/O。判断しない。失敗は typed error で返す。

| 面 | アダプタ |
|---|---|
| mobile | 位置、sqlite、Share / Linking、HTTP client、Attest |
| worker | Places、Route Matrix、KV、D1、Cache API、Gemini、写真バイト取得 |

**公開:** ポート関数（`getLocation`, `searchPlaces`, `kvGetJourney` …）。Hono の `Env` や React コンポーネントをポートの型にしない。

**呼んでよい:** schema、プラットフォーム SDK。

**呼んではいけない:** ui、http、app、agent、plugins。

**結合:** 外側にだけ強い。内側（agent/app）からはポート経由で弱い。Places を Gemini に差し替えてもポート名が残る。

### 2.3 plugins（Worker のみ）

**所有:** エージェントの **世界に対する選択肢**。1ファイル1プラグイン。`name` / `description` / valibot 入出力 / `execute`。

**呼んでよい:** schema、**自分が使う infra ポートだけ**。

**呼んではいけない:** http、Hono、SearchAgent、ui、PlaceCard の描画。

**結合:** カタログ登録だけ agent に見える。プラグイン同士は原則呼ばない（`evaluate_open` が Places を叩かない。店リストは引数で受け取る）。

`submit_cards` は世界プラグインではない。**agent が登録する終端アクション**である。検査（Truth SLA）と `PlaceCard` 組み立ては agent の責務。plugins が提案 UI を知ると、must の提示形が溶ける。

### 2.4 app / agent

**所有:** ユースケースと判断。世界を直接叩かない。

| 面 | 責務 |
|---|---|
| mobile `app` | スレッド（送る / 追記）、決める、残す、条件、位置許可のタイミング |
| worker `agent` | ハーネス、ペルソナ、指示スタック、ループ、Truth SLA、`submit_cards`、トレース flush |

**呼んでよい:** schema、直下の infra ポート、（worker）plugins のカタログ。

**呼んではいけない:** ui コンポーネント、Hono の `Context`、Places SDK。

**結合:** app は「画面が欲しい操作」のファサード。agent は「モデルとプラグインのループ」。mobile app は Worker agent を HTTP でだけ知る（`SearchRequest` → `SearchResponse`）。

### 2.5 ui / http

**所有:** 入口。判断しない。

| 面 | 責務 |
|---|---|
| `ui` | キャンバス、提案 UI（must）、Drawer、composer。`PlaceCard` を描く |
| `http` | ルート、`v.parse`、トークン、`getAgentByName`+`run`、写真、events、429 |

**呼んでよい:** 直下の app / agent の公開関数、schema。

**呼んではいけない:** infra、plugins、Places、sqlite。

**結合:** ui は app が渡した view だけ描く。位置を取る・検索する・残す、のボタンは app の関数を呼ぶ。http は body を agent に渡して JSON を返す。ランキングしない。

---

## 3. 面をまたぐ結合

モバイルと Worker のあいだに許すものは次だけである。

```
ui → app → infra.httpClient --SearchRequest/Response--> http → agent
```

DO をアプリから触らない。写真は `GET /v1/photos/:token`。イベントは `POST /v1/events`。リストと条件は HTTP に載せても、正は端末（app + sqlite）。

---

## 4. エラーの所有

| 層 | 失敗の形 |
|---|---|
| infra | タイムアウト・5xx を tagged error |
| plugins | 結果として `{ ok: false, code }`。世界を捏造しない |
| agent | 欠件 `SearchResponse`（hero null + warnings）または submit 拒否をモデルへ |
| http | 401/429/400。検索の0件は **200 + 欠件 body**（エージェントの判断） |
| app | トークン切れ・オフラインをユーザー操作に変える |
| ui | app が渡したコピーを出す。文言を層の外で作らない |

---

## 5. Consequences

良い結果:

- 提案 UI の must は ui に閉じ、PlaceCard は schema からしか来ない
- プラグイン追加が `plugins/` + カタログ1行で済む
- Truth SLA が agent に残り、プラグイン作者がカードを組み立てられない
- レビューは「この import は層を逆流していないか」で足りる

悪い結果:

- submit_cards を plugins に置きたくなる。置かない（SLA が下に落ちる）
- infra ポートが増える。NVP ではファイル分割で足りる。`packages/ports` は作らない

---

## 6. 参照

- [0004](./0004-modular-monolith.md)
- 設計: `docs/design/0001-iphone-next-spot.md` §4
