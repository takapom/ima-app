import { workspaceAliases } from './vitest.aliases.ts';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    name: 'unit',
    include: [
      'tests/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'worker/src/domain/**/*.test.ts',
      'worker/src/application/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'worker/tests/adapters/**/*.test.ts',
      'worker/tests/security/**/*.test.ts',
      'worker/tests/composition/**/*.test.ts',
      'worker/tests/runtime/threads/thread-id.test.ts',
      'worker/tests/runtime/model/*.test.ts',
      'worker/tests/model-eval/*.test.ts',
      'worker/tests/model-eval-live/live-contract.test.ts',
      'worker/tests/runtime/**/*.test.ts',
    ],
    exclude: ['tests/worker.test.ts', 'worker/tests/adapters/inbound/http/integration/**'],
  },
});
