# ADR 0006: 軽量なフロントエンドとヘキサゴナルなバックエンド

- **Status:** Accepted
- **Date:** 2026-09-08
- **Deciders:** プロダクトオーナー（本議論）
- **Supersedes (in part):** [0004](./0004-modular-monolith.md) の内部の技術レイヤ構成、[0005](./0005-layer-responsibilities.md) の一律の上から下への依存規則

## Context

Toolを差し替え可能にし、アプリケーションの状態や判断から外部技術を分離する。バックエンドにはこの境界が必要だが、入力・表示・端末保存・共有が中心のフロントへ同じ抽象化を課す必要はない。

## Decision

フロントは **UI + hooks / state + services**、バックエンドは **ヘキサゴナルアーキテクチャ（Ports & Adapters）** とする。

配置・運用はモジュラーモノリスを維持する。1リポジトリ、iPhoneとWorker + Durable Objectsの2つのデプロイ面。業務能力ごとの独立サービスは作らない。

### フロントエンド

```text
apps/mobile/src/
  screens/       画面
  components/    提案カード・入力欄・Drawer
  hooks/         送信・追記・キャンセル・保存などの操作処理
  state/         表示フェーズ・スレッド・候補・条件
  services/      HTTP・SQLite・位置・共有・地図
  theme/         色・余白・フォント
```

- UIは描画と操作受付を担当し、HTTP・SQLを直接書かない。
- hooksは必要なservicesを呼び、stateへ結果を反映する。二重送信・キャンセル・古い応答の上書き制御を操作処理に集約する。
- stateは表示と操作の状態を持つ。同じ検索結果を重複管理しない。
- servicesは通常の関数・モジュールで始める。Port、Repositoryクラス、DIコンテナを一律に導入しない。
- API境界で共通スキーマを検証する。
- 営業・徒歩・終電・推薦の判断はバックエンドが所有する。

### バックエンド

```text
workers/api/src/
  core/
    application/
      search/           ユースケース・スレッド・観測管理
      harness/          モデルとToolの実行制御
      tools/            モデル向け定義・PortへのBinding
    domain/
      observations/     観測のデータ型
      policies/         営業・徒歩・終電・候補の採用条件
    ports/
      inbound/          検索・追記・recover・終了の操作契約
      outbound/         推論・検索・経路・終電・保存・計測の能力契約
  adapters/
    inbound/
      http/
      durable-object/
    outbound/
      models/
      places/
      routes/
      last-train/
      persistence/
      telemetry/
  bootstrap/            Composition Root
```

これは論理的な配置であり、全ディレクトリやクラスの先行作成を要求しない。

- Application Coreがユースケース、スレッド、観測、状態更新、最終判断を所有する。
- 入力PortはCoreの操作、出力PortはCoreが必要とする能力を表す。契約は内側が所有する。
- Coreは具体的なAdapter、Hono、CloudflareのAgent/Env、外部SDKへ依存しない。
- Adapterは内側の契約を参照・実装する。実行時にCoreがAdapterを呼んでも、コードの依存は外側から内側へ向ける。
- Composition Rootで実装を組み立て、Coreへ注入する。
- Durable Objectはライフサイクル・RPC・実行環境への接続を担当し、検索処理をCoreへ委譲する。保存は出力Port経由とする。
- CoreはCloudflareや外部APIなしで、Fixture Adapterを使って実行・評価できる構造にする。

### Toolの境界

- モデル向けTool定義・Bindingと、外部サービスのAdapterを分離する。
- Toolは必要最小限の入力・実行文脈を受け、構造化した結果を返す。SearchAgent全体やEnv全体を渡さない。
- Toolはスレッド、UI、保存リスト、提案の確定を勝手に変更しない。観測の反映と処理の継続はApplicationが担当する。
- 将来の予約など、能力の契約に明記された外部副作用まで禁止するものではない。
- Harnessは検証、実行、期限、キャンセル、記録を担当する。
- 営業などの純粋な判定はCoreのルールとして保持できる。モデルに公開するかは別途決める。
- `submit_cards`はApplication / Agentの確定操作。観測事実と条件を検証し、最終結果を組み立てる。
- 差し替えには型だけでなく、結果の意味、精度、欠損、失敗の契約が一致することを求める。

### 両面の接続とデータ所有

- 接点はHTTPと`packages/schema`の共通データ契約。フロントからDOを直接操作しない。
- バックエンド内部のPortや業務処理は共有パッケージへ持ち出さない。
- フロントは入力・表示・選択状態と、端末の条件・保存リスト・表示復元用スナップショットを所有する。
- バックエンドは再検索用の対話文脈・観測と、営業・徒歩・終電・提案確定の判断を所有する。
- `packages/eval`はFixture Adapterと評価シナリオを持ち、本番へ配置しない。

## Consequences

フロントの抽象化を抑えながら、バックエンドの供給元・モデル・保存先を交換できる。Coreの評価に外部環境を必要としない。

一方、Portには意味のある契約が必要になる。薄いAPIのコピーや、全能力を単一の汎用`execute`で隠すだけでは差し替えを保証できない。Portの粒度とTool公開面は次の設計で具体化する。

## 次の決定

[次の設計決定一覧](../design/0002-next-decisions.md) に未決論点を記録する。このADRは構成と責務の決定であり、一覧の推奨案まで採択したものではない。
