---
name: impeccable
description: >-
  ima-app のReact Native / Expo UIを設計・レビュー・改善する。
  画面構成、情報の優先順位、余白、配色、文言、状態表示、操作性を扱う。
  Web向けの検査・live操作はExpo Webを明示的に対象にした場合に使う。
  バックエンドのみの変更や、UIと無関係な文書整理には適用しない。
---

# ima-app のUI設計・改善

## 最初に読むもの

1. [README](../../../README.md)と[製品仕様](../../../docs/product.md)で対象画面の目的を確認する。
2. [アーキテクチャ](../../../docs/architecture/architecture.md)と、[Mobileの実装](../../../apps/mobile/src)の対象画面・既存コンポーネント・テーマを読む。
3. アプリ画面には [reference/product.md](reference/product.md) を使う。
   LPなどの制作依頼がある場合だけ [reference/brand.md](reference/brand.md) を使う。
4. 下表から依頼に対応する参照資料だけ読む。設計・監査の依頼を実装へ広げない。

## 同梱資料の適用範囲

以下は同梱の汎用Web資料より優先する、ima-appでの読み替え。

- `PRODUCT.md` は [docs/product.md](../../../docs/product.md) を読む。
  `DESIGN.md` は既存のテーマ・コンポーネント実装を調べる指示として扱う。
  文書の不足だけで停止したり、ルートに別の仕様書を作ったりしない。
  仕様変更の文書化は[開発方針](../../../docs/devlop/development.md#文書の更新)に従う。
- UIはReact Native / Expoを使う。CSS、DOM、Tailwind、Next.js、ブラウザ用アニメーションの例は
  Nativeへ直接適用しない。採用API・色表現・ライブラリは[manifest](../../../apps/mobile/package.json)と既存実装で確認する。
- 候補カードは製品仕様の表現。汎用の「カード禁止」や装飾上の好みで必要な機能を撤去しない。
  色・フォント・角丸を一律の値へ変更せず、対象画面の可読性・操作性と既存テーマを根拠にする。
- 待機・失敗・0件・未確認の表示、文字拡大、Safe Area、キーボード、VoiceOver、動きを減らす設定を検討する。
  Webプレビューの成功をiOS実機の合格としない。
- `craft` の確認ゲート・画像モック・パレット質問は、必要な判断が未決の場合に限る。
  依頼と現行仕様で決まる修正を再承認待ちにしない。画像生成があることだけでモック作成を必須にしない。
- `critique` や `polish` の結果は会話で示す。保存する課題・計画・検証証跡はGitHub Issueで管理し、
  `.impeccable/critique/` に報告書を追加しない。Issueへの書き込みはその依頼の範囲に従う。
- 本スキルの存在だけでsub agentを起動しない。委任が依頼・許可されている場合の担当分離は[作業規則](../../../AGENTS.md)に従う。

## スクリプトと検証

コマンドはリポジトリルートから実行する。同梱スクリプトの場所は `.codex/skills/impeccable/scripts/`。
通常のNative UI作業では現行文書を直接読み、`context.mjs`・`context-signals.mjs` の
Webプロジェクト初期化や更新案内を手順として実行しない。このローカル調整を上流更新で上書きしない。

`live` とHTML/CSS detectorはWeb用。Expo Webで必要なDOM・起動方式に対応するかを先に確認し、
未対応なら既存のブラウザ操作やSimulatorで検証する。NativeへHTMLスクリプトを注入しない。
動作未確認の補助ツールを利用可能と断定しない。

`pin` / `unpin` は複数の設定ディレクトリを書き換える補助機能。明示的に依頼された場合だけ
[pin.mjs](scripts/pin.mjs)の対象を確認して実行する。

検査は[開発方針](../../../docs/devlop/development.md#品質検査)、検証結果の判定は
[ima-verification-evidence](../../../.agents/skills/ima-verification-evidence/SKILL.md)に従う。

## コマンド別資料

引数がない場合は依頼・対象画面から必要な改善を提案する。対応するコマンドが明確ならその資料を読み進める。

| Command | Category | Description | Reference |
|---|---|---|---|
| `craft [feature]` | Build | Shape, then build a feature end-to-end | [reference/craft.md](reference/craft.md) |
| `shape [feature]` | Build | Plan UX/UI before writing code | [reference/shape.md](reference/shape.md) |
| `init` | Build | Read existing product, architecture, and UI context | [reference/init.md](reference/init.md) |
| `document` | Build | Check existing UI tokens and update current documentation | [reference/document.md](reference/document.md) |
| `extract [target]` | Build | Pull reusable tokens and components into design system | [reference/extract.md](reference/extract.md) |
| `critique [target]` | Evaluate | UX design review with heuristic scoring | [reference/critique.md](reference/critique.md) |
| `audit [target]` | Evaluate | Technical quality checks (a11y, perf, responsive) | [reference/audit.md](reference/audit.md) |
| `polish [target]` | Refine | Final quality pass before shipping | [reference/polish.md](reference/polish.md) |
| `bolder [target]` | Refine | Amplify safe or bland designs | [reference/bolder.md](reference/bolder.md) |
| `quieter [target]` | Refine | Tone down aggressive or overstimulating designs | [reference/quieter.md](reference/quieter.md) |
| `distill [target]` | Refine | Strip to essence, remove complexity | [reference/distill.md](reference/distill.md) |
| `harden [target]` | Refine | Production-ready: errors, i18n, edge cases | [reference/harden.md](reference/harden.md) |
| `onboard [target]` | Refine | Design first-run flows, empty states, activation | [reference/onboard.md](reference/onboard.md) |
| `animate [target]` | Enhance | Add purposeful animations and motion | [reference/animate.md](reference/animate.md) |
| `colorize [target]` | Enhance | Add strategic color to monochromatic UIs | [reference/colorize.md](reference/colorize.md) |
| `typeset [target]` | Enhance | Improve typography hierarchy and fonts | [reference/typeset.md](reference/typeset.md) |
| `layout [target]` | Enhance | Fix spacing, rhythm, and visual hierarchy | [reference/layout.md](reference/layout.md) |
| `delight [target]` | Enhance | Add personality and memorable touches | [reference/delight.md](reference/delight.md) |
| `overdrive [target]` | Enhance | Push past conventional limits | [reference/overdrive.md](reference/overdrive.md) |
| `clarify [target]` | Fix | Improve UX copy, labels, and error messages | [reference/clarify.md](reference/clarify.md) |
| `adapt [target]` | Fix | Adapt for different devices and screen sizes | [reference/adapt.md](reference/adapt.md) |
| `optimize [target]` | Fix | Diagnose and fix UI performance | [reference/optimize.md](reference/optimize.md) |
| `live` | Iterate | Visual variant mode: pick elements in the browser, generate alternatives | [reference/live.md](reference/live.md) |
