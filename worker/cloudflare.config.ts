import { bindings, defineConfig, exports } from 'cf/config';

type Target = {
  readonly name: string;
  readonly imaEnv: 'dev' | 'staging' | 'production';
  readonly runtimeMode: 'fixture' | 'disabled';
};

const targetFor = (mode: string | undefined): Target => {
  switch (mode) {
    case undefined:
      return { name: 'ima-api-dev', imaEnv: 'dev', runtimeMode: 'fixture' };
    case 'staging':
      return { name: 'ima-api-staging', imaEnv: 'staging', runtimeMode: 'disabled' };
    case 'production':
      return { name: 'ima-api-production', imaEnv: 'production', runtimeMode: 'disabled' };
    default:
      throw new Error(`Unsupported cf mode: ${mode}`);
  }
};

export default defineConfig(({ mode }) => {
  const { name, imaEnv, runtimeMode } = targetFor(mode);
  const durableObject = (exportName: string) =>
    bindings.durableObject({ worker: name, exportName });
  return {
    worker: {
      name,
      compatibilityDate: '2026-08-22',
      compatibilityFlags: ['nodejs_compat'],
      entrypoint: 'src/entrypoints/cloudflare/worker.ts',
      workersDev: true,
      observability: { enabled: true, headSamplingRate: 1 },
      env: {
        IMA_ENV: bindings.text(imaEnv),
        IMA_PERSONAL_PREVIEW: bindings.text('false'),
        IMA_RUNTIME_MODE: bindings.text(runtimeMode),
        IMA_PROVIDER_OPENAI: bindings.text('false'),
        IMA_PROVIDER_PLACES: bindings.text('false'),
        IMA_PROVIDER_HOTPEPPER: bindings.text('false'),
        IMA_KILL_SWITCH: bindings.text('false'),
        IMA_RUNTIME_FLAGS_CONNECTED: bindings.text('0'),
        THREADS: durableObject('ThreadDO'),
        CONVERSATIONS: durableObject('ConversationHistoryDO'),
        RATE_LIMITS: durableObject('RateLimitDO'),
        TELEMETRY: durableObject('TelemetryDO'),
        APP_INTEGRITY: durableObject('AppIntegrityDO'),
        SAVED_REFERENCES: durableObject('SavedReferenceDO'),
      },
      exports: {
        ThreadDO: exports.durableObject({ storage: 'sqlite' }),
        ConversationHistoryDO: exports.durableObject({ storage: 'sqlite' }),
        RateLimitDO: exports.durableObject({ storage: 'sqlite' }),
        TelemetryDO: exports.durableObject({ storage: 'sqlite' }),
        AppIntegrityDO: exports.durableObject({ storage: 'sqlite' }),
        SavedReferenceDO: exports.durableObject({ storage: 'sqlite' }),
      },
    },
  };
});
