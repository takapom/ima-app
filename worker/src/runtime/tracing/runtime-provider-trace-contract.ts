import type { TelemetryProvider } from '@worker/telemetry/schema';

export type RuntimeProviderTransportProvider = Extract<
  TelemetryProvider,
  'places' | 'routes' | 'hotpepper' | 'photo'
>;

export type RuntimeProviderTransportCompletion =
  | { readonly status: 'ok' }
  | {
      readonly status: 'error';
      readonly error: unknown;
      readonly signal?: AbortSignal;
    };

/**
 * Transport-owned boundary for provider telemetry. The error is classified by the observer and
 * is never retained or exposed as a trace field.
 */
export type RuntimeProviderTransportCall = {
  readonly complete: (completion: RuntimeProviderTransportCompletion) => void;
};

export type RuntimeProviderTransportObserver = {
  readonly begin: (input: {
    readonly provider: RuntimeProviderTransportProvider;
    readonly apiElementCount?: number;
  }) => RuntimeProviderTransportCall;
};

/** Observer hooks are diagnostics only and can never change a provider operation. */
export const beginRuntimeProviderTransportCall = (
  observer: RuntimeProviderTransportObserver | undefined,
  input: Parameters<RuntimeProviderTransportObserver['begin']>[0],
): RuntimeProviderTransportCall | undefined => {
  try {
    return observer?.begin(input);
  } catch {
    return undefined;
  }
};

/** Swallows observer failures while retaining the original transport result/error. */
export const completeRuntimeProviderTransportCall = (
  call: RuntimeProviderTransportCall | undefined,
  completion: RuntimeProviderTransportCompletion,
): void => {
  try {
    call?.complete(completion);
  } catch {
    // Diagnostics must not replace the provider result or exception.
  }
};
