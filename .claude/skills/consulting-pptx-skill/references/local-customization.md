# 組織固有の設定

組織固有の規約、禁止語、テンプレート、参考資料は `local/` に置く。`local/` の内容は `.gitignore` の対象であり、スキル本体には含めない。

| パス | 役割 | 読み方・使い方 |
| --- | --- | --- |
| `local/slide-rules.local.md` | 組織固有の規約 | `references/slide-rules.md` の後に読む。規則が重なる場合はこちらを優先する |
| `local/forbid.txt` | 顧客名・案件コードなど、外部へ出してはいけない語 | 1行1語で記載し、`python3 scripts/check_deck.py deck.html --forbid local/forbid.txt` で検査する |
| `local/templates/` | 組織固有のパーツ集、差し込み先の資料、`skin.json` | 本体のテンプレートに加えて使用する |
| `local/examples/` | 組織内の参考デッキ | 類似資料を作るときだけ参照する |

顧客名、案件コード、金額、担当者名、実案件のファイル、`skin.json` は、スキル本体、Git差分、コミットメッセージへ入れない。
