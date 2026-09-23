import { workspaceAliases } from './vitest.aliases.ts';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const liveRequested = ['1', 'true'].includes(process.env.MODEL_EVAL_LIVE ?? '');

export default defineConfig({
  resolve: { alias: workspaceAliases },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './worker/wrangler.model-eval-live-test.jsonc' },
      miniflare: {
        bindings: {
          IMA_ENV: liveRequested ? 'production' : 'dev',
          MODEL_EVAL_LIVE: liveRequested ? '1' : '0',
          OPENAI_API_KEY: liveRequested ? (process.env.OPENAI_API_KEY ?? '') : '',
          IMA_RUNTIME_MODE: liveRequested ? 'live' : 'fixture',
          IMA_PROVIDER_OPENAI: 'true',
          IMA_PROVIDER_PLACES: 'false',
          IMA_PROVIDER_HOTPEPPER: 'true',
          IMA_KILL_SWITCH: 'false',
        },
      },
    }),
  ],
  test: {
    name: 'model-eval-live',
    setupFiles: ['./worker/tests/runtime-setup.ts'],
    include: ['worker/tests/model-eval-live/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
