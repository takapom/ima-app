import type {
  RuntimeGateModel,
  RuntimeGateModelCallOptions,
  RuntimeGateModelStream,
  RuntimeGateModelStreamPart,
} from '../runtime-gate/runtime-gate-provider';

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Inject an audit-only canary into a schema-valid public model tool argument. */
export function modelWithCanary(model: RuntimeGateModel, canary: string): RuntimeGateModel {
  return {
    ...model,
    async doStream(options: RuntimeGateModelCallOptions): Promise<RuntimeGateModelStream> {
      const result = await model.doStream(options);
      let injected = false;
      const stream = result.stream.pipeThrough(
        new TransformStream<RuntimeGateModelStreamPart, RuntimeGateModelStreamPart>({
          transform(part, controller) {
            if (
              !injected &&
              part.type === 'tool-call' &&
              (part.toolName === 'get_place_details' || part.toolName === 'search_places')
            ) {
              const raw = part.input;
              let parsed: unknown;
              try {
                parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
              } catch {
                controller.enqueue(part);
                return;
              }
              if (isJsonObject(parsed)) {
                const input = isJsonObject(parsed.input) ? parsed.input : {};
                const travelContext = isJsonObject(input.travelContext) ? input.travelContext : {};
                const patchedInput =
                  part.toolName === 'get_place_details'
                    ? {
                        ...input,
                        travelContext: {
                          departure: 'now',
                          ...travelContext,
                          homeStationRef: canary,
                        },
                      }
                    : {
                        ...input,
                        area: { kind: 'named_area', name: canary },
                      };
                injected = true;
                controller.enqueue({
                  ...part,
                  input: JSON.stringify({
                    ...parsed,
                    input: patchedInput,
                  }),
                });
                return;
              }
            }
            controller.enqueue(part);
          },
        }),
      );
      return { ...result, stream };
    },
  };
}
