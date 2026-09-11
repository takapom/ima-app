import { wrapLanguageModel } from 'ai';
import * as v from 'valibot';
import { EvidenceTextSchema, ModelActionMetadataSchema, ModelDecisionSchema } from '@ima/core';
import {
  DENIED_MARKER,
  PUBLIC_TOOLS,
  TURN_CONSTRAINTS,
  type RuntimeGateModel,
  type RuntimeGateModelCallOptions,
  type RuntimeGateModelStreamPart,
} from '../support/runtime-model-fixture';

export type RuntimeGateStepAcceptance = {
  toolNames: string[];
  finishReason: string | null;
  turnConstraints: typeof TURN_CONSTRAINTS;
  emptyFinal?: boolean;
  finalMessage?: {
    text: string;
    evidenceIds: string[];
    basis: 'grounded' | 'inference' | 'conversational';
  };
  bytes: number;
};

export type RuntimeGateStepReport = {
  bufferedSteps: number;
  acceptedSteps: RuntimeGateStepAcceptance[];
  rejectedSteps: string[];
  providerOptionsSeen: RuntimeGateModelCallOptions['providerOptions'][];
};

const stepErrors = new WeakSet<object>();

export class RuntimeGateStepError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`M04_STEP_DENY_${code}`);
    this.name = 'RuntimeGateStepError';
    this.code = `M04_STEP_DENY_${code}`;
    stepErrors.add(this);
  }
}

export function isRuntimeGateStepError(value: unknown): value is RuntimeGateStepError {
  return typeof value === 'object' && value !== null && stepErrors.has(value);
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stepError(code: string): RuntimeGateStepError {
  return new RuntimeGateStepError(code);
}

function providerM04(options: RuntimeGateModelCallOptions): JsonRecord | null {
  const value = options.providerOptions?.m04;
  return isRecord(value) ? value : null;
}

function expectedConstraints(options: RuntimeGateModelCallOptions): typeof TURN_CONSTRAINTS {
  const m04 = providerM04(options);
  const value = m04?.turnConstraints;
  if (!isRecord(value)) throw stepError('TURN_CONSTRAINTS_EXPECTED_MISSING');
  if (!sameValue(value, TURN_CONSTRAINTS)) {
    throw stepError('TURN_CONSTRAINTS_EXPECTED_CHANGED');
  }
  return TURN_CONSTRAINTS;
}

function requiresEnvelope(options: RuntimeGateModelCallOptions): boolean {
  return providerM04(options)?.requireEnvelope === true;
}

function textFrom(parts: RuntimeGateModelStreamPart[]): string {
  return parts
    .filter(
      (part): part is Extract<RuntimeGateModelStreamPart, { type: 'text-delta' }> =>
        part.type === 'text-delta',
    )
    .map((part) => part.delta)
    .join('');
}

function toolCalls(parts: RuntimeGateModelStreamPart[]) {
  return parts.filter(
    (part): part is Extract<RuntimeGateModelStreamPart, { type: 'tool-call' }> =>
      part.type === 'tool-call',
  );
}

function finishParts(parts: RuntimeGateModelStreamPart[]) {
  return parts.filter(
    (part): part is Extract<RuntimeGateModelStreamPart, { type: 'finish' }> =>
      part.type === 'finish',
  );
}

function parseJson(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    throw stepError('INVALID_TOOL_ENVELOPE');
  }
}

function metadataConstraints(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.metadata)) return undefined;
  return value.metadata.turnConstraints;
}

const finalEnvelopeSchema = v.strictObject({
  kind: v.literal('final_message'),
  message: EvidenceTextSchema(300),
  metadata: ModelActionMetadataSchema,
});

type ParsedFinal = {
  message: NonNullable<RuntimeGateStepAcceptance['finalMessage']>;
  metadata: unknown;
};

function parseFinal(text: string): ParsedFinal | null {
  if (text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.kind !== 'final_message') return null;
  const final = v.safeParse(finalEnvelopeSchema, parsed);
  if (!final.success) throw stepError('INVALID_FINAL_ENVELOPE');
  const decision = v.safeParse(ModelDecisionSchema, {
    actions: [{ kind: 'final_message', message: final.output.message }],
    metadata: final.output.metadata,
  });
  if (!decision.success) throw stepError('INVALID_FINAL_ENVELOPE');
  return { message: final.output.message, metadata: final.output.metadata };
}

function inputOf(call: Extract<RuntimeGateModelStreamPart, { type: 'tool-call' }>): unknown {
  return typeof call.input === 'string' ? parseJson(call.input) : call.input;
}

