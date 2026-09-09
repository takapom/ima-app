import * as v from 'valibot';
import { HarnessContextSchema } from '../ports/context';
import { ModelRequestSchema } from '../ports/model';
import type { ModelRequest } from '../ports/model';
import { Text } from '../domain/primitives';

export const TurnInputSchema = v.strictObject({
  userText: Text(500),
  context: HarnessContextSchema,
});
export type TurnInput = v.InferOutput<typeof TurnInputSchema>;

/** Project injected Harness data into the model-safe context boundary. */
export const projectModelRequest = (input: TurnInput): ModelRequest => {
  const request = {
    userText: input.userText,
    context: {
      threadId: input.context.threadId,
      turnId: input.context.turnId,
      revision: input.context.revision,
      serverNow: input.context.serverNow,
      location: {
        status: input.context.location.status,
        areaDescription: input.context.preferences.areaText,
        accuracyMeters: input.context.location.accuracyMeters,
        capturedAt: input.context.location.capturedAt,
        precise: input.context.location.precise,
      },
      preferences: input.context.preferences,
      capabilities: input.context.capabilities,
    },
  };
  const parsed = v.safeParse(ModelRequestSchema, request);
  if (!parsed.success) {
    throw new Error('internal model context projection failed');
  }
  return parsed.output;
};
