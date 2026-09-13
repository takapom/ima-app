import type { JSONValue, ModelMessage, UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import type { RetentionMetadata } from '@ima/core';
import {
  attachRuntimeRetentionContext,
  captureRuntimeEphemeralToolCall,
  captureRuntimeEphemeralToolResult,
  isRuntimeJsonValue,
  isRuntimeRetentionWindowOpen,
  makeRuntimeRetentionReplayReference,
  referenceOnlyRuntimeMessage,
  RUNTIME_RETENTION_WITHHELD,
  runtimeEphemeralIsUsable,
  RuntimeRetentionError,
  sanitizeRuntimeCompactionSummary,
  sanitizeRuntimeMessageForPersistence,
  type RuntimeRetentionContext,
  type RuntimeRetentionEphemeralToolCall,
  type RuntimeRetentionEphemeralToolResult,
} from '../../src/runtime/runtime-retention';
import { projectRuntimeCurrentTurnMessages } from '../../src/runtime/retention/runtime-retention-model';

const NOW = '2026-09-10T00:00:00Z';
const RANDOM_CANARY = 'runtime-retention-secret-7f2a';

const ALLOW_RETENTION = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-10T04:00:00Z',
  freshUntil: '2026-09-10T01:00:00Z',
  displayUntil: '2026-09-10T02:00:00Z',
  retentionUntil: '2026-09-10T04:00:00Z',
  deletionScheduledAt: '2026-09-10T04:00:00Z',
  attribution: null,
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
} satisfies RetentionMetadata;

const DENY_RETENTION = {
  retentionDecision: 'deny',
  retentionMode: 'session_only',
  sessionExpiresAt: '2026-09-11T00:00:00Z',
  freshUntil: null,
  displayUntil: null,
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only',
  policyStatus: 'policy_withheld',
  displayPolicyStatus: 'policy_withheld',
} satisfies RetentionMetadata;

const context: RuntimeRetentionContext = {
  ownerScopeRef: 'owner-runtime',
  threadId: 'thread-runtime',
  turnId: 'turn-runtime',
  retention: ALLOW_RETENTION,
};

const currentScope = {
  ownerScopeRef: context.ownerScopeRef,
  threadId: context.threadId,
  turnId: context.turnId,
};

function message(parts: UIMessage['parts'], metadata?: unknown): UIMessage {
  return {
    id: 'message-runtime',
    role: 'user',
    parts,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function textParts(value: UIMessage): string[] {
  return value.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []));
}

function toolCall(toolCallId: string, input: JSONValue): ModelMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId, toolName: 'search_places', input }],
  };
}

function toolResult(toolCallId: string, output: JSONValue): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName: 'search_places',
        output: { type: 'json', value: output },
      },
    ],
  };
}

