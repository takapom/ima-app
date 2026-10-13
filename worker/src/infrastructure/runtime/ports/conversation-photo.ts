import type { PhotoMedia } from '@worker/infrastructure/runtime/ports/photo-media';

/** Refreshes current photos independently from historical proposal/Thread retention. */
export interface ConversationPhotoReader {
  read(recordRef: string, signal?: AbortSignal): Promise<PhotoMedia | null>;
}
