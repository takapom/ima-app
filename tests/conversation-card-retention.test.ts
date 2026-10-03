import { describe, expect, it } from 'vitest';
import type { AssistantCardsResponse } from '@contracts/index';
import { parseConversationMessage } from '@contracts/index';
import { messageFromConversationResponse } from '@worker/runtime/conversations/conversation-delivery';
import {
  publicConversationMessage,
  conversationPhotoSources,
  withConversationPhotoSources,
} from '@worker/runtime/conversations/conversation-photo-sources';
import { retainConversationMessage as serverRetain } from '@worker/domain/conversations/conversation-message';
import {
  retainConversationMessage as clientRetain,
  conversationMessageDeadline,
} from '@mobile/journey/services/conversations/conversation-retention';

const now = '2026-09-22T10:00:00Z';
const expiry = '2026-09-22T11:00:00Z';
const retention = {
  retentionDecision: 'allow' as const,
  retentionMode: 'session_only' as const,
  sessionExpiresAt: expiry,
  freshUntil: now,
  displayUntil: expiry,
  retentionUntil: expiry,
  deletionScheduledAt: expiry,
  attribution: null,
  restoreMode: 'full' as const,
  policyStatus: 'available' as const,
  displayPolicyStatus: 'available' as const,
};
const response = (): AssistantCardsResponse => ({
  schemaVersion: 'v1',
  threadId: 'thread',
  turnId: 'turn',
  responseId: 'response',
  revision: 2,
  kind: 'cards',
  presentation: 'replace',
  cardSetId: 'cards',
  message: [{ text: '回答', retention }],
  cards: {
    hero: {
      candidateId: 'shop',
      facts: {
        identity: {
          status: 'known',
          value: {
            name: '店舗の名前',
            area: '恵比寿',
            address: null,
            category: null,
            stationName: null,
            accessText: null,
            businessStatus: 'unknown',
            sourceUrl: null,
          },
          evidence: [{ evidenceId: 'id', attribution: null, retention }],
        },
        photos: {
          status: 'known',
          value: {
            photos: [
              {
                photoToken: `p1.${btoa(JSON.stringify({ e: Date.parse('2026-09-22T10:30:00Z') / 1000 }))}.mac`,
                attributions: [],
                sourceUrl: null,
              },
            ],
          },
          evidence: [{ evidenceId: 'photo', attribution: null, retention }],
        },
      },
      why: { text: '残す理由', retention },
    },
    alts: [],
  },
});
const message = (value = response()) => ({
  conversationId: 'conversation',
  sequence: 2,
  createdAt: now,
  message: messageFromConversationResponse(value, 'answer', now),
});