describe('runtime retention boundary', () => {
  it('accepts only plain finite JSON and never invokes an accessor', () => {
    expect(isRuntimeJsonValue({ nested: ['ok', 1, false, null] })).toBe(true);
    expect(isRuntimeJsonValue(new Date())).toBe(false);
    expect(isRuntimeJsonValue(new Map([['key', 'value']]))).toBe(false);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(isRuntimeJsonValue(cyclic)).toBe(false);

    let getterCalled = false;
    const withGetter = {};
    Object.defineProperty(withGetter, 'secret', {
      enumerable: true,
      get() {
        getterCalled = true;
        return RANDOM_CANARY;
      },
    });
    expect(isRuntimeJsonValue(withGetter)).toBe(false);
    expect(getterCalled).toBe(false);
  });

  it('checks every scope identity and every retention boundary on each projection', () => {
    const entry = captureRuntimeEphemeralToolCall(context, {
      toolCallId: 'call-runtime',
      toolName: 'search_places',
      input: { fact: RANDOM_CANARY },
    });
    expect(runtimeEphemeralIsUsable(entry, currentScope, NOW)).toBe(true);
    expect(
      runtimeEphemeralIsUsable(entry, { ...currentScope, ownerScopeRef: 'other-owner' }, NOW),
    ).toBe(false);
    expect(
      runtimeEphemeralIsUsable(entry, { ...currentScope, threadId: 'other-thread' }, NOW),
    ).toBe(false);
    expect(runtimeEphemeralIsUsable(entry, { ...currentScope, turnId: 'other-turn' }, NOW)).toBe(
      false,
    );

    expect(isRuntimeRetentionWindowOpen(ALLOW_RETENTION, NOW)).toBe(true);
    expect(isRuntimeRetentionWindowOpen(ALLOW_RETENTION, '2026-09-10T01:00:00Z')).toBe(false);
    expect(
      isRuntimeRetentionWindowOpen(
        { ...ALLOW_RETENTION, displayPolicyStatus: 'policy_withheld' },
        NOW,
      ),
    ).toBe(false);
    expect(isRuntimeRetentionWindowOpen(DENY_RETENTION, NOW)).toBe(false);
  });

  it('copies ephemeral values and rejects unknown tool names without retaining input identity', () => {
    const input = { fact: RANDOM_CANARY };
    const entry = captureRuntimeEphemeralToolCall(context, {
      toolCallId: 'call-copy',
      toolName: 'search_places',
      input,
    });
    input.fact = 'changed-after-capture';
    expect(entry.input).toEqual({ fact: RANDOM_CANARY });
    const invalid: Parameters<typeof captureRuntimeEphemeralToolCall>[1] = {
      toolCallId: 'call-unknown',
      toolName: 'search_places',
      input: {},
    };
    Object.defineProperty(invalid, 'toolName', { enumerable: true, value: 'unknown_tool' });
    expect(() => captureRuntimeEphemeralToolCall(context, invalid)).toThrowError(
      new RuntimeRetentionError('RETENTION_EPHEMERAL_INVALID'),
    );
  });

  it('discards client metadata and structurally allowlists persistable parts', () => {
    const attached = attachRuntimeRetentionContext(
      message([{ type: 'text', text: `keep ${RANDOM_CANARY}` }], {
        ownerScopeRef: 'attacker-owner',
        threadId: 'attacker-thread',
        turnId: 'attacker-turn',
        retention: DENY_RETENTION,
        runtimeCanary: RANDOM_CANARY,
      }),
      context,
    );
    expect(attached.metadata).toEqual({
      ownerScopeRef: context.ownerScopeRef,
      threadId: context.threadId,
      turnId: context.turnId,
      retention: ALLOW_RETENTION,
    });

    const persisted = sanitizeRuntimeMessageForPersistence(
      message([
        { type: 'text', text: 'allowed text' },
        { type: 'step-start' },
        { type: 'reasoning', text: RANDOM_CANARY },
        { type: 'data-secret', data: RANDOM_CANARY },
        { type: 'file', mediaType: 'text/plain', url: `data:text/plain,${RANDOM_CANARY}` },
      ]),
      context,
      NOW,
    );
    expect(persisted.parts).toEqual([
      { type: 'text', text: 'allowed text' },
      { type: 'step-start' },
    ]);
    expect(JSON.stringify(persisted)).not.toContain(RANDOM_CANARY);
  });

  it('uses a reference envelope for denied or expired bodies and never compacts raw text', () => {
    const denied = sanitizeRuntimeMessageForPersistence(
      message([{ type: 'text', text: RANDOM_CANARY }]),
      { ...context, retention: DENY_RETENTION },
      NOW,
    );
    expect(textParts(denied)).toEqual([RUNTIME_RETENTION_WITHHELD]);
    expect(denied.metadata.retention.restoreMode).toBe('reference_only');
    expect(JSON.stringify(denied)).not.toContain(RANDOM_CANARY);
    expect(sanitizeRuntimeCompactionSummary(RANDOM_CANARY)).toBe(RUNTIME_RETENTION_WITHHELD);

    const reference = referenceOnlyRuntimeMessage(
      attachRuntimeRetentionContext(message([{ type: 'text', text: RANDOM_CANARY }]), context),
    );
    expect(textParts(reference)).toEqual([RUNTIME_RETENTION_WITHHELD]);
    const replay = makeRuntimeRetentionReplayReference('response-runtime', 3, context);
    expect(replay).toMatchObject({
      responseId: 'response-runtime',
      revision: 3,
      restoreMode: 'reference_only',
      body: null,
      bodyResent: false,
    });
  });

  it('rejects persisted metadata scope mismatches before a public persistence call', () => {
    const foreign = message([{ type: 'text', text: 'foreign' }], {
      ownerScopeRef: 'foreign-owner',
      threadId: context.threadId,
      turnId: context.turnId,
      retention: ALLOW_RETENTION,
    });
    expect(() => sanitizeRuntimeMessageForPersistence(foreign, context, NOW)).toThrowError(
      new RuntimeRetentionError('RETENTION_OWNER_MISMATCH'),
    );

    const malformed = message([{ type: 'text', text: 'malformed' }], {
      ownerScopeRef: context.ownerScopeRef,
      threadId: context.threadId,
      turnId: context.turnId,
      retention: ALLOW_RETENTION,
      unknown: RANDOM_CANARY,
    });
    expect(() => sanitizeRuntimeMessageForPersistence(malformed, context, NOW)).toThrowError(
      new RuntimeRetentionError('RETENTION_METADATA_INVALID'),
    );
  });
});

