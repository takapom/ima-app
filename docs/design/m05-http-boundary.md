# M05 HTTP・所有権境界

2026-09-10。対象はsub-issue #6。Applicationの店舗取得・モデル実行は後続実装を注入する。

- Workerの明示14経路で入力・出力とowner scopeを検証し、未知のSDK管理経路を公開しない。
- `THREADS`はThinkを継承した同一ThreadDOを使用する。M10のnative loopもこのDOへ接続する。
- ownerの初回登録とlifecycle更新はSQLの同期transactionで行う。
- lifecycleは期待revisionを照合し、同じ冪等キーのaction・turnId・revision不一致を拒否する。
- 削除はtombstoneで再bindを防ぐ。同ownerの削除再送は記録済み結果を返す。
- `RATE_LIMITS`はdevice単位30回/時、owner単位100回/時を初期設定とする。
  全ownerを同じDOで数え、device上限をowner切替で回避できないようにする。
- 未接続Providerの経路は明示的なエラーを返す。Fixtureの成功応答へ置き換えない。

## 検証と引継ぎ

親レビューで実Workerの9テスト、Worker型検査、対象lint/formatを確認。
HTTP認可、再送、revision競合、同時owner登録、同時lifecycle、削除後のevictionと
再bind拒否、rate limitのeviction後継続を含む。

更新後のWorker dry-runは自動承認レビューに拒否され、未検証。
依存のruntime区分への移動はlockfile同期待ちであり、完了検査は同期後に行う。

M05はモデル本文を保存しない。M10でThinkのsession保存を導入する際には、
tombstoneだけで完了とせず、許可された保存内容の削除と期限管理を接続する。
Applicationの本番DO永続化はM16、完成した本番compositionの検収はM23で扱う。
