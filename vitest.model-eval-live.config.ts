import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const liveRequested = ['1', 'true'].includes(process.env.MODEL_EVAL_LIVE ?? '');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './workers/api/wrangler.model-eval-live-test.jsonc' },
      miniflare: {
        bindings: {
          MODEL_EVAL_LIVE: liveRequested ? '1' : '0',
          OPENAI_API_KEY: liveRequested ? (process.env.OPENAI_API_KEY ?? '') : '',
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
