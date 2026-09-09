import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({ wrangler: { configPath: './workers/api/wrangler.think-test.jsonc' } }),
  ],
  test: {
    name: 'think-gate',
    setupFiles: ['./workers/api/tests/runtime-setup.ts'],
    include: ['workers/api/tests/think-gate/**/*.test.ts'],
  },
});
