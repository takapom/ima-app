import { JOURNEY_DATASET_DO_NAME } from '@worker/adapters/outbound/persistence/last-train/dataset-identity';
import type { JourneyDatasetDO } from '@worker/adapters/outbound/persistence/last-train/dataset-do';
import type { RuntimeJourneyDataset } from '@worker/adapters/outbound/providers/last-train/journey-adapter';

export type { RuntimeJourneyDataset } from '@worker/adapters/outbound/providers/last-train/journey-adapter';

export type JourneyDatasetRuntimeNamespace = Pick<
  DurableObjectNamespace<JourneyDatasetDO>,
  'getByName'
>;

export const DEFAULT_JOURNEY_DATASET_REVISION_TIMEOUT_MS = 1_000;

type RuntimeJourneyDatasetBindingOptions = {
  readonly revisionTimeoutMs?: number;
};

const timeoutFor = (value: number | undefined): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_JOURNEY_DATASET_REVISION_TIMEOUT_MS;

const revisionFor = (value: unknown): number | null => {
  if (value === null) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;
};

const readRevisionWithTimeout = async (
  read: () => Promise<unknown>,
  timeoutMs: number,
): Promise<number | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = Promise.resolve().then(read);
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return revisionFor(await Promise.race([operation, timeout]));
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * Lazily binds the single named dataset DO. Missing bindings deliberately produce no adapter;
 * this lets production Places continue while the M33 dataset and resolver remain disabled.
 */
export const createRuntimeJourneyDatasetBinding = (
  namespace: JourneyDatasetRuntimeNamespace | undefined,
  options: RuntimeJourneyDatasetBindingOptions = {},
): RuntimeJourneyDataset | undefined => {
  if (namespace === undefined) return undefined;
  const revisionTimeoutMs = timeoutFor(options.revisionTimeoutMs);
  const stub = () => namespace.getByName(JOURNEY_DATASET_DO_NAME);
  return {
    read: (context) => stub().read(context),
    readRevision: () => readRevisionWithTimeout(() => stub().readRevision(), revisionTimeoutMs),
  };
};
