/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('OpenAPI local environment loading', () => {
  it('loads .env.local under Node while preserving inherited deploy values', () => {
    const webRoot = mkdtempSync(join(tmpdir(), 'boardsesh-openapi-env-'));
    temporaryDirectories.push(webRoot);
    writeFileSync(
      join(webRoot, '.env.local'),
      'BASE_URL=https://local.boardsesh.test\nNEXTAUTH_URL=https://local-auth.boardsesh.test\n',
    );

    const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
    const loaderUrl = pathToFileURL(join(scriptsDirectory, 'load-local-env.ts')).href;
    const program = [
      `const loader = await import(${JSON.stringify(loaderUrl)});`,
      'const loadWebLocalEnvironment = loader.loadWebLocalEnvironment ?? loader.default.loadWebLocalEnvironment;',
      `loadWebLocalEnvironment(${JSON.stringify(webRoot)});`,
      'process.stdout.write(JSON.stringify({ BASE_URL: process.env.BASE_URL, NEXTAUTH_URL: process.env.NEXTAUTH_URL }));',
    ].join('\n');
    const environment = { ...process.env, BASE_URL: 'https://deploy.boardsesh.test' };
    delete environment.NEXTAUTH_URL;

    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', program], {
      cwd: scriptsDirectory,
      encoding: 'utf8',
      env: environment,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout) as Record<string, string>).toEqual({
      BASE_URL: 'https://deploy.boardsesh.test',
      NEXTAUTH_URL: 'https://local-auth.boardsesh.test',
    });
  });
});
