import { describe, expect, it } from 'vitest';
import {
  resolveRuntimeOperationalGate,
  type RuntimeProviderCapability,
} from '@worker/composition/runtime-operational-gate';

const providerCapabilities: readonly RuntimeProviderCapability[] = [
  'openai',
  'places',
  'routes',
  'lastTrain',
  'hotpepper',
];

describe('runtime operational gate', () => {
  it('fails closed for missing and malformed configuration', () => {
    const missing = resolveRuntimeOperationalGate({});
    expect(missing.mode).toBe('disabled');
    expect(providerCapabilities.every((capability) => !missing.enabled(capability))).toBe(true);

    const malformed = resolveRuntimeOperationalGate({
      IMA_RUNTIME_MODE: 'production',
      IMA_PROVIDER_OPENAI: 'maybe',
      IMA_PROVIDER_PLACES: 'yes',
    });
    expect(malformed.mode).toBe('disabled');
    expect(providerCapabilities.every((capability) => !malformed.enabled(capability))).toBe(true);
  });

  it('keeps each provider decision independent in live mode', () => {
    const gate = resolveRuntimeOperationalGate({
      IMA_RUNTIME_MODE: 'live',
      IMA_PROVIDER_OPENAI: 'true',
      IMA_PROVIDER_PLACES: 'true',
      IMA_PROVIDER_ROUTES: 'false',
      IMA_PROVIDER_LAST_TRAIN: 'true',
      IMA_PROVIDER_HOTPEPPER: 'true',
    });
    expect(gate.mode).toBe('live');
    expect(gate.modeFor('openai')).toBe('live');
    expect(gate.modeFor('places')).toBe('live');
    expect(gate.modeFor('routes')).toBe('disabled');
    expect(gate.modeFor('lastTrain')).toBe('live');
    expect(gate.modeFor('hotpepper')).toBe('live');
  });

  it('turns every paid capability off without changing the configured mode', () => {
    const gate = resolveRuntimeOperationalGate({
      IMA_RUNTIME_MODE: 'live',
      IMA_PROVIDER_OPENAI: 'true',
      IMA_PROVIDER_PLACES: 'true',
      IMA_PROVIDER_ROUTES: 'true',
      IMA_PROVIDER_LAST_TRAIN: 'true',
      IMA_PROVIDER_HOTPEPPER: 'true',
      IMA_KILL_SWITCH: 'true',
    });
    expect(gate.mode).toBe('live');
    expect(providerCapabilities.every((capability) => !gate.enabled(capability))).toBe(true);
  });

  it('requires an explicit fixture mode instead of treating it as live', () => {
    const gate = resolveRuntimeOperationalGate({
      IMA_RUNTIME_MODE: 'fixture',
      IMA_PROVIDER_OPENAI: 'true',
      IMA_PROVIDER_PLACES: 'true',
    });
    expect(gate.modeFor('openai')).toBe('fixture');
    expect(gate.modeFor('places')).toBe('fixture');
    expect(gate.modeFor('routes')).toBe('disabled');
  });
});
