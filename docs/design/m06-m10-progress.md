# M06〜M10 実装チェックポイント

2026-09-10 03:11 JST。対象はM06〜M10（#7〜#11）。本書は完了報告ではない。

## 現在の状態

- ユーザーによるBun依存導入は完了。完全なlockfileをコミット済み。
- M03の公開契約・Core契約は実装・ローカル検証済み。#4はGitHub反映・完了処理が残る。
- M04の共通Think構成は24テストを通過し、[ADR0014](../adr/0014-think-runtime-adoption.md)で採用を決定した。
- 全162テスト、workspace型検査、lint、format、依存境界31ケース、Worker dry-run、Expo iOS exportが成功。
- M05とM06〜M10の本体は未実装。検証用Fixtureを本体実装と混同しない。
- 作業はmain上。各コミットは実在sub-issueに紐づけ、追加＋削除2,000行以内。
  実装はLuna/max、主担当が差分・契約・テストをレビューする。

## 依存順と責務

| 順序 | Issue     | 実装責務                                                    |
| ---- | --------- | ----------------------------------------------------------- |
| 並行 | M05 / #6  | Worker HTTP・認証・所有権・bootstrap。Applicationはstub注入 |
| 1    | M06 / #7  | Core候補・不変観測・所有者/thread・鮮度/context照合、eval   |
| 2    | M09 / #10 | 根拠検証・観測由来カード・CommitPort・in-memory CAS、eval   |
| 3    | M07 / #8  | Workerの3操作Binding、schema、能力・実行文脈注入            |
| 4    | M08 / #9  | 実モデルProvider、Coreの許可文脈と条件案、Worker encoding   |
| 5    | M10 / #11 | SDK実行予算・batch拒否・修正・取消・再送、M05 bootstrap接続 |

M06→M09→M07→M08→M10。M10はM05も必要。
実DOのApplication保存はM16、完成した本番構成の検収はM23が担当する。

## M04の証拠

- `6ede1bb`：Thinkの共通保存前制御・現turn原文投影・期限書換え・compaction・実DO/HTTP統合（1,844行）。
- `683b153`：本文digestと参照だけの再送記録・復元DTO（667行）。
- `cd5c5ed`：確定根拠から公開DTOへの変換と不整合拒否（464行）。
- `69ecb25`：共通保持契約・期限policy・保存前envelope検証（420行）。
- `555c243`、`71d90d5`：AIChat比較候補。contextなしnative入力の保存前制御は未達で未採用。

それ以前の比較・監査・Core接続は[適合性記録](runtime-compatibility.md)を参照。
一時環境の過去の成功を、正式構成の成功と読み替えない。

## 未実測と未反映

実モデル・有料店舗API・本番alarm遅延・実機描画は未実測。
GitHubへのpush、各Issueへの完了記録・Closeは、ローカルコミットとは区別する。
未pushをGitHub反映済みとは報告しない。
