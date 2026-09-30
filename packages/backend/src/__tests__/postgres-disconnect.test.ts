import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vite-plus/test';
import { getWorkerDatabaseUrl } from './worker-db';

const executeFile = promisify(execFile);
const fixturePath = fileURLToPath(new URL('./helpers/postgres-disconnect-process.ts', import.meta.url));
const startupFatalFixturePath = fileURLToPath(new URL('./helpers/startup-fatal-process.ts', import.meta.url));

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
      // Name the #5299 crash rather than demanding an empty stderr, which any
      // future Node or tsx deprecation warning would break. Against the stock
      // 3.4.9 driver the `live` scenario prints exactly this, thrown from
      // `process.processImmediate` where no query promise can catch it; the
      // simulated scenarios instead wedge the pool, which `executeFile` already
      // surfaces as a non-zero exit before these assertions run.
      expect(stderr).not.toContain("Cannot read properties of null (reading 'write')");
      expect(stderr).not.toMatch(/\bTypeError\b/);
    },
    20_000,
  );
});

// A server that answers postgres.js's startup array-type fetch with a FATAL and
// a close (found against PgBouncer's query_wait_timeout). The stock 3.4.9 driver
// left that fetch's promise unhandled (Node exits) and delivered the error
// through stale state on the next socket. The patch fails the connect with the
// server's error instead.
describe.each(['esm', 'cjs'])('FATAL during startup (%s)', (entryPoint) => {
  it.each(['fatal', 'close'])(
    'settles the %s scenario with no unhandled rejection',
    async (scenario) => {
      const { stdout } = await executeFile(
        process.execPath,
        ['--import', 'tsx', startupFatalFixturePath, entryPoint, scenario],
        {
          timeout: 15_000,
        },
      );
      expect(stdout).toContain('startup fatal verified');
    },
    20_000,
  );
});
