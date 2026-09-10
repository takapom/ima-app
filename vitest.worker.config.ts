import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './workers/api/wrangler.jsonc',
      },
      miniflare: {
        bindings: {
          APP_TOKEN: 'test-app-token',
          JOURNEY_DATASET_ADMIN_TOKEN: 'm14-admin-fixture-token',
        },
      },
    }),
  ],
  test: {
    name: 'worker',
    setupFiles: ['./workers/api/tests/runtime-setup.ts'],
    include: ['tests/worker.test.ts', 'workers/api/tests/http/integration/*.test.ts'],
  },
});
