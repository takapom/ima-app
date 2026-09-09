import type { StreamTextTransform, TextStreamPart, ToolSet } from 'ai';
import { DENIED_MARKER } from './think-gate-provider';

export type ThinkGateStreamTransformReport = {
  inputParts: number;
  markerParts: number;
  markerPartsAfterTransform: number;
  redactedParts: number;
  redactedTextParts: number;
  redactedToolResultParts: number;
};

type ThinkGateTextPart = TextStreamPart<ToolSet>;

export type ThinkGateToolResultObserver = (
  toolCallId: string,
  toolName: string,
  output: unknown,
) => void;

function redactString(value: string): string {
  return value.replaceAll(DENIED_MARKER, '[redacted]');
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, redactValue(child)]),
    );
  }
  return value;
}

function rewritePart(
  part: ThinkGateTextPart,
  report: ThinkGateStreamTransformReport,
  onToolResult: ThinkGateToolResultObserver | undefined,
): ThinkGateTextPart {
  report.inputParts += 1;
  const markerBefore = JSON.stringify(part).includes(DENIED_MARKER);
  if (markerBefore) report.markerParts += 1;

  let rewritten = part;
  if (part.type === 'text-delta') {
    const text = redactString(part.text);
    if (text !== part.text) report.redactedTextParts += 1;
    rewritten = { ...part, text };
  } else if (part.type === 'reasoning-delta') {
    rewritten = { ...part, text: redactString(part.text) };
  } else if (part.type === 'tool-result') {
    onToolResult?.(part.toolCallId, part.toolName, part.output);
    rewritten = { ...part, output: redactValue(part.output) };
    if (markerBefore) report.redactedToolResultParts += 1;
  } else if (part.type === 'tool-error') {
    rewritten = { ...part, error: redactValue(part.error) };
    if (markerBefore) report.redactedToolResultParts += 1;
  }

  const markerAfter = JSON.stringify(rewritten).includes(DENIED_MARKER);
  if (markerAfter) report.markerPartsAfterTransform += 1;
  if (markerBefore && !markerAfter) report.redactedParts += 1;
  return rewritten;
}

/** Public Think TurnConfig transform; it runs before UI stream persistence. */
export function createThinkGateStreamTransform(
  report: ThinkGateStreamTransformReport,
  onToolResult?: ThinkGateToolResultObserver,
): StreamTextTransform<ToolSet> {
  return () =>
    new TransformStream<ThinkGateTextPart, ThinkGateTextPart>({
      transform(part, controller) {
        controller.enqueue(rewritePart(part, report, onToolResult));
      },
    });
}
