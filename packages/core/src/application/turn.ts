import * as v from 'valibot';
import { HarnessContextSchema } from '../ports/context';
import { ModelRequestSchema } from '../ports/model';
import type { ModelRequest } from '../ports/model';
import { Text } from '../domain/primitives';
import { projectModelContext } from './model-context';

export const TurnInputSchema = v.strictObject({
  userText: Text(500),
  context: HarnessContextSchema,
});
export type TurnInput = v.InferOutput<typeof TurnInputSchema>;

/** Projects the legacy ModelRequest shape through the richer model context boundary. */
export const projectModelRequest = (input: TurnInput): ModelRequest => {
  const projected = projectModelContext({
    harness: input.context,
    userText: input.userText,
    history: [],
    cardSet: null,
    conditions: {
      maxWalkMinutes: input.context.preferences.maxWalkMinutes,
      homeStationRef: input.context.preferences.homeStationRef,
      minimumStayMinutes: input.context.preferences.minimumStayMinutes,
    },
    evidence: [],
  });
  const request = {
    userText: projected.userText,
    context: {
      threadId: projected.threadId,
      turnId: projected.turnId,
      revision: projected.revision,
      serverNow: projected.serverNow,
      location: {
        status: projected.location.status,
        areaDescription: projected.location.areaDescription,
        accuracyMeters: input.context.location.accuracyMeters,
        capturedAt: input.context.location.capturedAt,
        precise: input.context.location.precise,
      },
      preferences: projected.preferences,
      capabilities: projected.capabilities,
    },
  };
  const parsed = v.safeParse(ModelRequestSchema, request);
  if (!parsed.success) {
    throw new Error('internal model context projection failed');
  }
  return parsed.output;
};
