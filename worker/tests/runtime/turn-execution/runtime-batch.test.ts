import { describe, expect, it } from 'vitest';
import {
  validateRuntimeBatch,
  type RuntimeBatchAction,
} from '@worker/runtime/turn-execution/runtime-batch';

describe('validateRuntimeBatch', () => {
  it('accepts reads as a non-terminal batch and a single submit as terminal', () => {
    expect(validateRuntimeBatch([{ kind: 'tool', operation: 'search_places' }])).toMatchObject({
      ok: true,
      terminal: 'none',
    });
    expect(validateRuntimeBatch([{ kind: 'tool', operation: 'submit_cards' }])).toMatchObject({
      ok: true,
      terminal: 'submit',
    });
  });

  it('rejects mixed reads, multiple submits, final-plus-tool, and unknown tools', () => {
    const cases: Array<[RuntimeBatchAction[], string]> = [
      [
        [
          { kind: 'tool', operation: 'get_place_details' },
          { kind: 'tool', operation: 'submit_cards' },
        ],
        'MIXED_TERMINAL_ACTION',
      ],
      [
        [
          { kind: 'tool', operation: 'submit_cards' },
          { kind: 'tool', operation: 'submit_cards' },
        ],
        'MULTIPLE_SUBMIT',
      ],
      [
        [
          { kind: 'final', text: 'message' },
          { kind: 'tool', operation: 'search_places' },
        ],
        'FINAL_WITH_TOOL',
      ],
      [[{ kind: 'tool', operation: 'read' }], 'UNKNOWN_TOOL'],
      [[], 'TOOL_FINISH_WITHOUT_TOOL'],
    ];
    for (const [actions, code] of cases) {
      expect(validateRuntimeBatch(actions)).toMatchObject({ ok: false, issue: { code } });
    }
  });

  it('accepts an empty final response without treating it as a tool error', () => {
    expect(validateRuntimeBatch([{ kind: 'final', text: '' }])).toEqual({
      ok: true,
      terminal: 'message',
      emptyFinal: true,
    });
  });
});
