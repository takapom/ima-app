import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { countFileLines } from './check-file-lines.mjs';

const repositoryRoot = process.cwd();
const eslint = resolve(repositoryRoot, 'node_modules/eslint/bin/eslint.js');
const tsc = resolve(repositoryRoot, 'node_modules/typescript/bin/tsc');

function countedSource(count, newline, trailingNewline, line) {
  const source = Array.from({ length: count }, (_, index) => line(index)).join(newline);
  return trailingNewline ? `${source}${newline}` : source;
}

const lintCases = [
  {
    name: 'no-explicit-any',
    directory: 'worker/core/src',
    source: 'export const invalidValue: any = 1;\n',
    rule: '@typescript-eslint/no-explicit-any',
  },
  {
    name: 'no-floating-promises',
    directory: 'worker/core/src',
    source: 'export function invalidPromise(): void { Promise.resolve(1); }\n',
    rule: '@typescript-eslint/no-floating-promises',
  },
  {
    name: 'switch-exhaustiveness',
    directory: 'worker/core/src',
    source:
      [
        "type Event = { type: 'created' } | { type: 'deleted' };",
        'export function invalidSwitch(event: Event): number {',
        '  switch (event.type) {',
        "    case 'created': return 1;",
        '  }',
        '  return 0;',
        '}',
      ].join('\n') + '\n',
    rule: '@typescript-eslint/switch-exhaustiveness-check',
  },
  {
    name: 'react-hooks-order',
    directory: 'apps/mobile/src/components',
    source:
      [
        "import { useState } from 'react';",
        'export function InvalidHook(): number {',
        '  if (Math.random() > 0) useState(0);',
        '  return 1;',
        '}',
      ].join('\n') + '\n',
    rule: 'react-hooks/rules-of-hooks',
  },
  {
    name: 'allowed-typed-code',
    directory: 'worker/core/src',
    source:
      'export async function validPromise(): Promise<number> {\n  return await Promise.resolve(1);\n}\n',
    rule: null,
  },
  {
    name: 'max-lines-499-lf-no-eof',
    directory: 'worker/core/src',
    source: countedSource(499, '\n', false, (index) => `export const line${index} = ${index};`),
    rule: null,
  },
  {
    name: 'max-lines-500-crlf-comments',
    directory: 'worker/core/src',
    source: countedSource(500, '\r\n', true, () => '// counted comment'),
    rule: null,
  },
  {
    name: 'max-lines-501-crlf-blank-comments',
    directory: 'worker/core/src',
    source: countedSource(501, '\r\n', true, (index) =>
      index % 2 === 0 ? '// counted comment' : '',
    ),
    rule: 'max-lines',
  },
  {
    name: 'core-clock-input-is-allowed',
    directory: 'worker/core/src',
    source: 'export const parsedInput = (input: string): number => Date.parse(input);\n',
    rule: null,
  },
  {
    name: 'core-now-is-forbidden',
    directory: 'worker/core/src',
    source: 'export const invalidClock = Date.now();\n',
    rule: 'no-restricted-properties',
  },
  {
    name: 'core-current-time-constructor-is-forbidden',
    directory: 'worker/core/src',
    source: 'export const invalidClock = new Date();\n',
    rule: 'no-restricted-syntax',
  },
  {
    name: 'core-global-fetch-is-forbidden',
    directory: 'worker/core/src',
    source: "export const invalidNetworkCall = () => globalThis.fetch('/private');\n",
    rule: 'no-restricted-syntax',
  },
  {
    name: 'core-timer-is-forbidden',
    directory: 'worker/core/src',
    source: 'export const invalidTimer = () => setTimeout(() => undefined, 1);\n',
    rule: 'no-restricted-syntax',
  },
  {
    name: 'core-node-io',
    directory: 'worker/core/src',
    source: "import fs from 'node:fs';\nexport { fs };\n",
    rule: 'no-restricted-imports',
  },
  {
    name: 'mobile-network-io',
    directory: 'apps/mobile/src/components',
    source: "export const invalidNetworkCall = () => fetch('/private');\n",
    rule: 'no-restricted-globals',
  },
  {
    name: 'mobile-global-fetch-io',
    directory: 'apps/mobile/src/components',
    source: "export const invalidNetworkCall = () => globalThis.fetch('/private');\n",
    rule: 'no-restricted-syntax',
  },
  {
    name: 'worker-provider-sdk',
    directory: 'workers/api/src/tool-bindings',
    source: "import { generateText } from 'ai';\nexport { generateText };\n",
    rule: 'no-restricted-imports',
  },
  {
    name: 'allowed-core-code',
    directory: 'worker/core/src',
    source: 'export const allowedCoreValue = 1;\n',
    rule: null,
  },
  {
    name: 'allowed-mobile-code',
    directory: 'apps/mobile/src/components',
    source: 'export const AllowedMobileValue = 1;\n',
    rule: null,
  },
  {
    name: 'mobile-service-network-io',
    directory: 'apps/mobile/src/services',
    source: "export const serviceNetworkCall = () => fetch('/private');\n",
    rule: null,
  },
  {
    name: 'allowed-worker-code',
    directory: 'workers/api/src/tool-bindings',
    source: 'export const allowedToolValue = 1;\n',
    rule: null,
  },
];

function writeTemporaryFixture(testCase) {
  const baseDirectory = resolve(repositoryRoot, testCase.directory);
  mkdirSync(baseDirectory, { recursive: true });
  const temporaryDirectory = mkdtempSync(join(baseDirectory, 'quality-fixtures-'));
  const extension = testCase.directory.startsWith('apps/mobile') ? '.tsx' : '.ts';
  const absolutePath = join(temporaryDirectory, `fixture${extension}`);
  writeFileSync(absolutePath, testCase.source, { flag: 'wx' });
  return { absolutePath, temporaryDirectory };
}

function runLint(testCase) {
  const { absolutePath, temporaryDirectory } = writeTemporaryFixture(testCase);
  try {
    const result = spawnSync(process.execPath, [eslint, '--no-warn-ignored', absolutePath], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    const output = `${result.stdout}\n${result.stderr}`;
    if (testCase.name.startsWith('max-lines')) {
      const helperRejects = countFileLines(testCase.source) > 500;
      const eslintRejects = result.status === 1 && output.includes('max-lines');
      if (helperRejects !== eslintRejects) {
        throw new Error(
          `${testCase.name}: helper and ESLint disagree (helper=${helperRejects}, eslint=${eslintRejects})`,
        );
      }
    }
    if (testCase.rule === null && result.status !== 0) {
      throw new Error(`${testCase.name}: expected success, got\n${output}`);
    }
    if (testCase.rule !== null && (result.status !== 1 || !output.includes(testCase.rule))) {
      throw new Error(`${testCase.name}: expected exit 1 and ${testCase.rule}, got\n${output}`);
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function runTypecheck() {
  const testCase = {
    directory: 'worker/core/src',
    source: 'const invalidType: string = 42;\nexport { invalidType };\n',
  };
  const { temporaryDirectory } = writeTemporaryFixture(testCase);
  try {
    const result = spawnSync(
      process.execPath,
      [tsc, '-p', 'worker/core/tsconfig.json', '--noEmit'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
      },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes('TS2322')) {
      throw new Error(`typecheck fixture did not produce TS2322:\n${output}`);
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

for (const testCase of lintCases) {
  runLint(testCase);
}
runTypecheck();
console.log(`strict lint/typecheck fixtures: ${lintCases.length + 1} cases passed`);
