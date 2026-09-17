import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const workspaceRules = {
  'apps/mobile': {
    allowed: new Set(['@ima/contracts']),
    rule: 'manifest-mobile-only-contracts',
  },
  'worker/api': {
    allowed: new Set(['@ima/contracts', '@ima/core']),
    rule: 'manifest-api-only-contracts-core',
  },
  'packages/contracts': {
    allowed: new Set(),
    rule: 'manifest-contracts-independent',
  },
  'worker/core': {
    allowed: new Set(),
    rule: 'manifest-core-independent',
  },
};

export function findManifestBoundaryViolations(root = process.cwd()) {
  const workspacePackages = new Map(
    Object.keys(workspaceRules).map((workspace) => {
      const manifest = JSON.parse(readFileSync(join(root, workspace, 'package.json'), 'utf8'));
      return [manifest.name, workspace];
    }),
  );
  const violations = [];
  for (const [workspace, policy] of Object.entries(workspaceRules)) {
    const manifestPath = join(root, workspace, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const dependencyNames = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    for (const dependencyName of dependencyNames) {
      const dependencyWorkspace = workspacePackages.get(dependencyName);
      if (dependencyWorkspace && !policy.allowed.has(dependencyName)) {
        violations.push(`${policy.rule}: ${workspace}/package.json declares ${dependencyName}`);
      }
    }
  }
  return violations;
}

const violations = findManifestBoundaryViolations();
if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exit(1);
}
