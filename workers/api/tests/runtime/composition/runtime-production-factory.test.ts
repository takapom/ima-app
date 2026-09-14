import { describe, expect, it } from 'vitest';
import { createRuntimeProductionConnectionOptions } from '../../../src/runtime/composition/runtime-production-factory';
import { createDevFixtureModel } from '../../../src/runtime/composition/runtime-dev-fixture';
import { readOnlyCommit, NOW } from './runtime-production-factory-fixtures';

const live = {
  IMA_ENV: 'dev',
  IMA_RUNTIME_MODE: 'live',
  IMA_PROVIDER_OPENAI: 'true',
  IMA_PROVIDER_HOTPEPPER: 'true',
  OPENAI_API_KEY: 'openai-test',
  HOTPEPPER_API_KEY: 'hp-test',
  PLACES_CURSOR_SECRET: 'cursor-test-secret-value',
  IMA_KILL_SWITCH: 'false',
};
const factory = (env: unknown) =>
  createRuntimeProductionConnectionOptions({
    env,
    commit: readOnlyCommit,
    overrides: { clock: () => NOW },
  });

describe('production factory admission', () => {
  it('requires only OpenAI, Hot Pepper, and cursor secrets for the live graph', () => {
    expect(factory(live)).toBeDefined();
    for (const key of ['OPENAI_API_KEY', 'HOTPEPPER_API_KEY', 'PLACES_CURSOR_SECRET']) {
      expect(factory({ ...live, [key]: '' }), key).toBeUndefined();
    }
  });
  it('honors the kill switch, disabled mode, and model gate', () => {
    expect(factory({ ...live, IMA_KILL_SWITCH: 'true' })).toBeUndefined();
    expect(factory({ ...live, IMA_RUNTIME_MODE: 'disabled' })).toBeUndefined();
    expect(factory({ ...live, IMA_PROVIDER_OPENAI: 'false' })).toBeUndefined();
  });
  it('does not open real transports in fixture mode without an injected fetcher', () => {
    expect(
      createRuntimeProductionConnectionOptions({
        env: { ...live, IMA_RUNTIME_MODE: 'fixture' },
        commit: readOnlyCommit,
        overrides: { modelForTurn: createDevFixtureModel(), clock: () => NOW },
      }),
    ).toBeUndefined();
  });
});
