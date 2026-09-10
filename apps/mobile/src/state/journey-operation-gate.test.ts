import { describe, expect, it } from 'vitest';
import { canCommitJourneyNotice, canCommitJourneyOperation } from './journey-operation-gate';

describe('journey operation gate', () => {
  it('keeps state results for the same response context', () => {
    const started = { generation: 3, noticeToken: 8 };
    expect(canCommitJourneyOperation({ generation: 3, noticeToken: 9 }, started)).toBe(true);
  });

  it('rejects results after a response context or thread changes', () => {
    const started = { generation: 3, noticeToken: 8 };
    expect(canCommitJourneyOperation({ generation: 4, noticeToken: 8 }, started)).toBe(false);
    expect(canCommitJourneyNotice({ generation: 4, noticeToken: 8 }, started)).toBe(false);
  });

  it('suppresses an old notice after a newer action while retaining state eligibility', () => {
    const started = { generation: 3, noticeToken: 8 };
    const current = { generation: 3, noticeToken: 9 };
    expect(canCommitJourneyOperation(current, started)).toBe(true);
    expect(canCommitJourneyNotice(current, started)).toBe(false);
  });
});
