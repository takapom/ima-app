import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'unit',
    include: [
      'tests/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'workers/api/tests/runtime-gate/runtime-gate-contract.test.ts',
      'workers/api/tests/runtime-gate/retention/retention.test.ts',
    ],
    exclude: ['tests/worker.test.ts', 'tests/runtime-http-mobile.test.ts'],
  },
});
