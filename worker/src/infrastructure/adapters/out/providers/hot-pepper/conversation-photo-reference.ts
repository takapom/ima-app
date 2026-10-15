import type { ProviderRecordIdentity } from '@worker/core/domain/candidates/registry';

/**
 * グルメサーチの店舗IDそのものより狭い。
 * 履歴写真の再取得だけをこの形に限り、受信契約をこのIssueの都合で締めない。
 */
const HOT_PEPPER_PHOTO_RECORD_REF = /^J[0-9]{1,127}$/;
const CANONICAL_SHOP_PATH = /^\/str(J[0-9]{1,127})\/$/;

export const isHotPepperPhotoRecordRef = (recordRef: string): boolean =>
  HOT_PEPPER_PHOTO_RECORD_REF.test(recordRef);

export const isHotPepperPhotoIdentity = (identity: ProviderRecordIdentity): boolean =>
  identity.provider === 'hotpepper' && isHotPepperPhotoRecordRef(identity.recordRef);

/**
 * 正規の店舗ページ以外からIDを拾うと、別ホストのパスをホットペッパーの店として扱う。
 */
export const parseHotPepperPhotoIdentity = (
  sourceUrl: string,
): ProviderRecordIdentity | undefined => {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return undefined;
  }
  const recordRef = CANONICAL_SHOP_PATH.exec(url.pathname)?.[1];
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'www.hotpepper.jp' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    recordRef === undefined
  )
    return undefined;
  return { provider: 'hotpepper', recordRef };
};
