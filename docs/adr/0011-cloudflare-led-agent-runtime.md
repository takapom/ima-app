# ADR 0011: Cloudflare側にAgentの実行管理を集約する

- **Status:** Accepted（基盤方針と選定順序。Thinkの適合性は未検証）
- **Date:** 2026-09-08
- **Deciders:** プロダクトオーナー（本議論）
- **Supersedes (in part):** [0010](./0010-sdk-based-agent-runtime.md) の独立したToolLoopAgentを主実行ループとして採用する構成

## Decision

Cloudflare Agents SDK系の基盤を中心に、会話・状態・Agentの実行管理を集約する。独立したVercel AI SDKのToolLoopAgentを重ねて二重の実行管理を作らない。

汎用のTool Calling・Agentループをスクラッチで実装しない方針は維持する。AI SDKがCloudflare側の基盤や接続に必要な場合、下位の実装依存として利用する。依存パッケージを厳密に一つへ減らす決定ではない。

## 選定順序

1. **Think（@cloudflare/think）を第一候補として適合性を検証する。** モデル・Toolを登録し、ループと会話管理をCloudflare側へ委ねる。
2. 下記の要件を満たせない場合、**AIChatAgent（@cloudflare/ai-chat）+ AI SDKのstreamText**を使う。AI SDK標準の複数ステップ実行を利用し、独自の汎用ループは作らない。

Thinkは確認時点の公式資料でExperimentalとして扱われている。今回採択したのは優先順位と検証条件であり、本番適合・バージョン互換性を検証済みとするものではない。

## 維持するアーキテクチャ

- フロント: React NativeのUI + hooks/state + services。SDKの標準チャットUIへ置き換えることを要求しない。
- バックエンド: ヘキサゴナル。SDK継承・メッセージ形式・Tool Bindingは外側のAdapterへ置く。
- Core: 能力契約、観測、根拠・鮮度の検証、提案の確定ルールを所有する。
- LLM: 原文・文脈を理解し、自律的にToolと回答形式を選択する。
- 初期操作: search_places / get_place_details / submit_cardsの3つ。
- AI SDKやCloudflareの型をCoreへ漏らさない。汎用SDKのラッパー階層を必要以上に増やさない。

## 適合性検証と合格条件

| 検証 | 合格条件 |
|---|---|
| Tool公開面 | モデルが使える操作を初期3つに限定できる。組み込みのファイル・シェル・メモリ操作等を意図せず公開しない |
| 自律選択 | 固定の検索順序を要求せず、Tool不要の回答も可能 |
| 提示 | メッセージのみ、候補UI + メッセージの両方を独自の応答契約へ接続できる |
| submit | 検証失敗をモデルへ返し、修正可能。成功を一度だけ確定できる |
| 保存 | 会話・観測の保持期限とprovider別保持方針を守れる。SDKの自動保存を無条件に採用しない |
| 通信 | 既定のHTTP境界とiPhone UIへ接続できる。WebSocket必須等の差分があれば明示する |
| 制御 | キャンセル、実行予算、古い応答の確定拒否を実現できる |
| スキーマ | valibot契約を必要なSDK形式へ接続できる |
| 更新 | 固定バージョンでFixture評価が再現し、SDK更新時の契約テストを置ける |

実装担当は公式の公開APIとFixtureで確認し、成功/不適合の証拠を残す。適合のために汎用ランタイムを再実装する必要がある場合は、第二候補へ進む。アプリ固有の根拠検証までSDKが提供すると期待しない。

## 次の作業

具体的なケース・合格条件・保存方針の提案は[Fixture検証設計](../design/0006-fixture-runtime-validation.md)を参照。この設計案の詳細・数値は本ADRの採択事項とは区別する。

SDKの互換バージョンを選び、小さな検証実装で「直接メッセージ」「Tool調査から候補提示」「submit失敗から修正」「公開Toolの限定」「保存方針」を確認する。ライブ店舗APIを接続する前にFixtureで行う。

このADR作成時点ではパッケージ導入・検証実装は未実施。具体的な基底クラスとSDKバージョンは検証結果として確定する。

## 根拠（2026-09-08確認）

- [Cloudflare Think](https://developers.cloudflare.com/agents/harnesses/think/): Toolループ・会話管理、AI SDK依存、Experimentalの位置づけ。
- [Think Tools](https://developers.cloudflare.com/agents/harnesses/think/tools/): Tool公開面と組み込み能力。
- [Cloudflare Chat agents](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/): AIChatAgentとonChatMessage、streamTextによる接続。
