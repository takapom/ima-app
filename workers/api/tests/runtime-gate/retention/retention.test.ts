import type { UIMessage } from 'ai';
import { expect, it } from 'vitest';
import type { RetentionMetadata } from '@ima/core';
import { auditRetentionSurface } from './retention-audit';
import { FixtureClock, makeRetentionMessage } from './retention-fixture';
import { sanitizeMessageForPersistence } from './retention-policy';

const MARKERS = ['M04_PROVIDER_CANARY', 'M04_GENERATED_CANARY'];

const ALLOWED_RETENTION = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-10T05:00:00+09:00',
  freshUntil: '2026-09-09T12:00:00Z',
  displayUntil: '2026-09-09T13:00:00Z',
  retentionUntil: '2026-09-10T05:00:00+09:00',
  deletionScheduledAt: '2026-09-10T05:00:00+09:00',
  attribution: null,
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
} satisfies RetentionMetadata;

const EXPIRED_RETENTION = {
  ...ALLOWED_RETENTION,
  sessionExpiresAt: '2026-09-08T01:00:00Z',
  freshUntil: '2026-09-08T00:30:00Z',
  displayUntil: '2026-09-08T00:45:00Z',
  retentionUntil: '2026-09-08T01:00:00Z',
  deletionScheduledAt: '2026-09-08T01:00:00Z',
} satisfies RetentionMetadata;

const REFERENCE_ONLY_RETENTION = {
  retentionDecision: 'deny',
  retentionMode: 'session_only',
  sessionExpiresAt: '2026-09-08T01:00:00Z',
  freshUntil: null,
  displayUntil: null,
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only',
  policyStatus: 'policy_withheld',
  displayPolicyStatus: 'policy_withheld',
} satisfies RetentionMetadata;

function message(
  id: string,
  text: string,
  retention: RetentionMetadata,
  ownerScopeRef = 'owner-1',
): ReturnType<typeof makeRetentionMessage> {
  return makeRetentionMessage({
    id,
    role: 'user',
    text,
    ownerScopeRef,
    threadId: 'thread-1',
    turnId: 'turn-1',
    retention,
  });
}

function textOf(messageValue: ReturnType<typeof makeRetentionMessage>): string {
  const firstPart = messageValue.parts[0];
  return firstPart?.type === 'text' ? firstPart.text : '';
}

it('scrubs denied content before public persistMessages is called', () => {
  const clock = new FixtureClock('2026-09-08T00:00:00Z');
  const denied = message('message-denied', `denied ${MARKERS[0]}`, REFERENCE_ONLY_RETENTION);
  const sanitized = sanitizeMessageForPersistence(denied, {
    clock,
    ownerScopeRef: 'owner-1',
    threadId: 'thread-1',
  });
  expect(sanitized.id).toBe(denied.id);
  expect(textOf(sanitized)).toBe('[withheld]');
  expect(sanitized.metadata.retention.restoreMode).toBe('reference_only');
  expect(textOf(denied)).toContain(MARKERS[0]);
});

it('rebuilds a withheld envelope without runtime canary fields', () => {
  const denied = message('message-poisoned', `denied ${MARKERS[0]}`, REFERENCE_ONLY_RETENTION);
  const poisoned: UIMessage = {
    id: denied.id,
    role: denied.role,
    parts: [
      { type: 'text', text: `denied ${MARKERS[0]}` },
      { type: 'data-runtime-canary', data: MARKERS[1] },
    ],
    metadata: {
      ...denied.metadata,
      runtimeCanary: MARKERS[1],
    },
  };
  const sanitized = sanitizeMessageForPersistence(poisoned, {
    clock: { now: () => '2026-09-08T00:00:00Z' },
    ownerScopeRef: 'owner-1',
    threadId: 'thread-1',
  });
  expect(JSON.stringify(sanitized)).not.toContain(MARKERS[0]);
  expect(JSON.stringify(sanitized)).not.toContain(MARKERS[1]);
  expect(sanitized.parts).toEqual([{ type: 'text', text: '[withheld]' }]);
});

