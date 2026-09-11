import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './workers/api/wrangler.runtime-production-http-test.jsonc' },
      miniflare: {
        bindings: {
          APP_TOKEN: 'test-app-token',
          OPENAI_API_KEY: 'test-openai-key',
          GOOGLE_PLACES_API_KEY: 'test-google-key',
          PLACES_CURSOR_SECRET: 'test-places-cursor-secret',
          IMA_RUNTIME_MODE: 'fixture',
          IMA_PROVIDER_OPENAI: 'true',
          IMA_PROVIDER_PLACES: 'true',
          IMA_PROVIDER_ROUTES: 'true',
          IMA_PROVIDER_LAST_TRAIN: 'true',
          IMA_PROVIDER_HOTPEPPER: 'false',
          IMA_KILL_SWITCH: 'false',
        },
      },
    }),
  ],
  test: {
    name: 'runtime-production-http',
    setupFiles: ['./workers/api/tests/runtime-setup.ts'],
    include: [
      'workers/api/tests/runtime-production-http.test.ts',
      'workers/api/tests/runtime-production-saved-reference-http.test.ts',
      'workers/api/tests/runtime-production-saved-reference-refresh.test.ts',
      'workers/api/tests/runtime-production-saved-reference-refresh-timeout.test.ts',
    ],
  },
});
