/**
 * 設定画面に並べる項目。行は表示だけで、操作につながる設定はまだ1つも持たない。
 * 提供しないと決めた項目（アカウント連携・端末間同期・テーマ・言語）と、撤去した条件
 * （徒歩時間・終電）は行にしない。行へ振る舞いを付けたときに準備中の表示を外す。
 */

export type SettingsRow = {
  readonly id: string;
  readonly label: string;
};

export type SettingsSection = {
  readonly id: string;
  readonly title: string;
  readonly rows: readonly SettingsRow[];
};

/** 操作をつないでいない行に出す表示。実装済みの値・状態の代わりには使わない。 */
export const settingsPreparingLabel = '準備中';

export const settingsSections: readonly SettingsSection[] = [
  {
    id: 'location',
    title: '現在地',
    rows: [{ id: 'location-permission', label: '位置情報の利用' }],
  },
  {
    id: 'search',
    title: '探し方',
    rows: [{ id: 'decision-haptics', label: '決定時の触覚フィードバック' }],
  },
  {
    id: 'data',
    title: 'データ',
    rows: [
      { id: 'delete-conversations', label: '会話履歴を削除' },
      { id: 'delete-saved-places', label: '保存した店を削除' },
    ],
  },
  {
    id: 'about',
    title: 'このアプリについて',
    rows: [
      { id: 'version', label: 'バージョン' },
      { id: 'attribution', label: '情報の出典' },
      { id: 'terms', label: '利用規約' },
      { id: 'privacy', label: 'プライバシーポリシー' },
      { id: 'licenses', label: 'オープンソースライセンス' },
    ],
  },
];
