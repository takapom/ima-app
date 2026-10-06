# ima-app 作業規則

コードと機械検査で分かることは書かない。ここにはこのリポジトリ固有の判断と、検査で検出できない規則だけを置く。

## 最優先

- **mainから作業ブランチを切って作業し、PRでmainへ取り込む。mainへ直接コミット・pushしない。**
- **現行仕様は[README](README.md)から辿る文書が正。** 過去のIssueやGit履歴から、古い仕様や撤去済みの依存を復活させない。
- **実行していない検査を合格と報告しない。** Fixture、実SDK、実API、実モデル、実機の成功を区別する。

## 実装

- 責務分割・package境界・依存方向・データの正は[アーキテクチャ](docs/architecture/architecture.md)、入出力の契約は[契約とデータの扱い](docs/devlop/contracts.md)に従う。ディレクトリ配置が合っているだけで適合と判断しない。
- 不明・未対応・取得失敗・0件を区別する。例外を握りつぶして成功に見せず、型キャストで契約の不整合を隠さない。
- 見た目が似ているだけで責務の異なる処理を共通化しない。共通化のために依存境界を崩さない。
- 現在の要件と決定済みの境界に不要な汎用基盤・抽象層・設定項目を、将来の用途だけを理由に先行追加しない。
- 挙動を変えるコミットには、期待する振る舞い・境界条件・重要な失敗を検証するテストを同じコミットへ含める。

## 作業の進め方

- sub-issueの実装・コミット・完了判定は[ima-issue-delivery](.agents/skills/ima-issue-delivery/SKILL.md)、検証結果の判定と証跡は[ima-verification-evidence](.agents/skills/ima-verification-evidence/SKILL.md)、外部Providerの追加・差し替え・撤去は[ima-provider-swap](.agents/skills/ima-provider-swap/SKILL.md)に従う。設計相談やIssueレビューだけの依頼を実装へ広げない。
- sub agentは担当ファイルを分離し、共有契約やlockfileを同時編集しない。主担当だけがstage・commit・pushを直列で行い、sub agentの完了報告だけで合格にしない。
- コミット前は`bun run check`で変更パスに対応するゲートを実行する。選ばれなかったゲートを合格として報告しない。コマンドの使い分けは[開発の品質方針](docs/devlop/development.md#品質検査)に従い、行数制限などの数値はスクリプトが正とする。

## 応答と文書

- 日本語で簡潔に答え、事実・提案・未確認事項を区別する。確認質問は必要最小限にし、進められる部分は仮定を明示して進める。
- 仕様変更は該当する現行文書へ直接反映し、同じルールの正を複数箇所に作らない。
- 未決案・作業計画・進捗・完了状態は[GitHub Issue](https://github.com/takapom/ima-app/issues)で管理する。連番の決定記録、ローカルのIssue一覧、進捗報告書、履歴用archiveをリポジトリへ追加しない。
