import { fileURLToPath } from 'node:url';
import tsconfig from './tsconfig.base.json' with { type: 'json' };

// Share the TypeScript source aliases with every Vitest project.
export const workspaceAliases = Object.fromEntries(
  Object.entries(tsconfig.compilerOptions.paths).map(([alias, [target]]) => {
    if (target === undefined) throw new Error(`Missing path for ${alias}`);
    return [alias.slice(0, -2), fileURLToPath(new URL(target.slice(0, -2), import.meta.url))];
  }),
);
