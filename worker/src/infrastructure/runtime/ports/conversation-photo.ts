import type { ProviderRecordIdentity } from '@worker/core/domain/candidates/registry';
import type { PhotoMedia } from '@worker/infrastructure/runtime/ports/photo-media';

/** 履歴の現在写真。提案やThreadの保持期限とは別に取り直す。 */
export interface ConversationPhotoReader {
  read(source: ProviderRecordIdentity, signal?: AbortSignal): Promise<PhotoMedia | null>;
}
