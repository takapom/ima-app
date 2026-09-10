import type { RetentionMetadata } from '@ima/contracts';

export type RetentionProjection = {
  readonly restoreMode: 'full' | 'reference_only' | 'unavailable';
  readonly canPersistPayload: boolean;
  readonly needsRefetch: boolean;
};

const JST_CUTOFF_HOUR = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const parseTimestamp = (value: string): number => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('SQLITE_INVALID_TIMESTAMP');
  return parsed;
};

const partsForTokyo = (value: number): Record<string, string> => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  return Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
};

const cutoffForTokyoDate = (parts: Record<string, string>): string => {
  const year = parts.year;
  const month = parts.month;
  const day = parts.day;
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error('SQLITE_INVALID_TIMESTAMP');
  }
  return `${year}-${month}-${day}T0${JST_CUTOFF_HOUR}:00:00+09:00`;
};

/** The session boundary is the first 05:00 JST at or after the created time. */
export const sessionExpiryAt = (timestamp: string): string => {
  const parsed = parseTimestamp(timestamp);
  const sameDay = cutoffForTokyoDate(partsForTokyo(parsed));
  const boundary = parseTimestamp(sameDay);
  if (parsed < boundary) return sameDay;
  return cutoffForTokyoDate(partsForTokyo(boundary + DAY_MS));
};

export const sessionWindowStartAt = (timestamp: string): string => {
  const expiry = parseTimestamp(sessionExpiryAt(timestamp));
  return cutoffForTokyoDate(partsForTokyo(expiry - DAY_MS));
};

const deadlineReached = (deadline: string | null, now: number): boolean =>
  deadline !== null && parseTimestamp(deadline) <= now;

export const retentionPayloadExpired = (retention: RetentionMetadata, now: string): boolean => {
  const parsedNow = parseTimestamp(now);
  return [retention.sessionExpiresAt, retention.retentionUntil, retention.deletionScheduledAt].some(
    (deadline) => deadlineReached(deadline, parsedNow),
  );
};

export const retentionDisplayExpired = (retention: RetentionMetadata, now: string): boolean => {
  const parsedNow = parseTimestamp(now);
  return [retention.sessionExpiresAt, retention.displayUntil, retention.deletionScheduledAt].some(
    (deadline) => deadlineReached(deadline, parsedNow),
  );
};

/** Applies the public retention metadata without reimplementing provider policy. */
export const projectRetention = (
  retention: RetentionMetadata,
  now: string,
): RetentionProjection => {
  if (retention.retentionDecision !== 'allow' || retention.policyStatus !== 'available') {
    return { restoreMode: 'unavailable', canPersistPayload: false, needsRefetch: true };
  }

  if (retention.retentionMode === 'identifier_indefinite_owner_scoped') {
    return { restoreMode: 'reference_only', canPersistPayload: false, needsRefetch: false };
  }

  if (
    retention.restoreMode === 'full' &&
    retention.displayPolicyStatus === 'available' &&
    retention.retentionUntil !== null &&
    !retentionPayloadExpired(retention, now) &&
    !retentionDisplayExpired(retention, now)
  ) {
    return { restoreMode: 'full', canPersistPayload: true, needsRefetch: false };
  }

  return { restoreMode: 'reference_only', canPersistPayload: false, needsRefetch: true };
};

/** A saved server reference is a separate policy decision from its display fields. */
export const canPersistOwnerScopedReference = (retention: RetentionMetadata): boolean =>
  retention.retentionDecision === 'allow' &&
  retention.policyStatus === 'available' &&
  retention.retentionMode === 'identifier_indefinite_owner_scoped' &&
  retention.restoreMode === 'reference_only';

export const minimumDeadline = (
  deadlines: readonly (string | null)[],
  now: string,
): string | null => {
  const parsedNow = parseTimestamp(now);
  let next: { readonly value: string; readonly parsed: number } | null = null;
  for (const deadline of deadlines) {
    if (deadline === null) continue;
    const parsed = parseTimestamp(deadline);
    if (parsed <= parsedNow || (next !== null && parsed >= next.parsed)) continue;
    next = { value: deadline, parsed };
  }
  return next?.value ?? null;
};
