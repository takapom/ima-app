import { describe, expect, it } from 'vitest';
import type { RuntimeModelGuardAcceptance } from '@worker/runtime/turn-execution/runtime-model-guard';
import {
  finish,
  guarded,
  modelScript,
  readAll,
  streamCall,
  textParts,
  toolParts,
} from './runtime-model-guard-fixture';

/**
 * A preamble next to a tool call is the formatting habit most models have. Denying it would end
 * the turn and discard every read it already paid for, so the guard drops the text instead.
 */
describe('runtime model guard preamble text', () => {
  it.each([
    ['a tool-calls finish', finish('tool-calls')],
    ['a stop finish', finish('stop')],
  ] as const)('drops preamble text next to a tool call with %s', async (_name, finishPart) => {
    const script = modelScript([
      ...textParts('探しますね'),
      ...toolParts('search_places'),
      finishPart,
    ]);
    const accepted: RuntimeModelGuardAcceptance[] = [];
    const model = guarded(script, { onAccepted: (value) => accepted.push(value) });

    const result = await streamCall(model);
    await readAll(result.stream);

    // The preamble is not a terminal action, so the read runs instead of denying the turn.
    expect(accepted).toEqual([expect.objectContaining({ terminal: 'none', missingRespond: null })]);
  });

  it('keeps a submit next to preamble text instead of denying the step', async () => {
    const script = modelScript([
      ...textParts('カードを出します'),
      ...toolParts('respond'),
      finish('tool-calls'),
    ]);
    const accepted: RuntimeModelGuardAcceptance[] = [];
    const model = guarded(script, { onAccepted: (value) => accepted.push(value) });

    const result = await streamCall(model);
    await readAll(result.stream);

    expect(accepted).toEqual([
      expect.objectContaining({ terminal: 'respond', missingRespond: null }),
    ]);
  });

  it('commits nothing when the step writes text instead of calling respond', async () => {
    const script = modelScript([...textParts('確認しました'), finish('stop')]);
    const accepted: RuntimeModelGuardAcceptance[] = [];
    const model = guarded(script, { onAccepted: (value) => accepted.push(value) });

    const result = await streamCall(model);
    await readAll(result.stream);

    expect(accepted).toEqual([
      expect.objectContaining({ terminal: 'none', missingRespond: 'TEXT_WITHOUT_RESPOND' }),
    ]);
  });
});
