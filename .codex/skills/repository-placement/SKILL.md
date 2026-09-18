---
name: repository-placement
description: >-
  ima-app の永続化Port・Adapterの配置と依存方向をレビューする。
  RepositoryやStoreの契約をどこへ置くか、DomainへのI/O混入を判断する場合に使用する。
---

# 永続化Portの配置

配置の正は[アーキテクチャ](../../../docs/architecture.md)。
「Repositoryはユースケース層に置く」という一般論だけで、既存Portを移動しない。

- 業務側の永続化契約は [CoreのPorts](../../../worker/core/src/ports) が所有する。
  [OwnerStore](../../../worker/core/src/ports/owner-store.ts) を具体例として読む。
- ApplicationはPortを呼ぶ手順と業務判断を持ち、Domainは保存方式・SDK・HTTPへ依存しない。
- 具象の保存実装は [outbound/persistence](../../../worker/adapters/outbound/persistence)、
  生成・注入は [composition](../../../worker/composition) が担当する。
- Runtime固有の契約と公開HTTP DTOをCoreの永続化Portへ混ぜない。

## レビュー

1. 保存するデータの正と、契約を使う責務を確認する。
2. import元・公開exports・依存方向を確認する。配置名だけで適合と判断しない。
3. 集約内部からI/Oを呼んでいる場合は、既存ApplicationとPortへ責務を分ける。
4. `Store` を一律に `Repository` へ改名したり、汎用Repository基盤を追加したりしない。
5. 指摘には実在するコードのパスと違反する依存関係を示す。修正依頼の場合だけ変更する。

集約の入出力設計が論点なら [repository-design](../repository-design/SKILL.md) を参照する。
