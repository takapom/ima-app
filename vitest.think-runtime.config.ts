import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({ wrangler: { configPath: './workers/api/wrangler.think-runtime-test.jsonc' } }),
  ],
  test: {
    name: 'think-runtime',
    setupFiles: ['./workers/api/tests/runtime-setup.ts'],
    include: [
      'workers/api/tests/think-runtime/**/*.test.ts',
      'tests/think-runtime-http-mobile.test.ts',
    ],
    exclude: ['workers/api/tests/think-runtime/think-runtime-replay.test.ts'],
  },
});
