import { AppState } from 'react-native';
import { useEffect, useRef, useState } from 'react';
import type { JourneyPhotoClient } from '@mobile/services/api/photo-client';
import {
  canCommitPhotoResult,
  initialPhotoImageState,
  photoExpiryDeadline,
  shouldExpirePhoto,
  type PhotoImageIdentity,
  type PhotoImageState,
} from '@mobile/state/photo-image-state';

export type { PhotoImageState } from '@mobile/state/photo-image-state';

/** Loads a single server-issued photo handle and forgets it when the route deadline passes. */
export const usePhotoImage = (
  client: JourneyPhotoClient | undefined,
  token: string | null,
  displayUntil: string | null,
): PhotoImageState => {
  const [state, setState] = useState<PhotoImageState>(() => initialPhotoImageState(client, token));
  const expiredTokens = useRef<Set<string>>(new Set());
  const activeIdentity = useRef<PhotoImageIdentity | null>(null);

  useEffect(() => {
    if (client === undefined || token === null) {
      activeIdentity.current = null;
      setState(initialPhotoImageState(client, token));
      return undefined;
    }
    if (expiredTokens.current.has(token)) {
      setState({ status: 'expired' });
      return undefined;
    }
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expiryAt: number | null = null;
    const abort = new AbortController();
    const identity: PhotoImageIdentity = { client, token, displayUntil };
    activeIdentity.current = identity;
    const canCommit = (): boolean =>
      canCommitPhotoResult(identity, activeIdentity.current, current, abort.signal.aborted);
    const expire = (): void => {
      if (!canCommit()) return;
      expiredTokens.current.add(token);
      setState({ status: 'expired' });
    };
    setState({ status: 'loading', token, client, displayUntil });
    const onAppStateChange = (next: string): void => {
      if (next === 'active' && expiryAt !== null && expiryAt <= Date.now()) expire();
    };
    const appStateSubscription = AppState.addEventListener('change', onAppStateChange);
    void client
      .fetchPhoto(token, { signal: abort.signal, displayUntil })
      .then((result) => {
        if (!canCommit()) return;
        if (!result.ok) {
          if (
            result.error.kind === 'expired' ||
            (result.error.kind === 'http' && result.error.status === 410)
          ) {
            expiredTokens.current.add(token);
            setState({ status: 'expired' });
          } else {
            setState({ status: 'unavailable', error: result.error });
          }
          return;
        }
        const deadline = photoExpiryDeadline(result.data, displayUntil);
        expiryAt = deadline;
        if (
          deadline !== null &&
          shouldExpirePhoto(token, deadline, Date.now(), expiredTokens.current)
        ) {
          expire();
          return;
        }
        setState({ status: 'ready', token, client, displayUntil, asset: result.data });
        if (deadline !== null) timer = setTimeout(expire, Math.max(1, deadline - Date.now() + 1));
      })
      .catch(() => {
        if (!canCommit()) return;
        // The client normally returns a typed failure. An unexpected adapter
        // rejection still becomes a visible unavailable state without leaking it.
        setState({ status: 'unavailable', error: null });
      });
    return () => {
      current = false;
      abort.abort();
      if (activeIdentity.current === identity) activeIdentity.current = null;
      appStateSubscription.remove();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, displayUntil, token]);

  return state;
};
