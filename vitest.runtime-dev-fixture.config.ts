import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig, defineProject } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['fixture', 'llm', 'llm-unconfigured'].map((mode) =>
      defineProject({
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './workers/api/wrangler.runtime-dev-fixture-test.jsonc' },
            miniflare: {
              bindings: {
                APP_TOKEN: 'dev-fixture-app-token',
                IMA_ENV: 'dev',
                IMA_RUNTIME_MODE: mode === 'fixture' ? 'fixture' : 'live',
                IMA_PROVIDER_OPENAI: 'true',
                IMA_PROVIDER_PLACES: 'true',
                IMA_PROVIDER_ROUTES: mode === 'fixture' ? 'true' : 'false',
                IMA_PROVIDER_LAST_TRAIN: 'false',
                IMA_PROVIDER_HOTPEPPER: 'false',
                IMA_KILL_SWITCH: 'false',
                OPENAI_API_KEY: mode === 'llm' ? 'dev-llm-test-key' : '',
                GOOGLE_PLACES_API_KEY: '',
                GOOGLE_ROUTES_API_KEY: '',
                PLACES_CURSOR_SECRET: '',
                PHOTO_TOKEN_SECRET: '',
              },
            },
          }),
        ],
        test: {
          name: `runtime-dev-${mode}`,
          setupFiles: ['./workers/api/tests/runtime-setup.ts'],
          include: [
            mode !== 'fixture'
              ? 'workers/api/tests/runtime-dev-fixture/runtime-dev-llm.test.ts'
              : 'workers/api/tests/runtime-dev-fixture/runtime-dev-fixture*.test.ts',
          ],
        },
      }),
    ),
  },
});
