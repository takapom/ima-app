import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './workers/api/wrangler.app-integrity-test.jsonc',
      },
      miniflare: {
        bindings: { APP_TOKEN: 'test-app-token' },
      },
    }),
  ],
  test: {
    name: 'worker-app-integrity',
    setupFiles: ['./workers/api/tests/runtime-setup.ts'],
    include: ['workers/api/tests/app-integrity/app-integrity-self.test.ts'],
  },
});
