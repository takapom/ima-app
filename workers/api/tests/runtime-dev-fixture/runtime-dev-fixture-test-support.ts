import type { RuntimeModelGuardCallOptions } from '../../src/runtime/turn-execution/runtime-model-guard';
import { createDevFixtureModel } from '../../src/runtime/composition/runtime-dev-fixture';

export const toolCallInput = async (
  prompt: RuntimeModelGuardCallOptions['prompt'],
): Promise<Record<string, unknown>> => {
  const model = createDevFixtureModel();
  const result = await model.doStream({ prompt });
  const collected: unknown[] = [];
  await result.stream.pipeTo(
    new WritableStream({
      write(part) {
        collected.push(part);
      },
    }),
  );
  const call = collected.find(
    (part): part is { type: 'tool-call'; input: string } =>
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === 'tool-call',
  );
  if (call === undefined) throw new Error('fixture model did not emit a tool call');
  const parsed: unknown = JSON.parse(call.input);
  if (typeof parsed !== 'object' || parsed === null || !('input' in parsed)) {
    throw new Error('fixture tool call envelope was invalid');
  }
  return (parsed as { input: Record<string, unknown> }).input;
};
