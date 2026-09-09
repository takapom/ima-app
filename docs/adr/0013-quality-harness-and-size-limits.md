# ADR 0013: 品質ハーネスとファイル・PR行数制限

- **Status:** Accepted
- **Date:** 2026-09-09
- **Deciders:** プロダクトオーナー
- **Supersedes (in part):** ADR0012のlint製品・CI方針を未決定とした記述。

## 決定と完了の区別

ESLint＋typescript-eslint、Prettier、dependency-cruiserを採用する。M02（#3）は設計決定済みの実装Issueとする。設定・正常例/違反例の検証・CI接続が完了するまでOpenを維持する。本ADRはコードやCIを実装した証跡ではない。

SDK/Expoとの互換版、具体的な設定ファイル名や検査実装の細部はM02で確認・固定する。製品選定のやり直しを着手条件にしない。

## 型・lint・整形

- TypeScript共通: strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes、noImplicitReturns、noFallthroughCasesInSwitch、forceConsistentCasingInFileNamesを有効化。module/lib/types等は環境別にし、CoreへCloudflare/Expo型を漏らさない。
- ESLint Flat Configをルート管理し、package別のoverrideを使う。typescript-eslintのrecommendedTypeCheckedとprojectServiceを基本にする。
- error: no-explicit-any、推奨のno-unsafe系、no-floating-promises（ignoreVoid:false）、no-misused-promises、only-throw-error、switch-exhaustiveness-check、no-non-null-assertion、consistent-type-imports、no-unused-vars（未使用引数の_は許可）、eqeqeq（always）、no-debugger。TS拡張ルールは@typescript-eslint名前空間で設定し、重複する標準ルールは無効にする。
- mobileではreact-hooks/rules-of-hooksとreact-hooks/exhaustive-depsをerrorにする。追加presetは採用Expo/React版との互換性を確認する。
- Prettier: singleQuote:true、semi:true、trailingComma:all、printWidth:100、tabWidth:2、endOfLine:lf。eslint-config-prettierで競合を無効化し、prettier --checkを独立実行する。

## 依存・責務の検査

- [ADR0012](./0012-package-dependency-boundaries.md)のmobile→contracts、api→contracts/core、eval→coreを維持する。coreとcontractsは相互依存なし。
- package.jsonの宣言と解決済みコード依存の両方を検査する。dependency-cruiserのtsPreCompilationDeps:trueで型依存も含める。
- 循環、未解決import、未宣言依存、公開exportsの迂回、他packageのsrcへのdeep import、相対パス/alias/type import/再exportによる違反、本番→tests/Fixture/evalを拒否する。
- Core内部: domain→domain、ports→domain/ports、application→domain/ports/applicationを許可し、逆方向を拒否する。
- CoreのSDK/直接I/O/環境変数/直接時計・乱数・ID生成を禁止する。時刻等はClockや必要な依存を注入する。
- mobile: UIの直接I/Oは禁止。hooksはstate/servicesを接続、stateはUI/ネイティブI/Oへ非依存、servicesがHTTP/SQLite/位置/共有を所有する。React Nativeの表示APIは許可し、Share/Linking等のI/O APIはservicesへ限定する。
- Worker: HTTP、Tool Binding、Runtime、Provider、Storage、Bootstrapの責務に沿いSDK importを限定する。Tool Bindingからprovider SDKを直接呼ばない。
- 既存import制限/構文検査/依存検査を先に使う。別名参照等の検出不足が確認された場合だけ、名前解決を行うローカルESLintルールを追加する。独自ルールの大量導入はしない。
- 静的検査の適用範囲と限界を記録する。3操作の実公開、保存禁止、確定1回、LLM自律性は契約/統合Fixture/実モデル評価で検証する。

## 1ファイル500行以内

- 手書きのソースコード・テスト・設定ファイルが対象。空行・コメントを含め500行まで、501行以上はCI失敗。
- JS/TSはESLint max-lines: {max:500, skipBlankLines:false, skipComments:false}。JSON等の設定を含むESLint対象外は行数検査で補う。
- 自動生成物・lockfileは対象外。生成元と除外パスを明示する。Markdown・既存HTMLモックはこのコード行数制約の対象外。
- 行数は論理的な行数とし、末尾改行だけで空行を1行追加しない。CRLF/LFで結果を変えない。補助検査とESLintの数え方を境界ケースで揃える。
- 責務と変更理由で分割する。圧縮・複数文の詰込み・拡張子や生成物扱いの変更による制約回避をしない。
- 関数の行数や複雑度には、別の一律error閾値を追加しない。

## 1PR追加＋削除2,000行以内

- PRのbase/headのmerge-baseからheadまでの最終差分で計測する。2,000行は許可、2,001行はCI失敗。
- テスト・文書・lockfile・生成ファイルを含む。500行ルールの除外をPR行数検査へ流用しない。
- バイナリは行数換算せず、件数・容量・レビュー方法を別記する。取得不足/算定不能を0行の成功にしない。
- 超える場合は独立検証可能な責務単位でIssue/PRを分割する。必要なテストを外したり元Issueを部分完了で閉じたりしない。

## CI・hooks・例外

- 必須チェック: format、lint、architecture、typecheck、test、build、pr-size。500行検査はlintチェックに含める。
- CIをmerge可否の判定元にし、required checksの保護設定も検収する。hooksは早期検知の補助であり、skipしてもCIは通過できない。
- CIはキーなしで再現可能にする。実API/実モデル/実機の検収は担当ゲートに分け、未実測を成功扱いしない。
- package単位で型・テスト・ビルド整合を検査する。デプロイ面はmobile/Workerの2つ、evalや検証runnerは本番成果物に含めない。外部資格が必要な署名buildとローカル検査は区別する。
- 原則として行単位・ルール単位のlint例外とし、理由必須。不要disableはerror。testsでも依存境界は緩めない。行数・PR制限の回避にdisableや除外を使わない。
- 自動生成物はパスを明示してlint対象から外し、再生成/型検査で確認する。規則の例外追加はレビュー対象とする。

## 担当と検収

- M01: 本ADRを実装基準へ統合。
- M02: 設定・補助検査・hooks・必須CI/保護設定と正常/違反例を実装。package境界と行数制約を機械検証する。
- 各実装Issue: 担当packageの検査に合格し、500行とPR2,000行の証跡を提出。テストは実装と同じPR。
- M28: 全機能追加後の設定/CI/runbook整合を統合。基盤検査の初回導入をここまで先送りしない。
- M29: 実成果物と各ゲートの合格を監査。M30: 配布対象と承認済みゲートを確認。
- M02では正常例・禁止package/type/alias/再export・UI直接I/O・Core SDK依存・本番→Fixture・未処理Promise・switch漏れ・499/500/501行・空行/コメント/末尾改行・PR1,999/2,000/2,001行・生成物とlockfileの算定差を検証する。
- 意図的に不正な検査Fixtureは専用パスに置き、通常lintでそのまま失敗させず検査テストから投入する。期待する違反の発生をassertし、本番からの参照は禁止する。

## 参照

- [ESLint Flat Config](https://eslint.org/docs/latest/use/configure/configuration-files)
- [ESLint max-lines](https://eslint.org/docs/latest/rules/max-lines)
- [typescript-eslint typed linting](https://typescript-eslint.io/getting-started/typed-linting/)
- [dependency-cruiser options](https://github.com/sverweij/dependency-cruiser/blob/main/doc/options-reference.md)
- [React Hooks lint](https://react.dev/reference/eslint-plugin-react-hooks)
- [Prettier](https://prettier.io/docs/install)