describe('runtime model message projection', () => {
  const currentCall: RuntimeRetentionEphemeralToolCall = captureRuntimeEphemeralToolCall(context, {
    toolCallId: 'call-current',
    toolName: 'search_places',
    input: { necessaryFact: RANDOM_CANARY },
  });
  const currentResult: RuntimeRetentionEphemeralToolResult = captureRuntimeEphemeralToolResult(
    context,
    {
      toolCallId: 'call-current',
      toolName: 'search_places',
      output: { placeName: RANDOM_CANARY },
      localFreshUntil: '2026-09-10T01:00:00Z',
      localExpiresAt: '2026-09-10T01:30:00Z',
    },
  );
  const oldCall = captureRuntimeEphemeralToolCall(
    { ...context, turnId: 'turn-old' },
    {
      toolCallId: 'call-old',
      toolName: 'search_places',
      input: { oldFact: RANDOM_CANARY },
    },
  );
  const oldResult = captureRuntimeEphemeralToolResult(
    { ...context, turnId: 'turn-old' },
    {
      toolCallId: 'call-old',
      toolName: 'search_places',
      output: { oldPlace: RANDOM_CANARY },
      localFreshUntil: '2026-09-10T01:00:00Z',
      localExpiresAt: '2026-09-10T01:30:00Z',
    },
  );

  it('restores only current-turn ephemeral tool facts while rebuilding public AI SDK messages', () => {
    const messages = [
      { role: 'user', content: `old request ${RANDOM_CANARY}` },
      toolCall('call-old', { oldProviderSecret: RANDOM_CANARY }),
      toolResult('call-old', { oldProviderSecret: RANDOM_CANARY }),
      {
        role: 'user',
        content: 'current request',
        providerOptions: { test: { secret: RANDOM_CANARY } },
      } satisfies ModelMessage,
      toolCall('call-current', { providerSecret: RANDOM_CANARY }),
      toolResult('call-current', { providerSecret: RANDOM_CANARY }),
    ] satisfies ModelMessage[];

    const projected = projectRuntimeCurrentTurnMessages(messages, {
      currentTurnStart: 3,
      currentScope,
      now: NOW,
      toolCalls: new Map([
        [oldCall.toolCallId, oldCall],
        [currentCall.toolCallId, currentCall],
      ]),
      toolResults: new Map([
        [oldResult.toolCallId, oldResult],
        [currentResult.toolCallId, currentResult],
      ]),
    });

    const oldProjectedCall = projected[1];
    const oldProjectedResult = projected[2];
    const currentProjectedCall = projected[4];
    const currentProjectedResult = projected[5];
    expect(oldProjectedCall).toMatchObject({
      content: [{ input: { input: { query: 'WITHHELD' } } }],
    });
    expect(JSON.stringify(oldProjectedCall)).not.toContain(RANDOM_CANARY);
    expect(JSON.stringify(oldProjectedResult)).not.toContain(RANDOM_CANARY);
    expect(projected[0]).toEqual({ role: 'user', content: RUNTIME_RETENTION_WITHHELD });
    expect(currentProjectedCall).toMatchObject({
      content: [{ input: { necessaryFact: RANDOM_CANARY } }],
    });
    expect(currentProjectedResult).toMatchObject({
      content: [{ output: { type: 'json', value: { placeName: RANDOM_CANARY } } }],
    });
    expect(JSON.stringify(projected)).not.toContain('providerSecret');
    expect(projected[3]).toEqual({ role: 'user', content: RUNTIME_RETENTION_WITHHELD });
  });

  it('rechecks identity and policy at each step before re-injection', () => {
    const messageValues = [toolCall('call-current', {}), toolResult('call-current', {})];
    const maps = {
      toolCalls: new Map([[currentCall.toolCallId, currentCall]]),
      toolResults: new Map([[currentResult.toolCallId, currentResult]]),
    };
    const foreign = projectRuntimeCurrentTurnMessages(messageValues, {
      currentTurnStart: 0,
      currentScope: { ...currentScope, ownerScopeRef: 'foreign-owner' },
      now: NOW,
      ...maps,
    });
    expect(JSON.stringify(foreign)).not.toContain(RANDOM_CANARY);

    const localExpired = projectRuntimeCurrentTurnMessages(messageValues, {
      currentTurnStart: 0,
      currentScope,
      now: '2026-09-10T01:00:00Z',
      ...maps,
    });
    expect(JSON.stringify(localExpired)).not.toContain(RANDOM_CANARY);

    const expired = projectRuntimeCurrentTurnMessages(messageValues, {
      currentTurnStart: 0,
      currentScope,
      now: ALLOW_RETENTION.retentionUntil,
      ...maps,
    });
    expect(JSON.stringify(expired)).not.toContain(RANDOM_CANARY);
  });

  it('keeps only an explicitly trusted fixed system instruction', () => {
    const projected = projectRuntimeCurrentTurnMessages(
      [
        { role: 'system', content: 'trusted runtime guidance' },
        { role: 'system', content: `untrusted ${RANDOM_CANARY}` },
      ],
      {
        currentTurnStart: 2,
        currentScope,
        now: NOW,
        trustedSystemText: 'trusted runtime guidance',
        toolCalls: new Map(),
        toolResults: new Map(),
      },
    );
    expect(projected).toEqual([
      { role: 'system', content: 'trusted runtime guidance' },
      { role: 'system', content: RUNTIME_RETENTION_WITHHELD },
    ]);
  });
});
