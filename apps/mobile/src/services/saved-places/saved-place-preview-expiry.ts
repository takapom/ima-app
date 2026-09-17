import type { SavedPlacePreviewPayload } from '@mobile/state/saved-place-preview';
import type { SavedPlaceListItem } from '@mobile/services/saved-places/saved-place-list';
import { retentionDisplayExpired } from '@mobile/services/sqlite/retention';

export type SavedPlacePreviewExpiry =
  | {
      readonly status: 'valid';
      readonly nowValue: string;
      readonly nowMilliseconds: number;
      readonly nextExpiryMs: number | null;
      readonly expired: boolean;
    }
  | { readonly status: 'invalid' };

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export const savedPlacePreviewExpiryFor = (
  item: SavedPlaceListItem | null,
  now: () => string,
  extraDeadlines: readonly (string | null)[] = [],
): SavedPlacePreviewExpiry => {
  if (item === null) return { status: 'invalid' };
  let nowValue: string;
  let nowMilliseconds: number;
  try {
    nowValue = now();
    nowMilliseconds = Date.parse(nowValue);
  } catch {
    return { status: 'invalid' };
  }
  if (!Number.isFinite(nowMilliseconds)) return { status: 'invalid' };
  const deadlines =
    item.restoreMode === 'full'
      ? [item.sessionExpiresAt, item.displayUntil, item.retentionUntil, item.deletionScheduledAt]
      : [item.displayUntil, item.retentionUntil, item.deletionScheduledAt];
  const parsed = [...deadlines, ...extraDeadlines].map((deadline) =>
    deadline === null ? null : Date.parse(deadline),
  );
  if (parsed.some((deadline) => deadline !== null && !Number.isFinite(deadline))) {
    return { status: 'invalid' };
  }
  return {
    status: 'valid',
    nowValue,
    nowMilliseconds,
    expired: parsed.some((deadline) => deadline !== null && deadline <= nowMilliseconds),
    nextExpiryMs: parsed.reduce<number | null>(
      (next, deadline) =>
        deadline !== null && deadline > nowMilliseconds && (next === null || deadline < next)
          ? deadline
          : next,
      null,
    ),
  };
};

export const savedPlacePreviewTimerDelay = (
  expiry: Extract<SavedPlacePreviewExpiry, { readonly status: 'valid' }>,
): number | null =>
  expiry.nextExpiryMs === null
    ? null
    : Math.min(MAX_TIMER_DELAY_MS, Math.max(0, expiry.nextExpiryMs - expiry.nowMilliseconds));

export const savedPlacePayloadDeadlinesFor = (
  payload: SavedPlacePreviewPayload,
): readonly (string | null)[] => {
  const deadlines: Array<string | null> = [];
  for (const item of payload.data.items) {
    for (const field of Object.values(item.fields)) {
      if (field?.status !== 'known') continue;
      for (const evidence of field.evidence) {
        deadlines.push(
          evidence.retention.sessionExpiresAt,
          evidence.retention.displayUntil,
          evidence.retention.retentionUntil,
          evidence.retention.deletionScheduledAt,
        );
      }
    }
  }
  return deadlines;
};

export const savedPlacePayloadDisplayPolicyBlocked = (
  payload: SavedPlacePreviewPayload,
  now: string,
): boolean => {
  for (const item of payload.data.items) {
    for (const field of Object.values(item.fields)) {
      if (field?.status !== 'known') continue;
      for (const evidence of field.evidence) {
        if (evidence.retention.displayPolicyStatus !== 'available') return true;
        try {
          if (retentionDisplayExpired(evidence.retention, now)) return true;
        } catch {
          return true;
        }
      }
    }
  }
  return false;
};
