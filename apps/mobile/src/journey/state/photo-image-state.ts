import type { PhotoApiError, PhotoAsset } from '@mobile/platform/http/photo-client';
import type { EvidenceRef } from '@ima/contracts';

export type PhotoImageIdentity = {
  readonly client: object;
  readonly token: string;
  readonly displayUntil: string | null;
};

export type PhotoImageState =
  | { readonly status: 'idle' }
  | {
      readonly status: 'loading';
      readonly token: string;
      readonly client: object;
      readonly displayUntil: string | null;
    }
  | {
      readonly status: 'ready';
      readonly token: string;
      readonly client: object;
      readonly displayUntil: string | null;
      readonly asset: PhotoAsset;
    }
  | { readonly status: 'expired' }
  | { readonly status: 'unavailable'; readonly error: PhotoApiError | null };

export type ReadyPhotoImage = Extract<PhotoImageState, { readonly status: 'ready' }>;
export type RememberPhoto = (image: ReadyPhotoImage) => () => void;

export const photoDeadline = (evidence: readonly EvidenceRef[]): string | null => {
  const deadlines = evidence.flatMap((item) =>
    [
      item.retention.displayUntil,
      item.retention.sessionExpiresAt,
      item.retention.retentionUntil,
      item.retention.deletionScheduledAt,
    ].flatMap((value) => {
      if (value === null) return [];
      const milliseconds = Date.parse(value);
      return Number.isFinite(milliseconds) ? [milliseconds] : [];
    }),
  );
  return deadlines.length === 0 ? null : new Date(Math.min(...deadlines)).toISOString();
};

export const initialPhotoImageState = (
  client: object | undefined,
  token: string | null,
): PhotoImageState =>
  client !== undefined && token !== null
    ? { status: 'idle' }
    : { status: 'unavailable', error: null };

export const photoExpiryDeadline = (
  asset: PhotoAsset,
  displayUntil: string | null | undefined,
): number | null => {
  const deadlines = [asset.expiresAt, displayUntil].flatMap((value) => {
    if (value === null || value === undefined) return [];
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) ? [milliseconds] : [];
  });
  return deadlines.length === 0 ? null : Math.min(...deadlines);
};

export const isPhotoImageReadyFor = (
  state: PhotoImageState,
  identity: PhotoImageIdentity,
): state is Extract<PhotoImageState, { readonly status: 'ready' }> =>
  state.status === 'ready' &&
  state.token === identity.token &&
  state.client === identity.client &&
  state.displayUntil === identity.displayUntil;

export const canCommitPhotoResult = (
  identity: PhotoImageIdentity,
  activeIdentity: PhotoImageIdentity | null,
  active: boolean,
  aborted: boolean,
): boolean =>
  active &&
  !aborted &&
  activeIdentity !== null &&
  activeIdentity.client === identity.client &&
  activeIdentity.token === identity.token &&
  activeIdentity.displayUntil === identity.displayUntil;

export const shouldExpirePhoto = (
  token: string,
  expiryAt: number | null,
  nowMilliseconds: number,
  expiredTokens: ReadonlySet<string>,
): boolean => expiredTokens.has(token) || (expiryAt !== null && expiryAt <= nowMilliseconds);
