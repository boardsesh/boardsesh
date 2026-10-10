import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const executeFile = promisify(execFile);
const mobileRequire = createRequire(new URL('../../packages/mobile/package.json', import.meta.url));

function swiftBlock(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  if (start < 0) throw new Error(`Missing installed Swift declaration: ${declaration}`);
  const opening = source.indexOf('{', start);
  let depth = 1;
  for (let position = opening + 1; position < source.length; position++) {
    if (source[position] === '{') depth++;
    if (source[position] === '}' && --depth === 0) return source.slice(start, position + 1);
  }
  throw new Error(`Unclosed installed Swift declaration: ${declaration}`);
}

// iOS lifecycle code needs the Swift/Apple host toolchain. The platform-neutral
// vendored-engine finalization suite runs on Linux too. This test compiles the
// installed patched methods, rather than a second implementation of cleanup.
describe.skipIf(process.platform !== 'darwin')('Expo native runtime teardown', () => {
  let temporaryDirectory: string;
  let executable: string;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'boardsesh-runtime-teardown-'));
    executable = join(temporaryDirectory, 'runtime-teardown');
    const sqlitePackage = dirname(mobileRequire.resolve('expo-sqlite/package.json'));
    const sqliteDirectory = join(sqlitePackage, 'vendor/sqlite3');
    const corePackage = dirname(mobileRequire.resolve('expo-modules-core/package.json'));
    const [sqliteSource, coreSource, fixture] = await Promise.all([
      readFile(join(sqlitePackage, 'ios/SQLiteModule.swift'), 'utf8'),
      readFile(join(corePackage, 'ios/Core/AppContext.swift'), 'utf8'),
      readFile(new URL('./fixtures/expo-sqlite-runtime-teardown.swift', import.meta.url), 'utf8'),
    ]);
    const harness = fixture
      .replace(
        '// INSERT_APP_CONTEXT_METHODS',
        ['public func destroy()', 'private func postAppContextDestroysOnce()', 'deinit {']
          .map((declaration) => swiftBlock(coreSource, declaration))
          .join('\n'),
      )
      .replace('// INSERT_SQLITE_QUEUE', `${swiftBlock(sqliteSource, 'private let moduleQueue: DispatchQueue')}()`)
      .replace(
        '// INSERT_SQLITE_METHODS',
        [
          'private func closeAllDatabases()',
          'private func removeAllCachedDatabases()',
          'private func closeDatabase(',
          'private func maybeFinalizeAllStatements(',
          'private func convertSqlLiteErrorToString(_ db: OpaquePointer?)',
          'private func convertSqlLiteErrorToString(_ db: NativeDatabase)',
        ]
          .map((declaration) => swiftBlock(sqliteSource, declaration))
          .join('\n'),
      );
    const harnessPath = join(temporaryDirectory, 'main.swift');
    const sqliteObject = join(temporaryDirectory, 'sqlite3.o');
    await writeFile(harnessPath, harness);
    await executeFile(
      'cc',
      ['-O0', '-DSQLITE_THREADSAFE=1', '-c', join(sqliteDirectory, 'sqlite3.c'), '-o', sqliteObject],
      {
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      },
    );
    await executeFile(
      'swiftc',
      [
        '-swift-version',
        '5',
        '-import-objc-header',
        join(sqliteDirectory, 'sqlite3.h'),
        '-module-cache-path',
        join(temporaryDirectory, 'swift-cache'),
        harnessPath,
        sqliteObject,
        '-o',
        executable,
      ],
      { timeout: 120_000, maxBuffer: 1024 * 1024 },
    );
  }, 250_000);

  afterAll(async () => {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it.each(['lifecycle', 'retained-context', 'admitted-prepare', 'same-queue', 'other-module-queue'])(
    '%s closes abandoned writers without touching the next runtime',
    async (scenario) => {
      const { stdout } = await executeFile(executable, [scenario, join(temporaryDirectory, `${scenario}.db`)], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      expect(stdout.trim()).toBe(`PASS ${scenario}`);
    },
  );
});
