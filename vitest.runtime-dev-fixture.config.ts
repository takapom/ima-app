import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './workers/api/wrangler.runtime-dev-fixture-test.jsonc' },
    }),
  ],
  test: {
    name: 'runtime-dev-fixture',
    setupFiles: ['./workers/api/tests/runtime-setup.ts'],
    include: ['workers/api/tests/runtime-dev-fixture/**/*.test.ts'],
  },
});
