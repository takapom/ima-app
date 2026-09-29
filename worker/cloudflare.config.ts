import { bindings, defineConfig, exports } from 'cf/config';

type Vars = {
  readonly IMA_ENV: 'dev' | 'staging' | 'production';
  readonly IMA_PERSONAL_PREVIEW: 'true' | 'false';
  readonly IMA_RUNTIME_MODE: 'fixture' | 'disabled' | 'live';
  readonly IMA_PROVIDER_OPENAI: 'true' | 'false';
  readonly IMA_PROVIDER_HOTPEPPER: 'true' | 'false';
  readonly IMA_RUNTIME_FLAGS_CONNECTED: '0' | '1';
};

type Target = {
  readonly name: string;
  readonly vars: Vars;
};

const providersOff = {
  IMA_PERSONAL_PREVIEW: 'false',
  IMA_PROVIDER_OPENAI: 'false',
  IMA_PROVIDER_HOTPEPPER: 'false',
  IMA_RUNTIME_FLAGS_CONNECTED: '0',
} as const;

/** `personal-preview` replaces the former `--var` overrides for the owner's own device on staging. */
const targetFor = (mode: string | undefined): Target => {
  switch (mode) {
    case undefined:
      return {
        name: 'ima-api-dev',
        vars: { IMA_ENV: 'dev', IMA_RUNTIME_MODE: 'fixture', ...providersOff },
      };
    case 'staging':
      return {
        name: 'ima-api-staging',
        vars: { IMA_ENV: 'staging', IMA_RUNTIME_MODE: 'disabled', ...providersOff },
      };
    case 'personal-preview':
      return {
        name: 'ima-api-staging',
        vars: {
          IMA_ENV: 'staging',
          IMA_PERSONAL_PREVIEW: 'true',
          IMA_RUNTIME_MODE: 'live',
          IMA_PROVIDER_OPENAI: 'true',
          IMA_PROVIDER_HOTPEPPER: 'true',
          IMA_RUNTIME_FLAGS_CONNECTED: '1',
        },
      };
    case 'production':
      return {
        name: 'ima-api-production',
        vars: { IMA_ENV: 'production', IMA_RUNTIME_MODE: 'disabled', ...providersOff },
      };
    default:
      throw new Error(`Unsupported cf mode: ${mode}`);
  }
};

export default defineConfig(({ mode }) => {
  const { name, vars } = targetFor(mode);
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
        IMA_ENV: bindings.text(vars.IMA_ENV),
        IMA_PERSONAL_PREVIEW: bindings.text(vars.IMA_PERSONAL_PREVIEW),
        IMA_RUNTIME_MODE: bindings.text(vars.IMA_RUNTIME_MODE),
        IMA_PROVIDER_OPENAI: bindings.text(vars.IMA_PROVIDER_OPENAI),
        IMA_PROVIDER_PLACES: bindings.text('false'),
        IMA_PROVIDER_HOTPEPPER: bindings.text(vars.IMA_PROVIDER_HOTPEPPER),
        IMA_KILL_SWITCH: bindings.text('false'),
        IMA_RUNTIME_FLAGS_CONNECTED: bindings.text(vars.IMA_RUNTIME_FLAGS_CONNECTED),
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
