import { describe, expect, it } from 'vitest';
import {
  type RuntimeModelGuardCallOptions,
  type RuntimeModelGuardGenerateResult,
  type RuntimeModelGuardModel,
  type RuntimeModelGuardStreamPart,
} from '@worker/infrastructure/runtime/turn-execution/runtime-model-guard';
import {
  createBestEffortRuntimeModelTraceSink,
  tokenCountForModelUsage,
  type RuntimeModelTrace,
  traceRecordForRuntimeModel,
  wrapRuntimeModelTrace,
} from '@worker/infrastructure/runtime/tracing/runtime-model-trace';

type FinishPart = Extract<RuntimeModelGuardStreamPart, { type: 'finish' }>;

const usage = {
  inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 },
} satisfies FinishPart['usage'];

const missingUsage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} satisfies FinishPart['usage'];

const finish = (value: FinishPart['usage'] = usage): FinishPart => ({
  type: 'finish',
  usage: value,
  finishReason: { unified: 'stop', raw: 'stop' },
});

const streamOf = (
  parts: readonly RuntimeModelGuardStreamPart[],
): ReadableStream<RuntimeModelGuardStreamPart> =>
  new ReadableStream({
    start(controller) {
      parts.forEach((part) => controller.enqueue(part));
      controller.close();
    },
  });

