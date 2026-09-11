import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const workspaces = ['packages/contracts', 'packages/core', 'workers/api', 'apps/mobile'];
const command = process.argv[2];

if (!command) {
  console.error('usage: bun run scripts/run-workspaces.mjs <script>');
  process.exit(2);
}

for (const workspace of workspaces) {
  const manifest = JSON.parse(readFileSync(resolve(workspace, 'package.json'), 'utf8'));
  if (!manifest.scripts?.[command]) {
    console.error(`${workspace}: missing required script ${command}`);
    process.exit(1);
  }
  const result = spawnSync('bun', ['run', '--cwd', workspace, command], { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
