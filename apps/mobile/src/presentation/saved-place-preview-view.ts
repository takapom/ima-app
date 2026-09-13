import type { SavedPlaceListResult } from '../services/saved-place-list';
import type { SavedPlaceItem } from '../state/journey-shell';
import { collectAttributions, type AttributionPresentation } from './attribution';
import type {
  SavedPlacePreviewFailure,
  SavedPlacePreviewState,
} from '../state/saved-place-preview';

export type SavedPlacePreviewDisplay = {
  readonly name: string;
  readonly area: string | null;
  readonly attributions: readonly AttributionPresentation[];
};

const savedAtLabelFor = (savedAt: string): string => {
  const milliseconds = Date.parse(savedAt);
  if (!Number.isFinite(milliseconds)) return '保存日時を確認';
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
    if (values.month === undefined || values.day === undefined || values.hour === undefined) {
      return '保存日時を確認';
    }
    return `保存: ${values.month}/${values.day} ${values.hour}:${values.minute ?? '00'}`;
  } catch {
    return '保存日時を確認';
  }
};

export const savedPlaceItemsFor = (result: SavedPlaceListResult): readonly SavedPlaceItem[] => {
  if (result.status !== 'available') return [];
  return result.items.map((item) => ({
    id: item.serverSavedPlaceRef,
    name: item.name ?? '店の情報を確認',
    area: item.area ?? savedAtLabelFor(item.savedAt),
  }));
};

export const savedPlacePreviewDisplayFor = (
  state: SavedPlacePreviewState,
): SavedPlacePreviewDisplay | null => {
  if (state.status !== 'ready' || state.payload === null) return null;
  const item = state.payload.data.items.find(
    (candidate) => candidate.candidateId === state.payload?.candidateId,
  );
  const identity = item?.fields.identity;
  if (identity?.status !== 'known' || identity.value.name === null) return null;
  const attributions = collectAttributions([identity.evidence]);
  return { name: identity.value.name, area: identity.value.area, attributions };
};

export const savedPlaceConsultationRefFor = (
  state: SavedPlacePreviewState,
  requestedRef: string,
): string | null =>
  state.status === 'ready' &&
  state.payload?.savedPlaceRef === requestedRef &&
  state.selected?.serverSavedPlaceRef === requestedRef
    ? requestedRef
    : null;

export const savedPlacePreviewFailureTextFor = (
  failure: SavedPlacePreviewFailure | null,
): string => {
  switch (failure?.reason) {
    case 'aborted':
      return '詳細の取得を取り消しました。';
    case 'api':
      return '保存店の詳細を取得できませんでした。';
    case 'invalid_input':
      return '保存店の参照を確認できませんでした。';
    case 'retention_denied':
      return 'この保存店の詳細は現在表示できません。';
    case 'stale':
      return '保存店の参照が古くなっています。';
    case 'storage_unavailable':
      return '保存店を利用できません。';
    case 'clock_unavailable':
      return '時刻を確認できないため、詳細を表示できません。';
    case undefined:
      return '保存店の詳細を確認できませんでした。';
  }
};
