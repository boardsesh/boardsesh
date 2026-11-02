import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const executeFile = promisify(execFile);
const mobileRequire = createRequire(new URL('../../packages/mobile/package.json', import.meta.url));

function nativeMethod(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  if (start < 0) throw new Error(`Missing installed scheduler method: ${declaration}`);
  const opening = source.indexOf('{', start);
  let depth = 1;
  for (let position = opening + 1; position < source.length; position++) {
    if (source[position] === '{') depth++;
    if (source[position] === '}' && --depth === 0) return source.slice(start, position + 1);
  }
  throw new Error(`Unclosed installed scheduler method: ${declaration}`);
}

// Compile the installed C++ setter and both queued callbacks against a tiny
// rendering queue. Stubs replace renderer dependencies, never lifetime logic.
describe('installed Scheduler delegate lifetime', () => {
  let temporaryDirectory: string;
  let executable: string;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'boardsesh-scheduler-lifetime-'));
    executable = join(temporaryDirectory, 'scheduler-lifetime');
    const nativeRoot = dirname(mobileRequire.resolve('react-native/package.json'));
    const [schedulerSource, fixture] = await Promise.all([
      readFile(join(nativeRoot, 'ReactCommon/react/renderer/scheduler/Scheduler.cpp'), 'utf8'),
      readFile(new URL('./fixtures/scheduler-delegate-lifetime.cpp', import.meta.url), 'utf8'),
    ]);
    const destructor = nativeMethod(schedulerSource, 'Scheduler::~Scheduler()');
    const invalidation = destructor.match(/\*delegateInvalidated_\s*=\s*true;/)?.[0];
    if (!invalidation) throw new Error('Installed Scheduler destructor no longer invalidates queued callbacks.');
    const harness = fixture
      .replace('/* INSERT_DESTRUCTOR_INVALIDATION */', invalidation)
      .replace(
        '// INSERT_INSTALLED_METHODS',
        [
          'void Scheduler::setDelegate(',
          'void Scheduler::uiManagerDidFinishTransaction(',
          'void Scheduler::uiManagerDidDispatchCommand(',
        ]
          .map((declaration) => nativeMethod(schedulerSource, declaration))
          .join('\n'),
      );
    const harnessPath = join(temporaryDirectory, 'main.cpp');
    await writeFile(harnessPath, harness);
    await executeFile('c++', ['-std=c++20', '-Wall', '-Wextra', '-Werror', harnessPath, '-o', executable], {
      timeout: 30_000,
    });
  }, 40_000);

  afterAll(async () => {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it.each(['replacement', 'null', 'destruction', 'same-delegate', 'synchronous'])(
    '%s preserves the active delegate and skips retired callbacks',
    async (scenario) => {
      const { stdout } = await executeFile(executable, [scenario], { timeout: 5_000 });
      expect(stdout.trim()).toBe(`PASS ${scenario}`);
    },
  );
});
