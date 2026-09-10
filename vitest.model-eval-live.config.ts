import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const liveRequested = ['1', 'true'].includes(process.env.MODEL_EVAL_LIVE ?? '');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './workers/api/wrangler.model-eval-live-test.jsonc' },
      miniflare: {
        bindings: {
          IMA_ENV: liveRequested ? 'production' : 'dev',
          MODEL_EVAL_LIVE: liveRequested ? '1' : '0',
          OPENAI_API_KEY: liveRequested ? (process.env.OPENAI_API_KEY ?? '') : '',
          IMA_RUNTIME_MODE: liveRequested ? 'live' : 'fixture',
          IMA_PROVIDER_OPENAI: 'true',
          IMA_PROVIDER_PLACES: 'true',
          IMA_PROVIDER_ROUTES: 'false',
          IMA_PROVIDER_LAST_TRAIN: 'false',
          IMA_PROVIDER_HOTPEPPER: 'false',
          IMA_KILL_SWITCH: 'false',
        },
      },
    }),
  ],
  test: {
    name: 'model-eval-live',
    setupFiles: ['./workers/api/tests/runtime-setup.ts'],
    include: ['workers/api/tests/model-eval-live/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
