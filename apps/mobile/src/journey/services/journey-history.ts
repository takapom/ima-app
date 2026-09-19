import type { SqliteStore, ThreadRecord } from '@mobile/platform/sqlite/types';
import { opaqueId } from '@mobile/platform/sqlite/rows';

/** A history row carries only an opaque thread reference and its observed time. */
export type JourneyHistoryItem = {
  readonly id: string;
  readonly label: '検索履歴';
  /** Deliberately empty: the original search text is not persisted or replayed. */
  readonly query: '';
  readonly time: string;
};

export type JourneyHistoryResult =
  | {
      readonly status: 'available';
      readonly items: readonly JourneyHistoryItem[];
      /** Earliest valid row expiry; null when the available list is empty. */
      readonly nextExpiryAt: string | null;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'storage_unavailable';
    };

export type JourneyHistoryService = {
  readonly list: () => JourneyHistoryResult;
};

export type JourneyHistoryServiceOptions = {
  readonly sqlite?: Pick<SqliteStore, 'listThreads'>;
};

const historyTimeFor = (createdAt: string): string | null => {
  const milliseconds = Date.parse(createdAt);
  if (!Number.isFinite(milliseconds)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      day: 'numeric',
      hour: '2-digit',
      hourCycle: 'h23',
      minute: '2-digit',
      month: 'numeric',
      timeZone: 'Asia/Tokyo',
    }).formatToParts(new Date(milliseconds));
    const values = Object.fromEntries(
      parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
    );
    if (
      values.month === undefined ||
      values.day === undefined ||
      values.hour === undefined ||
      values.minute === undefined
    ) {
      return null;
    }
    return `${values.month}/${values.day} ${values.hour}:${values.minute}`;
  } catch {
    return null;
  }
};

const itemFor = (thread: ThreadRecord): JourneyHistoryItem | null => {
  const id = opaqueId(thread.id);
  const createdMilliseconds = Date.parse(thread.createdAt);
  const expiresMilliseconds = Date.parse(thread.expiresAt);
  if (
    id === null ||
    !Number.isFinite(createdMilliseconds) ||
    !Number.isFinite(expiresMilliseconds) ||
    createdMilliseconds >= expiresMilliseconds
  ) {
    return null;
  }
  const time = historyTimeFor(thread.createdAt);
  return time === null ? null : { id, label: '検索履歴', query: '', time };
};

const nextExpiryAtFor = (threads: readonly ThreadRecord[]): string | null => {
  let next: { readonly value: string; readonly milliseconds: number } | null = null;
  for (const thread of threads) {
    if (itemFor(thread) === null) continue;
    const milliseconds = Date.parse(thread.expiresAt);
    if (!Number.isFinite(milliseconds)) continue;
    if (next === null || milliseconds < next.milliseconds) {
      next = { value: thread.expiresAt, milliseconds };
    }
  }
  return next?.value ?? null;
};

/**
 * Read-only projection for the drawer. Expiry and ordering are owned by the
 * SQLite store; this service never reconstructs query, place, or response data.
 */
export const createJourneyHistoryService = (
  options: JourneyHistoryServiceOptions = {},
): JourneyHistoryService => {
  const list = (): JourneyHistoryResult => {
    if (options.sqlite === undefined)
      return { status: 'unavailable', reason: 'storage_unavailable' };
    try {
      const threads = options.sqlite.listThreads();
      const items = threads.flatMap((thread) => {
        const item = itemFor(thread);
        return item === null ? [] : [item];
      });
      return { status: 'available', items, nextExpiryAt: nextExpiryAtFor(threads) };
    } catch {
      return { status: 'unavailable', reason: 'storage_unavailable' };
    }
  };

  return { list };
};
