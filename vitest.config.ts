import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'unit',
    include: [
      'tests/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'workers/api/tests/http/*.test.ts',
      'workers/api/tests/tools/*.test.ts',
      'workers/api/tests/model/*.test.ts',
      'workers/api/tests/model-eval/*.test.ts',
      'workers/api/tests/model-eval-live/live-contract.test.ts',
      'workers/api/tests/providers/**/*.test.ts',
      'workers/api/tests/runtime/*.test.ts',
      'workers/api/tests/think-runtime/think-runtime-replay.test.ts',
    ],
    exclude: [
      'tests/worker.test.ts',
      'tests/think-runtime-http-mobile.test.ts',
    ],
  },
});