it('rewrites an expired allowed message to a fixed same-ID reference', () => {
  const clock = new FixtureClock('2026-09-08T00:00:00Z');
  const old = message('message-old', `old ${MARKERS[0]}`, EXPIRED_RETENTION);
  const beforeText = textOf(old);
  const sanitized = sanitizeMessageForPersistence(old, {
    clock: { now: () => '2026-09-08T01:00:00Z' },
    ownerScopeRef: 'owner-1',
    threadId: 'thread-1',
  });
  expect(sanitized.id).toBe(old.id);
  expect(textOf(sanitized)).toBe('[withheld]');
  expect(sanitized.metadata.retention.restoreMode).toBe('reference_only');
  expect(textOf(old)).toBe(beforeText);
  expect(clock.now()).toBe('2026-09-08T00:00:00Z');
});

it('keeps an unexpired allowed message and its identity intact', () => {
  const messageValue = message('message-current', 'safe current content', ALLOWED_RETENTION);
  const sanitized = sanitizeMessageForPersistence(messageValue, {
    clock: { now: () => '2026-09-08T00:00:00Z' },
    ownerScopeRef: 'owner-1',
    threadId: 'thread-1',
  });
  expect(sanitized.id).toBe('message-current');
  expect(sanitized.metadata.ownerScopeRef).toBe('owner-1');
  expect(textOf(sanitized)).toBe('safe current content');
  expect(sanitized.metadata.retention.restoreMode).toBe('full');
});

it('keeps allowed text while dropping untrusted data parts and metadata fields', () => {
  const allowed = message('message-allowed-poisoned', `allowed ${MARKERS[0]}`, ALLOWED_RETENTION);
  const poisoned: UIMessage = {
    ...allowed,
    parts: [...allowed.parts, { type: 'data-runtime-canary', data: MARKERS[1] }],
    metadata: { ...allowed.metadata, runtimeCanary: MARKERS[1] },
  };
  const sanitized = sanitizeMessageForPersistence(poisoned, {
    clock: { now: () => '2026-09-08T00:00:00Z' },
    ownerScopeRef: 'owner-1',
    threadId: 'thread-1',
  });
  expect(textOf(sanitized)).toContain(MARKERS[0]);
  expect(JSON.stringify(sanitized)).not.toContain(MARKERS[1]);
  expect(sanitized.parts).toHaveLength(1);
  expect(sanitized.metadata).not.toHaveProperty('runtimeCanary');
});

it('rejects owner mismatch before persistence', () => {
  const foreign = message('message-foreign', 'foreign content', ALLOWED_RETENTION, 'owner-2');
  expect(() =>
    sanitizeMessageForPersistence(foreign, {
      clock: { now: () => '2026-09-08T00:00:00Z' },
      ownerScopeRef: 'owner-1',
      threadId: 'thread-1',
    }),
  ).toThrow('RETENTION_OWNER_MISMATCH');
});

it('fails closed when persistence metadata is absent', () => {
  const missingMetadata = {
    id: 'message-missing-metadata',
    role: 'user',
    parts: [{ type: 'text', text: `missing ${MARKERS[0]}` }],
  } satisfies UIMessage;
  expect(() =>
    sanitizeMessageForPersistence(missingMetadata, {
      clock: { now: () => '2026-09-08T00:00:00Z' },
      ownerScopeRef: 'owner-1',
      threadId: 'thread-1',
    }),
  ).toThrow('RETENTION_METADATA_REQUIRED');
});

it('reports an invalid injected clock through its validating port', () => {
  const clock = new FixtureClock('2026-09-08T00:00:00Z');
  expect(() => clock.set('invalid-clock')).toThrow();
});

it('audits only marker counts and reference state for persisted messages', async () => {
  const denied = message('message-audit', `audit ${MARKERS[0]}`, REFERENCE_ONLY_RETENTION);
  const sanitized = sanitizeMessageForPersistence(denied, {
    clock: { now: () => '2026-09-08T00:00:00Z' },
    ownerScopeRef: 'owner-1',
    threadId: 'thread-1',
  });
  const report = await auditRetentionSurface({ messages: [sanitized] }, MARKERS);
  expect(report.messages.entries).toBe(1);
  expect(report.messages.forbiddenEntries).toBe(0);
  expect(report.messages.referenceOnlyEntries).toBe(1);
  expect(JSON.stringify(report)).not.toContain(MARKERS[0]);
});
