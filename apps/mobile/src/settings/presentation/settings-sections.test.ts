import { describe, expect, it } from 'vitest';
import { settingsSections } from '@mobile/settings/presentation/settings-sections';

describe('settings sections', () => {
  it('lists the approved sections in order', () => {
    expect(settingsSections.map((section) => section.id)).toEqual([
      'location',
      'search',
      'data',
      'about',
    ]);
  });

  it('keeps every section titled and non-empty', () => {
    for (const section of settingsSections) {
      expect(section.title.length).toBeGreaterThan(0);
      expect(section.rows.length).toBeGreaterThan(0);
      for (const row of section.rows) {
        expect(row.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('keeps row ids unique so a later implementation targets one row', () => {
    const ids = settingsSections.flatMap((section) => section.rows.map((row) => row.id));

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('omits the settings this product does not provide', () => {
    const labels = settingsSections.flatMap((section) => [
      section.title,
      ...section.rows.map((row) => row.label),
    ]);
    // 撤去した条件（#55）と、提供しないと決めた連携・表示切替を設定から復活させない。
    const removed = ['徒歩', '終電', '最低滞在', '帰宅駅'];
    const unsupported = [
      'アカウント',
      'ログイン',
      '同期',
      'テーマ',
      'ダークモード',
      '言語',
      '通知',
    ];

    for (const word of [...removed, ...unsupported]) {
      expect(labels.some((label) => label.includes(word))).toBe(false);
    }
  });
});