const readAll = async (
  stream: ReadableStream<RuntimeModelGuardStreamPart>,
): Promise<RuntimeModelGuardStreamPart[]> => {
  const reader = stream.getReader();
  const parts: RuntimeModelGuardStreamPart[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return parts;
      parts.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
};

const generated = (value = 'generated'): RuntimeModelGuardGenerateResult => ({
  content: [{ type: 'text', text: value }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage,
  warnings: [],
});

type ModelScript = {
  readonly stream?: ReadableStream<RuntimeModelGuardStreamPart>;
  readonly generate?: RuntimeModelGuardGenerateResult;
  readonly calls: { stream: number; generate: number };
};

const modelFor = (script: ModelScript): RuntimeModelGuardModel => ({
  specificationVersion: 'v3',
  provider: 'm26-trace-fixture',
  modelId: 'm26-trace-fixture',
  supportedUrls: {},
  doGenerate: (_options: RuntimeModelGuardCallOptions) => {
    script.calls.generate += 1;
    return Promise.resolve(script.generate ?? generated());
  },
  doStream: (_options: RuntimeModelGuardCallOptions) => {
    script.calls.stream += 1;
    return Promise.resolve({ stream: script.stream ?? streamOf([finish()]) });
  },
});

const traceOptions = (traces: RuntimeModelTrace[], monotonicNow: () => number = () => 125) => ({
  ownerScopeRef: 'owner-m26-trace',
  threadId: 'thread-m26-trace',
  turnId: 'turn-m26-trace',
  revision: 3,
  clock: () => '2026-09-11T00:00:00.000Z',
  monotonicNow,
  sink: (trace: RuntimeModelTrace) => {
    traces.push(trace);
  },
});

describe('runtime model call trace', () => {
  it('records one successful stream call with measured V3 token totals', async () => {
    const traces: RuntimeModelTrace[] = [];
    let clockCalls = 0;
    const model = wrapRuntimeModelTrace(
      modelFor({ calls: { stream: 0, generate: 0 } }),
      traceOptions(traces, () => (clockCalls++ === 0 ? 100 : 125)),
    );
    const result = await model.doStream({ prompt: [] });
    await readAll(result.stream);

    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      status: 'ok',
      resultCode: 'OK',
      durationMs: 25,
      tokenCount: 5,
    });
    expect(traces[0]).not.toHaveProperty('provider');
    expect(JSON.stringify(traces[0])).not.toMatch(/prompt|fixture provider failure/iu);
    const firstTrace = traces[0];
    if (firstTrace === undefined) throw new Error('M26_TRACE_MISSING');
    const record = await traceRecordForRuntimeModel(firstTrace);
    expect(record).toMatchObject({ operation: 'call', status: 'ok', tokenCount: 5 });
  });

  it('omits usage when either V3 token total is unavailable', async () => {
    const traces: RuntimeModelTrace[] = [];
    const model = wrapRuntimeModelTrace(
      modelFor({ calls: { stream: 0, generate: 0 }, stream: streamOf([finish(missingUsage)]) }),
      traceOptions(traces),
    );
    const result = await model.doStream({ prompt: [] });
    await readAll(result.stream);

    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ status: 'ok', resultCode: 'OK' });
    expect(traces[0]).not.toHaveProperty('tokenCount');
    expect(tokenCountForModelUsage(missingUsage)).toBeUndefined();
  });

  it('classifies finishless and mid-stream failures without storing provider errors', async () => {
    const finishlessTraces: RuntimeModelTrace[] = [];
    const finishless = wrapRuntimeModelTrace(
      modelFor({
        calls: { stream: 0, generate: 0 },
        stream: streamOf([{ type: 'stream-start', warnings: [] }]),
      }),
      traceOptions(finishlessTraces),
    );
    const finishlessResult = await finishless.doStream({ prompt: [] });
    await readAll(finishlessResult.stream);
    expect(finishlessTraces[0]).toMatchObject({ status: 'error', resultCode: 'INTERNAL' });

    const midstreamTraces: RuntimeModelTrace[] = [];
    const midstream = wrapRuntimeModelTrace(
      modelFor({
        calls: { stream: 0, generate: 0 },
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.error(new Error('PROVIDER_SECRET_CANARY'));
          },
        }),
      }),
      traceOptions(midstreamTraces),
    );
    const midstreamResult = await midstream.doStream({ prompt: [] });
    await expect(readAll(midstreamResult.stream)).rejects.toThrow('PROVIDER_SECRET_CANARY');
    expect(midstreamTraces[0]).toMatchObject({ status: 'error', resultCode: 'INTERNAL' });
    expect(JSON.stringify(midstreamTraces[0])).not.toContain('PROVIDER_SECRET_CANARY');
  });

  it('records a fixed failure while propagating a provider rejection', async () => {
    const traces: RuntimeModelTrace[] = [];
    const providerError = new Error('PROVIDER_SECRET_CANARY');
    const model = wrapRuntimeModelTrace(
      {
        ...modelFor({ calls: { stream: 0, generate: 0 } }),
        doStream: (_options: RuntimeModelGuardCallOptions) => Promise.reject(providerError),
      },
      traceOptions(traces),
    );

    await expect(model.doStream({ prompt: [] })).rejects.toBe(providerError);
    expect(traces[0]).toMatchObject({ status: 'error', resultCode: 'INTERNAL' });
    expect(JSON.stringify(traces[0])).not.toContain('PROVIDER_SECRET_CANARY');
  });

  it('classifies both consumer cancellation and signal abort as cancelled', async () => {
    const consumerTraces: RuntimeModelTrace[] = [];
    let consumerCancelled = false;
    const consumerModel = wrapRuntimeModelTrace(
      modelFor({
        calls: { stream: 0, generate: 0 },
        stream: new ReadableStream({
          cancel() {
            consumerCancelled = true;
          },
        }),
      }),
      traceOptions(consumerTraces),
    );
    const consumerResult = await consumerModel.doStream({ prompt: [] });
    const consumerReader = consumerResult.stream.getReader();
    await consumerReader.cancel('client-cancel');
    expect(consumerCancelled).toBe(true);
    expect(consumerTraces[0]).toMatchObject({ status: 'cancelled', resultCode: 'CANCELLED' });

    const signalTraces: RuntimeModelTrace[] = [];
    const signal = new AbortController();
    let pullStartedResolve: (() => void) | undefined;
    const pullStarted = new Promise<void>((resolve) => {
      pullStartedResolve = resolve;
    });
    let releasePull: (() => void) | undefined;
    const pullReleased = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    let pullCount = 0;
    const signalModel = wrapRuntimeModelTrace(
      modelFor({
        calls: { stream: 0, generate: 0 },
        stream: new ReadableStream({
          pull(controller) {
            if (pullCount++ === 0) {
              pullStartedResolve?.();
              return pullReleased;
            }
            controller.close();
            return undefined;
          },
          cancel() {},
        }),
      }),
      { ...traceOptions(signalTraces), clock: () => '2026-09-11T00:00:00.000Z' },
    );
    const signalResult = await signalModel.doStream({ prompt: [], abortSignal: signal.signal });
    const signalReader = signalResult.stream.getReader();
    const pendingRead = signalReader.read();
    await pullStarted;
    signal.abort();
    expect(signalTraces[0]).toMatchObject({ status: 'cancelled', resultCode: 'CANCELLED' });
    releasePull?.();
    await pendingRead;
    signalReader.releaseLock();
  });

  it('counts generate calls and actual retry invocations separately', async () => {
    const traces: RuntimeModelTrace[] = [];
    const script: ModelScript = { calls: { stream: 0, generate: 0 } };
    const model = wrapRuntimeModelTrace(modelFor(script), traceOptions(traces));
    await model.doGenerate({ prompt: [] });
    await model.doGenerate({ prompt: [] });

    expect(script.calls.generate).toBe(2);
    expect(traces).toHaveLength(2);
    expect(new Set(traces.map((trace) => trace.callId)).size).toBe(2);
    expect(traces.every((trace) => trace.status === 'ok' && trace.tokenCount === 5)).toBe(true);
  });

  it('omits a non-monotonic duration instead of fabricating a measurement', async () => {
    const traces: RuntimeModelTrace[] = [];
    let clockCalls = 0;
    const model = wrapRuntimeModelTrace(
      modelFor({ calls: { stream: 0, generate: 0 } }),
      traceOptions(traces, () => (clockCalls++ === 0 ? 100 : 99)),
    );
    await model.doGenerate({ prompt: [] });

    expect(traces[0]).not.toHaveProperty('durationMs');
  });

  it('schedules the digest and write pipeline before its first await', async () => {
    const scheduled: Promise<void>[] = [];
    const written: RuntimeModelTrace[] = [];
    const sink = createBestEffortRuntimeModelTraceSink(
      {
        write() {
          written.push(trace);
          return Promise.resolve();
        },
      },
      (promise) => scheduled.push(promise),
    );
    const trace: RuntimeModelTrace = {
      ownerScopeRef: 'owner-m26-sink',
      threadId: 'thread-m26-sink',
      turnId: 'turn-m26-sink',
      revision: 1,
      callId: 'call-m26-sink',
      occurredAt: '2026-09-11T00:00:00.000Z',
      status: 'ok',
      resultCode: 'OK',
    };

    const returned = sink(trace);
    expect(scheduled).toHaveLength(1);
    expect(returned).toBe(scheduled[0]);
    await scheduled[0];
    expect(written).toEqual([trace]);
  });
});
