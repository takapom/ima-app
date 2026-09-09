import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './workers/api/wrangler.jsonc',
      },
    }),
  ],
  test: {
    name: 'worker',
    include: ['tests/worker.test.ts'],
  },
});
