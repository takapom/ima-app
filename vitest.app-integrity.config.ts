import { workspaceAliases } from './vitest.aliases.ts';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: workspaceAliases },
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './worker/wrangler.app-integrity-test.jsonc',
      },
      miniflare: {
        bindings: { APP_TOKEN: 'test-app-token' },
      },
    }),
  ],
  test: {
    name: 'worker-app-integrity',
    setupFiles: ['./worker/tests/runtime-setup.ts'],
    include: ['worker/tests/app-integrity/app-integrity-self.test.ts'],
  },
});
