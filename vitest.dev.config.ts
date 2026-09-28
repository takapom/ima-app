import { workspaceAliases } from './vitest.aliases.ts';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig, defineProject } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['llm', 'llm-unconfigured'].map((mode) =>
      defineProject({
        resolve: { alias: workspaceAliases },
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './worker/wrangler.dev.jsonc' },
            miniflare: {
              bindings: {
                APP_TOKEN: 'dev-fixture-app-token',
                IMA_ENV: 'dev',
                IMA_RUNTIME_MODE: 'live',
                IMA_PROVIDER_OPENAI: 'true',
                IMA_PROVIDER_PLACES: 'false',
                IMA_PROVIDER_HOTPEPPER: 'true',
                IMA_KILL_SWITCH: 'false',
                OPENAI_API_KEY: mode === 'llm' ? 'dev-llm-test-key' : '',
                HOTPEPPER_API_KEY: 'dev-hotpepper-test-key',
                PLACES_CURSOR_SECRET: 'dev-hotpepper-cursor-secret',
                PHOTO_TOKEN_SECRET: '',
              },
            },
          }),
        ],
        test: {
          name: `runtime-dev-${mode}`,
          setupFiles: ['./worker/tests/runtime-setup.ts'],
          include: ['worker/tests/dev/*.test.ts'],
        },
      }),
    ),
  },
});