describe('historical card retention across server and client', () => {
  it('retains stable shop references after content expiry while exposing only candidate IDs', () => {
    const value = response();
    if (value.cards.hero.facts.identity.status !== 'known') throw new Error('FIXTURE');
    value.cards.hero.facts.identity.value.sourceUrl =
      'https://www.hotpepper.jp/strJ000123456/?vos=example';
    const record = message(value);
    const expired = serverRetain(record, expiry);
    expect(JSON.stringify(expired)).toContain('J000123456');
    expect(JSON.stringify(expired)).not.toContain('店舗の名前');
    const visible = publicConversationMessage(expired);
    expect(parseConversationMessage(visible).success).toBe(true);
    expect(JSON.stringify(visible)).not.toContain('recordRef');
    expect(JSON.stringify(visible)).not.toContain('J000123456');
    expect(visible.message.parts).toContainEqual(
      expect.objectContaining({ photoCandidateIds: ['shop'] }),
    );
    expect(clientRetain(visible, expiry).message.parts).toContainEqual(
      expect.objectContaining({ photoCandidateIds: ['shop'] }),
    );
  });
  it('migrates legacy links only before their retention deadline', () => {
    const value = response();
    if (value.cards.hero.facts.identity.status !== 'known') throw new Error('FIXTURE');
    value.cards.hero.facts.identity.value.sourceUrl = 'https://www.hotpepper.jp/strJ000123456/';
    const legacy = message(value);
    for (const part of legacy.message.parts) if (part.kind === 'card_set') delete part.photoSources;

    expect(conversationPhotoSources({ cards: value.cards })).toEqual([]);
    const migrated = withConversationPhotoSources(legacy, now);
    expect(JSON.stringify(migrated)).toContain('J000123456');
    expect(JSON.stringify(serverRetain(migrated, expiry))).toContain('J000123456');

    const tooLate = serverRetain(withConversationPhotoSources(legacy, expiry), expiry);
    expect(JSON.stringify(tooLate)).not.toContain('J000123456');
    expect(publicConversationMessage(tooLate).message.parts).not.toContainEqual(
      expect.objectContaining({ photoCandidateIds: ['shop'] }),
    );
    expect(JSON.stringify(messageFromConversationResponse(value, 'answer', expiry))).not.toContain(
      'J000123456',
    );
  });
  it.each([
    'https://evil.test/strJ123/',
    'https://www.hotpepper.jp.evil.test/strJ123/',
    'https://user@www.hotpepper.jp/strJ123/',
    'https://www.hotpepper.jp/str../../',
    'https://www.hotpepper.jp/strJ123/menu/',
    'https://www.hotpepper.jp:444/strJ123/',
  ])('does not infer shop references from %s', (url) => {
    const value = response();
    if (value.cards.hero.facts.identity.status !== 'known') throw new Error('FIXTURE');
    value.cards.hero.facts.identity.value.sourceUrl = url;
    expect(conversationPhotoSources({ cards: value.cards }, now)).toEqual([]);
  });
  it('round trips display facts and reasons without treating freshness expiry as display expiry', () => {
    const record = message();
    expect(parseConversationMessage(record).success).toBe(true);
    expect(serverRetain(record, now)).toEqual(clientRetain(record, now));
    expect(record.message.parts).toContainEqual(
      expect.objectContaining({ kind: 'card_set', cards: response().cards }),
    );
    expect(conversationMessageDeadline(record)).toBe(Date.parse('2026-09-22T10:30:00Z'));
  });
  it('expires photos separately and physically removes facts and reasons at their deadlines', () => {
    const record = message();
    const withoutPhotos = clientRetain(record, '2026-09-22T10:30:00Z');
    expect(withoutPhotos).toEqual(serverRetain(record, '2026-09-22T10:30:00Z'));
    expect(JSON.stringify(withoutPhotos)).not.toContain('p1.');
    expect(JSON.stringify(withoutPhotos)).toContain('店舗の名前');
    const expired = clientRetain(record, expiry);
    expect(expired).toEqual(serverRetain(record, expiry));
    expect(parseConversationMessage(expired).success).toBe(true);
    expect(JSON.stringify(expired)).not.toContain('店舗の名前');
    expect(JSON.stringify(expired)).not.toContain('残す理由');
    expect(conversationMessageDeadline(expired)).toBeNull();
  });
  it.each([
    { status: 'unknown', reason: '写真を取得していません' },
    { status: 'unsupported', reason: '写真は未対応です' },
    { status: 'not_applicable', reason: '写真の対象外です' },
    { status: 'error', code: 'PROVIDER_UNAVAILABLE', reason: '写真の取得に失敗しました' },
    {
      status: 'known',
      value: { photos: [] },
      evidence: [{ evidenceId: 'photo', attribution: null, retention }],
    },
  ] satisfies NonNullable<AssistantCardsResponse['cards']['hero']['facts']['photos']>[])(
    'preserves a photo field without tokens: $status',
    (photos) => {
      const value = response();
      value.cards.hero.facts.photos = photos;
      const record = message(value);
      const part = record.message.parts.find((part) => part.kind === 'card_set');
      if (part?.kind !== 'card_set') throw new Error('CARD_SNAPSHOT_MISSING');
      expect(part.photosExpireAt).toBeNull();
      expect(part.cards.hero.facts.photos).toEqual(photos);
      expect(clientRetain(record, now)).toEqual(serverRetain(record, now));
      expect(clientRetain(record, now)).toEqual(record);
    },
  );
  it('distinguishes an unverifiable token expiry from elapsed expiry and storage denial', () => {
    const value = response();
    const photos = value.cards.hero.facts.photos;
    if (photos?.status !== 'known' || photos.value.photos[0] === undefined)
      throw new Error('FIXTURE_MISSING');
    photos.value.photos[0].photoToken = 'invalid-token';
    expect(JSON.stringify(message(value))).toContain('写真の表示期限を確認できません');
    expect(JSON.stringify(message(value))).not.toContain('invalid-token');
    const evidence = photos.evidence[0];
    if (evidence === undefined) throw new Error('FIXTURE_MISSING');
    evidence.retention = {
      ...retention,
      retentionDecision: 'deny',
      retentionUntil: null,
      deletionScheduledAt: null,
      restoreMode: 'unavailable',
      policyStatus: 'policy_withheld',
    };
    const denied = message(value);
    expect(JSON.stringify(denied)).toContain('保存が許可されていません');
    expect(clientRetain(denied, now)).toEqual(serverRetain(denied, now));
    expect(clientRetain(denied, now)).toEqual(denied);
  });
  it('withholds disallowed values before storage and rejects a foreign thread snapshot', () => {
    const value = response();
    value.cards.hero.why.retention = {
      ...retention,
      retentionDecision: 'deny',
      retentionMode: 'none',
      retentionUntil: null,
      deletionScheduledAt: null,
      restoreMode: 'unavailable',
      policyStatus: 'policy_withheld',
    };
    expect(JSON.stringify(message(value))).not.toContain('残す理由');
    const record = message();
    for (const part of record.message.parts)
      if (part.kind === 'card_set') part.threadId = 'foreign';
    expect(parseConversationMessage(record).success).toBe(false);
  });
});
