import type { JourneyServiceDateContext } from '@worker/domain/travel/journey';
import { describe, expect, it, vi } from 'vitest';
import { JOURNEY_DATASET_DO_NAME } from '@worker/adapters/out/persistence/last-train/dataset-identity';
import { createRuntimeJourneyDatasetBinding } from '@worker/adapters/out/persistence/last-train/dataset-binding';
import type { JourneyReadResult } from '@worker/adapters/out/persistence/last-train/reader';
import type { JourneyDatasetRuntimeNamespace } from '@worker/adapters/out/persistence/last-train/dataset-binding';

const context = {} as JourneyServiceDateContext;
const unavailable: JourneyReadResult = {
  status: 'error',
  code: 'STORAGE_UNAVAILABLE',
  revision: null,
  message: 'journey dataset storage is unavailable',
};

const namespaceFor = (stub: {
  readonly read: (value: JourneyServiceDateContext) => Promise<JourneyReadResult>;
  readonly readRevision: () => Promise<unknown>;
}) => {
  const getByName = vi.fn((_name: string) => stub);
  return {
    namespace: { getByName } as unknown as JourneyDatasetRuntimeNamespace,
    getByName,
  };
};

describe('runtime JourneyDataset binding', () => {
  it('lazily uses the shared named DO and forwards validated reads', async () => {
    const read = vi.fn((value: JourneyServiceDateContext) => {
      expect(value).toBe(context);
      return Promise.resolve(unavailable);
    });
    const { namespace, getByName } = namespaceFor({
      read,
      readRevision: () => Promise.resolve(3),
    });
    const binding = createRuntimeJourneyDatasetBinding(namespace);
    if (binding === undefined) throw new Error('runtime dataset binding missing');

    expect(getByName).not.toHaveBeenCalled();
    await expect(binding.read(context)).resolves.toEqual(unavailable);
    await expect(binding.readRevision()).resolves.toBe(3);
    expect(getByName).toHaveBeenNthCalledWith(1, JOURNEY_DATASET_DO_NAME);
    expect(getByName).toHaveBeenNthCalledWith(2, JOURNEY_DATASET_DO_NAME);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('fails closed for empty, malformed, or rejected revision probes', async () => {
    for (const value of [null, 0, -1, 1.5, 'revision']) {
      const { namespace } = namespaceFor({
        read: () => Promise.resolve(unavailable),
        readRevision: () => Promise.resolve(value),
      });
      const binding = createRuntimeJourneyDatasetBinding(namespace);
      if (binding === undefined) throw new Error('runtime dataset binding missing');
      await expect(binding.readRevision()).resolves.toBeNull();
    }

    const { namespace } = namespaceFor({
      read: () => Promise.resolve(unavailable),
      readRevision: () => Promise.reject(new Error('dataset RPC unavailable')),
    });
    const binding = createRuntimeJourneyDatasetBinding(namespace);
    if (binding === undefined) throw new Error('runtime dataset binding missing');
    await expect(binding.readRevision()).resolves.toBeNull();
  });

  it('returns null at the revision deadline and observes a late rejection safely', async () => {
    let rejectRevision: ((reason: unknown) => void) | undefined;
    const pending = new Promise<unknown>((_resolve, reject) => {
      rejectRevision = reject;
    });
    const { namespace } = namespaceFor({
      read: () => Promise.resolve(unavailable),
      readRevision: () => pending,
    });
    const binding = createRuntimeJourneyDatasetBinding(namespace, { revisionTimeoutMs: 5 });
    if (binding === undefined) throw new Error('runtime dataset binding missing');

    await expect(binding.readRevision()).resolves.toBeNull();
    rejectRevision?.(new Error('late dataset RPC failure'));
    await Promise.resolve();
  });

  it('does not create an adapter or touch the namespace when the binding is absent', () => {
    expect(createRuntimeJourneyDatasetBinding(undefined)).toBeUndefined();
  });
});
