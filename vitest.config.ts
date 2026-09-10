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
      'workers/api/tests/runtime-gate/runtime-gate-contract.test.ts',
      'workers/api/tests/runtime-gate/runtime-gate-core.test.ts',
      'workers/api/tests/runtime-gate/runtime-gate-sse.test.ts',
      'workers/api/tests/runtime-gate/retention/retention.test.ts',
      'workers/api/tests/runtime-gate/retention/retention-audit.test.ts',
      'workers/api/tests/runtime-gate/http/runtime-gate-http.test.ts',
      'workers/api/tests/think-runtime/think-runtime-replay.test.ts',
      'workers/api/tests/runtime-gate/retention/retention-runtime-policy.test.ts',
      'workers/api/tests/runtime-gate/runtime-gate-retention.test.ts',
    ],
    exclude: [
      'tests/worker.test.ts',
      'tests/runtime-http-mobile.test.ts',
      'tests/think-runtime-http-mobile.test.ts',
    ],
  },
});
