import { describe, expect, it, vi } from 'vitest';
import {
  createSourceLinkOperationGate,
  openJourneySourceLink,
  prepareSourceLink,
  selectJourneyNoticeText,
  type JourneySourceLinkService,
} from '@mobile/services/journey-source-link';

describe('journey source link boundary', () => {
  it('accepts http(s) links and gives the native service a normalized URL', async () => {
    const openSourceLink = vi.fn(() => Promise.resolve({ status: 'opened' as const }));
    const service: JourneySourceLinkService = { openSourceLink };

    expect(prepareSourceLink('https://example.com/source')).toEqual({
      status: 'ready',
      url: 'https://example.com/source',
    });
    await expect(openJourneySourceLink(service, 'http://example.com/source')).resolves.toEqual({
      status: 'opened',
    });
    expect(openSourceLink).toHaveBeenCalledWith('http://example.com/source');
  });

  it('rejects dangerous schemes and malformed URLs before native I/O', async () => {
    const openSourceLink = vi.fn(() => Promise.resolve({ status: 'opened' as const }));
    const service: JourneySourceLinkService = { openSourceLink };

    for (const sourceLink of ['javascript:alert(1)', 'data:text/plain,secret', 'file:///tmp/a']) {
      await expect(openJourneySourceLink(service, sourceLink)).resolves.toMatchObject({
        status: 'unavailable',
        reason: 'unsupported_scheme',
      });
    }
    await expect(openJourneySourceLink(service, 'not a URL')).resolves.toEqual({
      status: 'unavailable',
      reason: 'invalid_url',
    });
    expect(openSourceLink).not.toHaveBeenCalled();
  });

  it('rejects embedded URL credentials and empty hosts', async () => {
    const service: JourneySourceLinkService = {
      openSourceLink: () => Promise.resolve({ status: 'opened' }),
    };

    expect(prepareSourceLink('https://user:password@example.com/source')).toEqual({
      status: 'unavailable',
      reason: 'credentials_in_url',
    });
    expect(prepareSourceLink('https://')).toEqual({
      status: 'unavailable',
      reason: 'invalid_url',
    });
    await expect(openJourneySourceLink(service, ' https://example.com/source')).resolves.toEqual({
      status: 'unavailable',
      reason: 'invalid_url',
    });
  });

  it('keeps native unavailability and failure distinct', async () => {
    const unavailable: JourneySourceLinkService = {
      openSourceLink: () => Promise.resolve({ status: 'unavailable', reason: 'link_unavailable' }),
    };
    const failed: JourneySourceLinkService = {
      openSourceLink: () => Promise.reject(new Error('native unavailable')),
    };

    await expect(openJourneySourceLink(unavailable, 'https://example.com/source')).resolves.toEqual(
      { status: 'unavailable', reason: 'link_unavailable' },
    );
    await expect(openJourneySourceLink(failed, 'https://example.com/source')).resolves.toEqual({
      status: 'failed',
      reason: 'native_unavailable',
    });
  });

  it('accepts only the latest press within the same card-set context', () => {
    const gate = createSourceLinkOperationGate();
    gate.setContext('thread-1:cards-1');
    const first = gate.begin('thread-1:cards-1');
    const second = gate.begin('thread-1:cards-1');
    if (first === null || second === null) throw new Error('link operation should start');

    expect(gate.accepts(first)).toBe(false);
    expect(gate.accepts(second)).toBe(true);
    gate.setContext('thread-1:cards-2');
    expect(gate.accepts(second)).toBe(false);
  });

  it('shows the newer source failure after an older action success is cleared', () => {
    const actionSuccess = selectJourneyNoticeText('候補を保存しました。', null);
    expect(actionSuccess).toBe('候補を保存しました。');
    expect(selectJourneyNoticeText(null, '出典リンクを開けませんでした。')).toBe(
      '出典リンクを開けませんでした。',
    );
  });

  it('shows the newer action failure after an older source success is cleared', () => {
    const sourceSuccess = selectJourneyNoticeText(null, '出典を開きました。');
    expect(sourceSuccess).toBe('出典を開きました。');
    expect(selectJourneyNoticeText('保存できませんでした。', null)).toBe('保存できませんでした。');
    expect(selectJourneyNoticeText(null, null)).toBeNull();
  });
});
