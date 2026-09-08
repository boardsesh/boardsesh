import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vite-plus/test';
import { getWorkerDatabaseUrl } from './worker-db';

const executeFile = promisify(execFile);
const fixturePath = fileURLToPath(new URL('./helpers/postgres-disconnect-process.ts', import.meta.url));

describe.each(['esm', 'cjs'])('postgres disconnect recovery (%s)', (entryPoint) => {
  it.each(['clean', 'error', 'fatal', 'startup', 'delayed', 'live'])(
    'survives %s disconnects and reuses the pool without replaying statements',
    async (scenario) => {
      const { stdout, stderr } = await executeFile(
        process.execPath,
        ['--import', 'tsx', fixturePath, entryPoint, scenario],
        {
          env: { ...process.env, DATABASE_URL: getWorkerDatabaseUrl() },
          timeout: 15_000,
        },
      );
      expect(stdout).toContain('disconnect recovery verified');
      expect(stderr).toBe('');
    },
    20_000,
  );
});
