import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const executeFile = promisify(execFile);
const fixturesDirectory = fileURLToPath(new URL('./fixtures/', import.meta.url));
const mobileRequire = createRequire(new URL('../../packages/mobile/package.json', import.meta.url));
const sqliteDirectory = join(dirname(mobileRequire.resolve('expo-sqlite/package.json')), 'vendor/sqlite3');

// This intentionally requires a host C compiler (provided by Linux CI and Xcode)
// instead of silently skipping native validation. It compiles Expo's exact engine,
// not the different SQLite bundled with Node or installed on the host.
describe('Expo vendored native SQLite finalization', () => {
  let temporaryDirectory: string;
  let executable: string;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'boardsesh-sqlite-finalize-'));
    executable = join(temporaryDirectory, 'sqlite-finalize');
    await executeFile(
      'cc',
      [
        '-O0',
        '-I',
        sqliteDirectory,
        join(fixturesDirectory, 'expo-sqlite-native-finalize.c'),
        join(sqliteDirectory, 'sqlite3.c'),
        '-lpthread',
        '-ldl',
        '-lm',
        '-o',
        executable,
      ],
      { timeout: 120_000, maxBuffer: 1024 * 1024 },
    );
  }, 130_000);

  afterAll(async () => {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it.each([
    ['busy', 'destroys a statement even when execution and finalization both report BUSY'],
    ['constraint', 'destroys a statement even when execution and finalization both report CONSTRAINT'],
    ['returning-busy', 'rejects the commit at finalization after RETURNING has successfully yielded a row'],
    ['success', 'commits a RETURNING write when finalization succeeds'],
  ])('%s: %s', async (scenario) => {
    const { stdout } = await executeFile(executable, [scenario, join(temporaryDirectory, `${scenario}.db`)], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    expect(stdout.trim()).toBe(`PASS ${scenario}`);
  });
});
