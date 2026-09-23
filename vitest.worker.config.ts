import { workspaceAliases } from './vitest.aliases.ts';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: workspaceAliases },
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './worker/wrangler.jsonc',
      },
      miniflare: {
        bindings: {
          APP_TOKEN: 'test-app-token',
        },
      },
    }),
  ],
  test: {
    name: 'worker',
    setupFiles: ['./worker/tests/runtime-setup.ts'],
    include: ['tests/worker.test.ts', 'worker/tests/adapters/inbound/http/integration/*.test.ts'],
  },
});
