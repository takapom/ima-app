import { stepCountIs, streamText, tool } from 'ai';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RUNTIME_BUDGET } from '@worker/infrastructure/runtime/budget/runtime-budget';
import {
  RUNTIME_MODEL_MAX_RETRIES,
  wrapRuntimeModelGuard,
  type RuntimeModelGuardAcceptance,
  type RuntimeModelGuardCallOptions,
  type RuntimeModelGuardGenerateResult,
  type RuntimeModelGuardStreamPart,
} from '@worker/infrastructure/runtime/turn-execution/runtime-model-guard';
import {
  budget,
  expectGuardCode,
  finish,
  guarded,
  modelFor,
  modelScript,
  readAll,
  streamCall,
  textParts,
  toolParts,
  usage,
  type GenerateContent,
} from './runtime-model-guard-fixture';

describe('wrapRuntimeModelGuard', () => {
  it('reserves before the provider and reports acceptance only after a complete valid step', async () => {
    const script = modelScript([...toolParts('search_places'), finish('tool-calls')]);
    const accepted: RuntimeModelGuardAcceptance[] = [];
    const model = guarded(script, { onAccepted: (value) => accepted.push(value) });

    const result = await streamCall(model);
    await readAll(result.stream);

    expect(script.calls.stream).toBe(1);
    expect(accepted).toEqual([
      expect.objectContaining({ terminal: 'none', finalText: null, emptyFinal: false }),
    ]);
  });

  it.each([
    [
      'read and submit',
      [...toolParts('search_places'), ...toolParts('submit_cards'), finish('tool-calls')],
      'MIXED_TERMINAL_ACTION',
    ],
    [
      'multiple submit',
      [
        ...toolParts('submit_cards', 'submit-1'),
        ...toolParts('submit_cards', 'submit-2'),
        finish('tool-calls'),
      ],
      'MULTIPLE_SUBMIT',
    ],
    ['unknown tool', [...toolParts('delete_everything'), finish('tool-calls')], 'UNKNOWN_TOOL'],
  ] as const)('rejects %s before acceptance', async (_name, parts, code) => {
    const script = modelScript(parts);
    const accepted: RuntimeModelGuardAcceptance[] = [];
    const model = guarded(script, { onAccepted: (value) => accepted.push(value) });

    await expectGuardCode(streamCall(model), code);
    expect(accepted).toEqual([]);
  });

  it('rejects a mixed provider step before AI SDK tools or step metadata run', async () => {
    const script = modelScript([
      ...toolParts('search_places'),
      ...toolParts('submit_cards'),
      finish('tool-calls'),
    ]);
    const effects: string[] = [];
    const model = wrapRuntimeModelGuard(modelFor(script), {
      budget: budget(),
      remainingTimeMs: () => DEFAULT_RUNTIME_BUDGET.wholeTurnMs,
      onAccepted: () => effects.push('accepted'),
    });
    const generated = streamText({
      model,
      prompt: 'fixture',
      maxRetries: RUNTIME_MODEL_MAX_RETRIES,
      stopWhen: stepCountIs(1),
      tools: {
        search_places: tool<unknown, { ok: boolean }>({
          inputSchema: z.object({}),
          execute: () => {
            effects.push('search_places');
            return { ok: true };
          },
        }),
        submit_cards: tool<unknown, { ok: boolean }>({
          inputSchema: z.object({}),
          execute: () => {
            effects.push('submit_cards');
            return { ok: true };
          },
        }),
      },
    });

    await expect(generated.text).rejects.toBeDefined();
    expect(effects).toEqual([]);
  });

  it('rejects provider executed and dynamic tool parts', async () => {
    const providerScript = modelScript([
      {
        type: 'tool-input-start',
        id: 'provider',
        toolName: 'search_places',
        providerExecuted: true,
      },
      finish('tool-calls'),
    ]);
    await expectGuardCode(streamCall(guarded(providerScript)), 'UNSUPPORTED_PART');

    const dynamicScript = modelScript([
      {
        type: 'tool-call',
        toolCallId: 'dynamic',
        toolName: 'search_places',
        input: '{}',
        dynamic: true,
      },
      finish('tool-calls'),
    ]);
    await expectGuardCode(streamCall(guarded(dynamicScript)), 'UNSUPPORTED_PART');
  });

  it('applies the same size limits to generate results and rejects source/file payloads', async () => {
    const textResult = {
      content: [{ type: 'text', text: 'too large' } satisfies GenerateContent],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      warnings: [],
    } satisfies RuntimeModelGuardGenerateResult;
    const script = modelScript(undefined, { generateResult: textResult });
    const model = guarded(script, { maxParts: 1, maxBytes: 1 });
    await expectGuardCode(model.doGenerate({ prompt: [] }), 'MODEL_STREAM_LIMIT');
    const oversized = modelScript([...textParts('a'.repeat(256 * 1024)), finish('stop')]);
    await expectGuardCode(streamCall(guarded(oversized)), 'MODEL_STREAM_LIMIT');

    const sourceResult = {
      ...textResult,
      content: [
        {
          type: 'source',
          sourceType: 'url',
          id: 'source-1',
          url: 'https://example.test',
          title: 'fixture',
        } satisfies GenerateContent,
      ],
    } satisfies RuntimeModelGuardGenerateResult;
    const sourceScript = modelScript(undefined, { generateResult: sourceResult });
    await expectGuardCode(guarded(sourceScript).doGenerate({ prompt: [] }), 'UNSUPPORTED_PART');
  });

  it('accepts an empty final and keeps retry configuration at zero', async () => {
    const script = modelScript([{ type: 'stream-start', warnings: [] }, finish('stop')]);
    const accepted: RuntimeModelGuardAcceptance[] = [];
    const finalFlags: boolean[] = [];
    const model = guarded(script, {
      isFinalResponse: () => true,
      remainingTimeMs: (finalResponse) => {
        finalFlags.push(finalResponse);
        return 10_000;
      },
      onAccepted: (value) => accepted.push(value),
    });
    const result = await streamCall(model);
    await readAll(result.stream);

    expect(RUNTIME_MODEL_MAX_RETRIES).toBe(0);
    expect(finalFlags).toEqual([true]);
    expect(accepted).toEqual([
      expect.objectContaining({ terminal: 'message', finalText: '', emptyFinal: true }),
    ]);
  });

  it('captures only validated terminal text for stream and generate acceptance', async () => {
    const streamAccepted: RuntimeModelGuardAcceptance[] = [];
    const streamScript = modelScript([
      { type: 'reasoning-start', id: 'reasoning-1' },
      { type: 'reasoning-delta', id: 'reasoning-1', delta: 'private reasoning' },
      { type: 'reasoning-end', id: 'reasoning-1' },
      ...textParts('stream final'),
      finish('stop'),
    ]);
    const streamModel = guarded(streamScript, {
      onAccepted: (value) => streamAccepted.push(value),
    });
    const streamed = await streamCall(streamModel);
    await readAll(streamed.stream);

    const generatedAccepted: RuntimeModelGuardAcceptance[] = [];
    const generatedResult = {
      content: [
        { type: 'reasoning', text: 'private reasoning' } satisfies GenerateContent,
        { type: 'text', text: 'generated final' } satisfies GenerateContent,
      ],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      warnings: [],
    } satisfies RuntimeModelGuardGenerateResult;
    const generateModel = guarded(modelScript(undefined, { generateResult: generatedResult }), {
      onAccepted: (value) => generatedAccepted.push(value),
    });
    await generateModel.doGenerate({ prompt: [] });

    expect(streamAccepted[0]).toMatchObject({ terminal: 'message', finalText: 'stream final' });
    expect(generatedAccepted[0]).toMatchObject({
      terminal: 'message',
      finalText: 'generated final',
    });
    expect(streamAccepted[0]).not.toHaveProperty('reasoning');
    expect(generatedAccepted[0]).not.toHaveProperty('provider');
  });

  it('propagates an arbitrary provider rejection without relabeling it', async () => {
    const providerError = new Error('fixture provider failure');
    const script = modelScript();
    const model = wrapRuntimeModelGuard(
      {
        ...modelFor(script),
        doStream: () => Promise.reject(providerError),
      },
      {
        budget: budget(),
        remainingTimeMs: () => DEFAULT_RUNTIME_BUDGET.wholeTurnMs,
      },
    );

    await expect(streamCall(model)).rejects.toBe(providerError);
  });

  it.each([
    ['stale', budget({}, { isStale: () => true }), 'STALE_TURN'],
    ['deadline', budget({}, { now: () => DEFAULT_RUNTIME_BUDGET.wholeTurnMs }), 'DEADLINE'],
    ['step budget', budget({ maxModelSteps: 1 }), 'BUDGET_EXCEEDED'],
  ] as const)('denies %s before entering the provider', async (_name, deniedBudget, code) => {
    const script = modelScript();
    if (code === 'BUDGET_EXCEEDED') {
      expect(deniedBudget.reserveModelStep().ok).toBe(true);
    }
    const model = wrapRuntimeModelGuard(modelFor(script), {
      budget: deniedBudget,
      remainingTimeMs: (finalResponse) => deniedBudget.remainingModelTimeMs(finalResponse),
    });

    await expectGuardCode(streamCall(model), code);
    expect(script.calls.stream).toBe(0);
  });

  it('rejects zero remaining allowance before the provider call starts', async () => {
    const script = modelScript();
    const model = guarded(script, { remainingTimeMs: () => 0 });

    await expectGuardCode(streamCall(model), 'DEADLINE');
    expect(script.calls.stream).toBe(0);
  });

  it('denies a caller-cancelled call and a late stream without returning provider output', async () => {
    const caller = new AbortController();
    caller.abort();
    const cancelledScript = modelScript();
    await expectGuardCode(streamCall(guarded(cancelledScript), caller.signal), 'CANCELLED');
    expect(cancelledScript.calls.stream).toBe(0);

    let cancelledUpstream = false;
    const lateScript = modelScript();
    const lateModel = wrapRuntimeModelGuard(
      {
        ...modelFor(lateScript),
        doStream: (options: RuntimeModelGuardCallOptions) => {
          lateScript.calls.stream += 1;
          if (options.abortSignal !== undefined) {
            lateScript.seenSignals.push(options.abortSignal);
          }
          return Promise.resolve({
            stream: new ReadableStream<RuntimeModelGuardStreamPart>({
              cancel: () => {
                cancelledUpstream = true;
              },
            }),
          });
        },
      },
      {
        budget: budget(),
        remainingTimeMs: () => DEFAULT_RUNTIME_BUDGET.wholeTurnMs,
        maxBufferMs: 1_000,
      },
    );
    const lateCaller = new AbortController();
    const pending = streamCall(lateModel, lateCaller.signal);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    lateCaller.abort();
    await expectGuardCode(pending, 'MODEL_STREAM_ABORTED');
    expect(cancelledUpstream).toBe(true);
    expect(lateScript.seenSignals[0]?.aborted).toBe(true);
  });

  it('cancels a provider that ignores the signal when the whole call timeout expires', async () => {
    const script = modelScript(undefined, { pendingStream: true });
    const model = guarded(script, {
      maxBufferMs: 10,
      remainingTimeMs: () => 10,
    });

    await expectGuardCode(streamCall(model), 'MODEL_STREAM_TIMEOUT');
    expect(script.seenSignals[0]?.aborted).toBe(true);
  });

  it('cancels the upstream stream on a part limit and tolerates fine-grained valid chunks', async () => {
    let cancelled = false;
    const parts = [...textParts('a'), finish('stop')];
    const script = modelScript();
    const model = wrapRuntimeModelGuard(
      {
        ...modelFor(script),
        doStream: (options: RuntimeModelGuardCallOptions) => {
          script.calls.stream += 1;
          if (options.abortSignal !== undefined) script.seenSignals.push(options.abortSignal);
          let index = 0;
          return Promise.resolve({
            stream: new ReadableStream<RuntimeModelGuardStreamPart>({
              pull(controller) {
                const part = parts[index];
                if (part === undefined) return;
                index += 1;
                controller.enqueue(part);
              },
              cancel: () => {
                cancelled = true;
              },
            }),
          });
        },
      },
      {
        budget: budget(),
        remainingTimeMs: () => DEFAULT_RUNTIME_BUDGET.wholeTurnMs,
        maxParts: 1,
      },
    );
    await expectGuardCode(streamCall(model), 'MODEL_STREAM_LIMIT');
    expect(cancelled).toBe(true);

    const fineGrained = modelScript([
      { type: 'stream-start', warnings: [] },
      ...Array.from({ length: 1000 }, (_, index) => ({
        type: 'text-delta' as const,
        id: `msg_${'a'.repeat(60)}`,
        delta: index === 999 ? '!' : 'a',
      })),
      finish('stop'),
    ]);
    const fineModel = guarded(fineGrained);
    const result = await streamCall(fineModel);
    await readAll(result.stream);
    expect(fineGrained.calls.stream).toBe(1);
  });
});
