import type { JSONValue, ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  defaultRuntimeModelContextPolicy,
  projectRuntimeToolResultForModel,
} from '../../../src/runtime/context/runtime-field-policy';
import {
  captureRuntimeEphemeralToolCall,
  captureRuntimeEphemeralToolResult,
  type RuntimeRetentionContext,
} from '../../../src/runtime/retention/runtime-retention';
import { projectRuntimeCurrentTurnMessages } from '../../../src/runtime/retention/runtime-retention-model';

const NOW = '2026-09-10T00:00:00Z';
const CANARY = 'M16_MODEL_INPUT_CANARY';

const retention = {
  retentionDecision: 'deny',
  retentionMode: 'session_only',
  sessionExpiresAt: '2026-09-10T04:00:00Z',
  freshUntil: null,
  displayUntil: null,
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only',
  policyStatus: 'policy_withheld',
  displayPolicyStatus: 'policy_withheld',
} as const;

const context: RuntimeRetentionContext = {
  ownerScopeRef: 'owner-runtime-model',
  threadId: 'thread-runtime-model',
  turnId: 'turn-runtime-model',
  retention,
};

const scope = {
  ownerScopeRef: context.ownerScopeRef,
  threadId: context.threadId,
  turnId: context.turnId,
};

const toolCall = (toolCallId: string, input: JSONValue): ModelMessage => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId, toolName: 'search_places', input }],
});

const toolResult = (toolCallId: string, output: JSONValue): ModelMessage => ({
  role: 'tool',
  content: [
    {
      type: 'tool-result',
      toolCallId,
      toolName: 'search_places',
      output: { type: 'json', value: output },
    },
  ],
});

const providerResult: JSONValue = {
  status: 'ok',
  data: {
    items: [
      {
        candidateId: 'candidate-model-input',
        fields: {
          identity: {
            status: 'known',
            observations: [
              {
                observationId: 'observation-model-input',
                candidateId: 'candidate-model-input',
                field: 'identity',
                value: {
                  name: CANARY,
                  area: '渋谷',
                  address: null,
                  category: 'cafe',
                  businessStatus: 'operational',
                  sourceUrl: null,
                },
                basis: 'provider_reported',
                fetchedAt: NOW,
                sourceUpdatedAt: null,
                expiresAt: '2026-09-10T01:30:00Z',
                freshUntil: '2026-09-10T01:00:00Z',
                sources: [{ provider: 'fixture', attribution: null, publicUrl: null }],
              },
            ],
          },
        },
      },
    ],
  },
  warnings: [],
};

describe('runtime model-input projection', () => {
  it('keeps raw tool input withheld while allowing only the explicit llm_input result', () => {
    const call = captureRuntimeEphemeralToolCall(context, {
      toolCallId: 'call-model-input',
      toolName: 'search_places',
      input: { providerInputCanary: CANARY },
    });
    const result = captureRuntimeEphemeralToolResult(context, {
      toolCallId: 'call-model-input',
      toolName: 'search_places',
      output: providerResult,
      localFreshUntil: '2026-09-10T01:00:00Z',
      localExpiresAt: '2026-09-10T01:30:00Z',
    });
    const llmOnlyPolicy = {
      ...defaultRuntimeModelContextPolicy,
      evidence: { ...defaultRuntimeModelContextPolicy.evidence, identity: 'allow' as const },
    };
    const projected = projectRuntimeCurrentTurnMessages(
      [
        toolCall(call.toolCallId, { providerInputCanary: CANARY }),
        toolResult(result.toolCallId, providerResult),
      ],
      {
        currentTurnStart: 0,
        currentScope: scope,
        now: NOW,
        toolCalls: new Map([[call.toolCallId, call]]),
        toolResults: new Map([[result.toolCallId, result]]),
        projectToolOutput: (output) => projectRuntimeToolResultForModel(output, llmOnlyPolicy),
      },
    );

    expect(JSON.stringify(projected[0])).not.toContain(CANARY);
    expect(JSON.stringify(projected[1])).toContain(CANARY);
  });

  it('withholds the same result when the model field policy denies identity', () => {
    const call = captureRuntimeEphemeralToolCall(context, {
      toolCallId: 'call-model-input-denied',
      toolName: 'search_places',
      input: {},
    });
    const result = captureRuntimeEphemeralToolResult(context, {
      toolCallId: 'call-model-input-denied',
      toolName: 'search_places',
      output: providerResult,
      localFreshUntil: '2026-09-10T01:00:00Z',
      localExpiresAt: '2026-09-10T01:30:00Z',
    });
    const projected = projectRuntimeCurrentTurnMessages(
      [toolCall(call.toolCallId, {}), toolResult(result.toolCallId, providerResult)],
      {
        currentTurnStart: 0,
        currentScope: scope,
        now: NOW,
        toolCalls: new Map([[call.toolCallId, call]]),
        toolResults: new Map([[result.toolCallId, result]]),
        projectToolOutput: (output) =>
          projectRuntimeToolResultForModel(output, defaultRuntimeModelContextPolicy),
      },
    );

    expect(JSON.stringify(projected)).not.toContain(CANARY);
  });
});
