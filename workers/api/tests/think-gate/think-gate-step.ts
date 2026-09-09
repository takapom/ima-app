import { wrapLanguageModel } from 'ai';
import {
  THINK_GATE_TOOLS,
  type ThinkGateModel,
  type ThinkGateStreamPart,
} from './think-gate-provider';

export type ThinkGateStepReport = {
  bufferedSteps: number;
  acceptedSteps: number;
  rejectedCodes: string[];
  bufferedBytes: number[];
};

export class ThinkGateStepError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`M04_THINK_STEP_DENY_${code}`);
    this.name = 'ThinkGateStepError';
    this.code = `M04_THINK_STEP_DENY_${code}`;
  }
}

function stepError(code: string): ThinkGateStepError {
  return new ThinkGateStepError(code);
}

function streamOf(parts: ThinkGateStreamPart[]): ReadableStream<ThinkGateStreamPart> {
  return new ReadableStream({
    start(controller) {
      parts.forEach((part) => controller.enqueue(part));
      controller.close();
    },
  });
}

function toolCalls(parts: ThinkGateStreamPart[]) {
  return parts.filter(
    (part): part is Extract<ThinkGateStreamPart, { type: 'tool-call' }> =>
      part.type === 'tool-call',
  );
}

function validateStep(parts: ThinkGateStreamPart[]): void {
  const finishes = parts.filter(
    (part): part is Extract<ThinkGateStreamPart, { type: 'finish' }> => part.type === 'finish',
  );
  if (finishes.length !== 1) throw stepError('FINISH_COUNT');

  const allowedParts = new Set([
    'stream-start',
    'text-start',
    'text-delta',
    'text-end',
    'reasoning-start',
    'reasoning-delta',
    'reasoning-end',
    'tool-input-start',
    'tool-input-delta',
    'tool-input-end',
    'tool-call',
    'finish',
  ]);
  if (parts.some((part) => !allowedParts.has(part.type))) {
    throw stepError('UNSUPPORTED_PART');
  }

  const calls = toolCalls(parts);
  const names = calls.map((call) => call.toolName);
  if (names.some((name) => !(THINK_GATE_TOOLS as readonly string[]).includes(name))) {
    throw stepError('UNKNOWN_TOOL');
  }
  const hasRead = names.includes('search_places') || names.includes('get_place_details');
  const hasSubmit = names.includes('submit_cards');
  if (hasRead && hasSubmit) throw stepError('MIXED_READ_SUBMIT');
  const finish = finishes[0];
  if (finish?.finishReason.unified === 'tool-calls' && calls.length === 0) {
    throw stepError('TOOL_FINISH_WITHOUT_TOOL');
  }
}

async function readAll(
  stream: ReadableStream<ThinkGateStreamPart>,
  signal: AbortSignal | undefined,
  maxBytes: number,
): Promise<{ parts: ThinkGateStreamPart[]; bytes: number }> {
  const reader = stream.getReader();
  const parts: ThinkGateStreamPart[] = [];
  let bytes = 0;
  let failure: 'ABORTED' | 'TOO_LARGE' | 'TIMEOUT' | null = null;
  const abort = () => {
    failure = 'ABORTED';
    reader.cancel().catch(() => undefined);
  };
  const timer = setTimeout(() => {
    failure = 'TIMEOUT';
    reader.cancel().catch(() => undefined);
  }, 2_000);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      const next = await reader.read();
      if (failure !== null) throw stepError(failure);
      if (next.done) break;
      if (next.value === undefined) throw stepError('READ_FAILED');
      parts.push(next.value);
      bytes += new TextEncoder().encode(JSON.stringify(next.value)).byteLength;
      if (bytes > maxBytes) {
        failure = 'TOO_LARGE';
        throw stepError('TOO_LARGE');
      }
    }
    return { parts, bytes };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ThinkGateStepError) throw error;
    throw stepError(failure ?? 'READ_FAILED');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function recordRejection(report: ThinkGateStepReport, error: unknown): ThinkGateStepError {
  const safe = error instanceof ThinkGateStepError ? error : stepError('READ_FAILED');
  report.rejectedCodes.push(safe.code);
  return safe;
}

/**
 * Public AI SDK middleware. Think still owns the loop; the middleware only
 * delays the provider stream until this complete step has passed policy.
 */
export function wrapThinkGateStepBuffer(
  model: ThinkGateModel,
  report: ThinkGateStepReport,
): ThinkGateModel {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v3',
      wrapStream: async ({ doStream, params }) => {
        report.bufferedSteps += 1;
        try {
          const result = await doStream();
          const buffered = await readAll(result.stream, params.abortSignal, 64 * 1024);
          validateStep(buffered.parts);
          report.acceptedSteps += 1;
          report.bufferedBytes.push(buffered.bytes);
          return { ...result, stream: streamOf(buffered.parts) };
        } catch (error) {
          throw recordRejection(report, error);
        }
      },
    },
  });
}
