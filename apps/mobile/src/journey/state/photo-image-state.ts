import type { PhotoApiError, PhotoAsset } from '@mobile/platform/http/photo-client';

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
