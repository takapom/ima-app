import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'unit',
    include: [
      'tests/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'worker/core/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'worker/api/tests/http/*.test.ts',
      'worker/api/tests/tools/*.test.ts',
      'worker/api/tests/model/*.test.ts',
      'worker/api/tests/model-eval/*.test.ts',
      'worker/api/tests/model-eval-live/live-contract.test.ts',
      'worker/api/tests/providers/**/*.test.ts',
      'worker/api/tests/runtime/**/*.test.ts',
    ],
    exclude: ['tests/worker.test.ts'],
  },
});
