import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './workers/api/wrangler.runtime-test.jsonc' },
    }),
  ],
  test: {
    name: 'runtime-gate',
    setupFiles: ['./workers/api/tests/runtime-setup.ts'],
    include: ['workers/api/tests/runtime-gate/**/*.test.ts'],
    exclude: [
      'workers/api/tests/runtime-gate/runtime-gate-contract.test.ts',
      'workers/api/tests/runtime-gate/runtime-gate-core.test.ts',
      'workers/api/tests/runtime-gate/runtime-gate-sse.test.ts',
      'workers/api/tests/runtime-gate/retention/retention.test.ts',
      'workers/api/tests/runtime-gate/retention/retention-audit.test.ts',
      'workers/api/tests/runtime-gate/http/runtime-gate-http.test.ts',
      'workers/api/tests/runtime-gate/retention/retention-runtime-policy.test.ts',
      'workers/api/tests/runtime-gate/runtime-gate-retention.test.ts',
    ],
  },
});
