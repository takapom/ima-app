import { expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import type {
  RetentionRuntimeContext,
  RetentionPolicy,
} from './retention/retention-runtime-contract';
import { retentionFor } from './retention/retention-runtime-policy';
import {
  FixtureClock,
  makeRetentionMessage,
  type RetentionExpiryClock,
} from './retention/retention-fixture';
import { sanitizeRuntimeGateMessage } from './runtime-gate-sanitize';

const createdAt = '2026-09-08T04:20:00+09:00';
const tokens = {
  reasoning: 'provider reasoning metadata',
  toolInput: 'provider tool input metadata',
  toolOutput: 'provider tool result metadata',
  metadata: 'provider message metadata',
} as const;

function runtimeContext(policy: RetentionPolicy): {
  context: RetentionRuntimeContext;
  clock: RetentionExpiryClock;
} {
  const clock = new FixtureClock(createdAt);
  return {
    clock,
    context: {
      ownerScopeRef: 'owner-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      now: createdAt,
      retention: retentionFor(policy, createdAt, null),
      policy,
    },
  };
}

function assistantProbe(): UIMessage {
  return {
    id: 'assistant-provider-probe',
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: tokens.reasoning },
      {
        type: 'dynamic-tool',
        toolName: 'search_places',
        toolCallId: 'probe-tool-1',
        state: 'output-available',
        input: { query: tokens.toolInput },
        output: { result: tokens.toolOutput },
        toolMetadata: { source: tokens.metadata },
      },
    ],
    metadata: { runtimeToken: tokens.metadata },
  };
}

it('rebuilds metadata-less assistant tool results before applying retention policy', () => {
  for (const policy of ['allow', 'deny'] as const) {
    const { context, clock } = runtimeContext(policy);
    const source = assistantProbe();
    const sanitized = sanitizeRuntimeGateMessage(source, context, clock, new Set([source.id]));

    expect(sanitized.id).toBe(source.id);
    expect(sanitized.role).toBe('assistant');
    expect(sanitized.metadata).toEqual({
      retention: context.retention,
      ownerScopeRef: context.ownerScopeRef,
      threadId: context.threadId,
      turnId: context.turnId,
    });
    expect(source.metadata).toEqual({ runtimeToken: tokens.metadata });

    if (policy === 'allow') {
      expect(sanitized.parts).toHaveLength(2);
      expect(sanitized.parts[1]).toMatchObject({
        type: 'dynamic-tool',
        state: 'output-available',
        input: { query: tokens.toolInput },
        output: { result: tokens.toolOutput },
      });
      continue;
    }

    expect(sanitized.parts).toEqual([{ type: 'text', text: '[withheld]' }]);
    expect(JSON.stringify(sanitized)).not.toContain(tokens.reasoning);
    expect(JSON.stringify(sanitized)).not.toContain(tokens.toolInput);
    expect(JSON.stringify(sanitized)).not.toContain(tokens.toolOutput);
    expect(JSON.stringify(sanitized)).not.toContain(tokens.metadata);
  }
});

it('validates existing assistant envelopes against the current server owner and thread', () => {
  const { context, clock } = runtimeContext('allow');
  const foreign = makeRetentionMessage({
    id: 'assistant-foreign',
    role: 'assistant',
    text: 'foreign assistant message',
    ownerScopeRef: 'owner-foreign',
    threadId: 'thread-foreign',
    turnId: 'turn-foreign',
    retention: context.retention,
  });

  expect(() => sanitizeRuntimeGateMessage(foreign, context, clock, new Set([foreign.id]))).toThrow(
    'RETENTION_OWNER_MISMATCH',
  );
});