export function validateRuntimeGateStep(
  parts: RuntimeGateModelStreamPart[],
  params: RuntimeGateModelCallOptions,
): Omit<RuntimeGateStepAcceptance, 'bytes'> {
  const expected = expectedConstraints(params);
  const finish = finishParts(parts);
  if (finish.length !== 1) throw stepError('FINISH_COUNT');
  const finishPart = finish[0];
  if (finishPart === undefined) throw stepError('FINISH_COUNT');

  const allowedTypes = new Set([
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
  if (parts.some((part) => !allowedTypes.has(part.type))) {
    throw stepError('UNSUPPORTED_PART');
  }

  const calls = toolCalls(parts);
  const text = textFrom(parts);
  const finalEnvelope = parseFinal(text);
  const envelopeRequired = requiresEnvelope(params);

  if (finalEnvelope !== null && calls.length > 0) {
    throw stepError('FINAL_WITH_TOOL');
  }

  const inputs = calls.map(inputOf);
  const constraints = inputs.map(metadataConstraints);
  if (finalEnvelope !== null) constraints.push(metadataConstraints(finalEnvelope));
  const expectedConstraintsByEntry: unknown[] = inputs.map(() => expected);
  if (finalEnvelope !== null) expectedConstraintsByEntry.push(expected);

  if (calls.length === 0 && text.length === 0) {
    if (finishPart.finishReason.unified === 'stop') {
      return {
        toolNames: [],
        finishReason: 'stop',
        turnConstraints: expected,
        emptyFinal: true,
      };
    }
    throw stepError('TOOL_FINISH_WITHOUT_TOOL');
  }
  if (finalEnvelope === null && text.length > 0 && calls.length === 0 && envelopeRequired) {
    throw stepError('INVALID_FINAL_ENVELOPE');
  }
  if (envelopeRequired && constraints.some((entry) => entry === undefined)) {
    throw stepError('TURN_CONSTRAINTS_MISSING');
  }
  if (
    constraints.some(
      (entry, index) => entry !== undefined && !sameValue(entry, expectedConstraintsByEntry[index]),
    )
  ) {
    throw stepError('TURN_CONSTRAINTS_CHANGED');
  }

  const names = calls.map((part) => part.toolName);
  if (names.some((name) => !PUBLIC_TOOLS.some((toolName) => toolName === name))) {
    throw stepError('UNKNOWN_TOOL');
  }
  const reads = names.filter((name) => name === 'search_places' || name === 'get_place_details');
  const submits = names.filter((name) => name === 'submit_cards');
  if (reads.length > 0 && submits.length > 0) throw stepError('MIXED_READ_SUBMIT');
  if (submits.length > 1) throw stepError('MULTIPLE_SUBMIT');
  if (finishPart.finishReason.unified === 'stop' && calls.length > 0) {
    throw stepError('FINAL_WITH_TOOL');
  }
  if (finishPart.finishReason.unified === 'tool-calls' && calls.length === 0) {
    throw stepError('TOOL_FINISH_WITHOUT_TOOL');
  }
  if (finalEnvelope !== null && finalEnvelope.message.text === DENIED_MARKER) {
    throw stepError('FINAL_CONTENT_DENIED');
  }
  return {
    toolNames: names,
    finishReason: finishPart.finishReason.unified,
    turnConstraints: expected,
    ...(finalEnvelope === null ? {} : { finalMessage: finalEnvelope.message }),
  };
}

function streamOf(parts: RuntimeGateModelStreamPart[]): ReadableStream<RuntimeGateModelStreamPart> {
  return new ReadableStream({
    start(controller) {
      parts.forEach((part) => controller.enqueue(part));
      controller.close();
    },
  });
}

async function readAll(
  stream: ReadableStream<RuntimeGateModelStreamPart>,
  signal: AbortSignal | undefined,
  maxMs: number,
): Promise<{ parts: RuntimeGateModelStreamPart[]; bytes: number }> {
  const reader = stream.getReader();
  const parts: RuntimeGateModelStreamPart[] = [];
  let bytes = 0;
  let stopCode: 'ABORTED' | 'TIMEOUT' | null = null;
  const cancel = () => {
    reader.cancel().catch(() => undefined);
  };
  const onAbort = () => {
    stopCode = 'ABORTED';
    cancel();
  };
  const timer = setTimeout(() => {
    stopCode = 'TIMEOUT';
    cancel();
  }, maxMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw stepError('ABORTED');
      const result = await reader.read();
      if (stopCode !== null) throw stepError(stopCode);
      if (result.done) break;
      parts.push(result.value);
      bytes += new TextEncoder().encode(JSON.stringify(result.value)).byteLength;
      if (parts.length > 128 || bytes > 64 * 1024) throw stepError('STEP_LIMIT');
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (isRuntimeGateStepError(error)) throw error;
    throw stepError(stopCode ?? 'STREAM_READ');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  return { parts, bytes };
}

export function wrapRuntimeGateStepBuffer(
  model: RuntimeGateModel,
  report: RuntimeGateStepReport,
  options: { maxMs?: number } = {},
): RuntimeGateModel {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v3',
      wrapStream: async ({ doStream, params }) => {
        report.bufferedSteps += 1;
        report.providerOptionsSeen.push(params.providerOptions);
        try {
          const result = await doStream();
          const buffered = await readAll(result.stream, params.abortSignal, options.maxMs ?? 2_000);
          const accepted = validateRuntimeGateStep(buffered.parts, params);
          report.acceptedSteps.push({ ...accepted, bytes: buffered.bytes });
          return { ...result, stream: streamOf(buffered.parts) };
        } catch (error) {
          const code = isRuntimeGateStepError(error) ? error.code : 'STREAM_READ';
          report.rejectedSteps.push(code);
          throw isRuntimeGateStepError(error) ? error : stepError('STREAM_READ');
        }
      },
    },
  });
}

export { DENIED_MARKER, PUBLIC_TOOLS, TURN_CONSTRAINTS };
