import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './workers/api/wrangler.runtime-native-test.jsonc' },
      miniflare: {
        bindings: {
          APP_TOKEN: 'test-app-token',
          OPENAI_API_KEY: 'test-openai-key',
          HOTPEPPER_API_KEY: 'test-google-key',
          PLACES_CURSOR_SECRET: 'test-places-cursor-secret',
          IMA_RUNTIME_MODE: 'fixture',
          IMA_PROVIDER_OPENAI: 'true',
          IMA_PROVIDER_PLACES: 'false',
          IMA_PROVIDER_ROUTES: 'true',
          IMA_PROVIDER_LAST_TRAIN: 'true',
          IMA_PROVIDER_HOTPEPPER: 'true',
          IMA_KILL_SWITCH: 'false',
        },
      },
    }),
  ],
  test: {
    name: 'runtime-native',
    setupFiles: ['./workers/api/tests/runtime-setup.ts'],
    include: ['workers/api/tests/runtime-native/**/*.test.ts'],
  },
});
