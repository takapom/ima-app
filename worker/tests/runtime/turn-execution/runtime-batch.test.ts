import { describe, expect, it } from 'vitest';
import {
  validateRuntimeBatch,
  type RuntimeBatchAction,
} from '@worker/runtime/turn-execution/runtime-batch';

describe('validateRuntimeBatch', () => {
  it('accepts reads as a non-terminal batch and a single respond as terminal', () => {
    expect(validateRuntimeBatch([{ kind: 'tool', operation: 'search_places' }])).toEqual({
      ok: true,
      terminal: 'none',
      missingRespond: null,
    });
    expect(validateRuntimeBatch([{ kind: 'tool', operation: 'respond' }])).toEqual({
      ok: true,
      terminal: 'respond',
      missingRespond: null,
    });
  });

  it('rejects mixed reads, multiple responds, retired tools and empty tool finishes', () => {
    const cases: Array<[RuntimeBatchAction[], string]> = [
      [
        [
          { kind: 'tool', operation: 'get_place_details' },
          { kind: 'tool', operation: 'respond' },
        ],
        'MIXED_TERMINAL_ACTION',
      ],
      [
        [
          { kind: 'tool', operation: 'respond' },
          { kind: 'tool', operation: 'respond' },
        ],
        'MULTIPLE_RESPOND',
      ],
      [[{ kind: 'tool', operation: 'submit_cards' }], 'UNKNOWN_TOOL'],
      [[{ kind: 'tool', operation: 'read' }], 'UNKNOWN_TOOL'],
      [[], 'TOOL_FINISH_WITHOUT_TOOL'],
    ];
    for (const [actions, code] of cases) {
      expect(validateRuntimeBatch(actions)).toMatchObject({ ok: false, issue: { code } });
    }
  });

  it('commits nothing when a step ends without a tool call, and says whether text was written', () => {
    expect(validateRuntimeBatch([{ kind: 'text', text: '{"kind":"answer"}' }])).toEqual({
      ok: true,
      terminal: 'none',
      missingRespond: 'TEXT_WITHOUT_RESPOND',
    });
    expect(validateRuntimeBatch([{ kind: 'text', text: ' ' }])).toEqual({
      ok: true,
      terminal: 'none',
      missingRespond: 'EMPTY_STEP',
    });
  });
});
