---
name: create-github-issue
description: >-
  takapom/ima-app の現行仕様・コード・テスト・既存Issueを調査し、
  What・Why・How・完了条件でIssueの下書きまたは起票を行う。
  タスク化・Issue作成の依頼に使用する。設計相談だけを起票や実装へ広げない。
---

# ima-app のGitHub Issue作成

対象は `takapom/ima-app`。[作業規則](../../../AGENTS.md)と
[README](../../../README.md)から辿る現行仕様を根拠にする。
実装の分割・依存関係は[ima-issue-delivery](../../../.agents/skills/ima-issue-delivery/SKILL.md)、
完了条件の検証範囲は[ima-verification-evidence](../../../.agents/skills/ima-verification-evidence/SKILL.md)に従う。

## 対象と調査

1. `git remote get-url origin` で対象を確認する。HTTPS・SSHいずれでも
   `takapom/ima-app` を指すことを確認し、異なる場合は書き込まない。
2. 利用可能なGitHubコネクタまたは `gh` を使う。特定のMCPツール名や組織専用のIssue Typeを前提にしない。
3. 関連コード・テスト・設定を `rg` で探し、現状の振る舞いと変更対象を整理する。
   調査していないパス・型・APIや、過去のIssueにしかない仕様を確定事項として書かない。
4. 同じ目的のIssueを検索し、候補の本文・状態を読む。重複なら既存Issueを提示し、
   追加作成が必要な場合は差分を明確にする。親・依存Issueは実在と関係を確認する。

CLIの読み取り例（キーワードと番号は調査対象に置き換える）:

```sh
gh issue list --repo takapom/ima-app --state all --search '<キーワード>'
gh issue view <番号> --repo takapom/ima-app
```

## 下書き

タイトルは解消する問題または実現する成果を表す1行にする。
本文は次の形式にし、事実・提案・未確認事項を区別する。

```md
## What（このタスクで実現すること）

成果と対象範囲。

## Why（このタスクを行う理由や経緯）

現状の問題と、コード・現行文書・関連Issueの根拠。

## How（どのように実装するのか）

責務・依存方向・実施順・検証方針。未決の設計は提案と明示する。

## 完了条件

- [ ] 期待する振る舞い・境界条件・失敗を観測できる条件
```

- 対象リポジトリ、タイトル、親・依存Issue（なければ「なし」）、本文を示す。
- Fixture、実SDK/DO、実API、実モデル、実機を分け、必要な検証を完了条件へ書く。
- Issue Typeは利用可能な場合だけ実在する値を使う。取得不能と未設定を区別し、
  Typeがないことだけで通常のIssue作成を止めない。
- ラベル・担当者・マイルストーンはユーザーが指定した場合だけ設定する。
- 下書き・作業計画・進捗をリポジトリへ保存しない。

## 起票と確認

「下書き」の依頼なら提示で終える。「起票して」「Issueを作成して」は作成の許可として扱い、
調査して本文を整えた後に作成する。ユーザーが承認待ちを指定した場合や、
目的・範囲を変える未決事項がある場合だけ、その内容を示して確認する。

CLIでは本文を一時ファイルへ保存し、次の形式で作成する。

```sh
gh issue create --repo takapom/ima-app --title '<タイトル>' --body-file <一時ファイル>
```

作成後はURL・本文・親子関係を読み返す。親子関係の設定だけ失敗した場合は、
作成済みURLと未完了操作を報告し、再度Issueを作らない。
完了報告には作成したIssueのURLを示す。起票だけの依頼では実装やコミットへ進まない。
