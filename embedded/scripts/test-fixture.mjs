#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const testRoot = join(repositoryRoot, 'embedded/test');
const unityRoot = join(testRoot, '.pio/libdeps/native/Unity/src');
const genericMocks = join(testRoot, 'lib/mocks/src');
const sanitize = process.argv.includes('--sanitize');
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== '--sanitize');
if (unknownArguments.length > 0) throw new Error(`Unknown fixture test argument: ${unknownArguments.join(', ')}`);
if (!existsSync(join(unityRoot, 'unity.c'))) {
  throw new Error('Unity is missing. Run vp exec pio pkg install -d embedded/test -e native first.');
}

const compilerC = process.env.CC || 'cc';
const compilerCpp = process.env.CXX || 'c++';
const warningFlags = ['-Wall', '-Wextra', '-Werror'];
const sanitizerFlags = sanitize ? ['-fsanitize=address,undefined', '-fno-omit-frame-pointer'] : [];
const buildDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-fixture-tests-'));

function run(command, argumentsList) {
  const result = spawnSync('vp', ['exec', command, ...argumentsList], {
    cwd: repositoryRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal || result.status})`);
}

function compileSuite(name, sources, includeFlags, extraFlags = [], unity = true) {
  const objects = sources.map((source, index) => {
    const objectPath = join(buildDirectory, `${name}-${index}.o`);
    // The existing MoonBoard parser compares Arduino String length to its int
    // cursor. Keep that narrow legacy warning out of the new harness's gate.
    const legacyFlags = source.endsWith('/moonboard_protocol.cpp') ? ['-Wno-sign-compare'] : [];
    run(compilerCpp, [
      '-std=c++17', '-O1', '-g', ...warningFlags, ...sanitizerFlags,
      ...includeFlags, ...extraFlags, ...legacyFlags, '-c', source, '-o', objectPath,
    ]);
    return objectPath;
  });
  if (unity) objects.push(join(buildDirectory, 'unity.o'));
  const executable = join(buildDirectory, name);
  run(compilerCpp, [...sanitizerFlags, ...objects, '-o', executable]);
  console.log(`[fixture-tests] ${name}`);
  run(executable, []);
}

try {
  run(compilerC, [
    '-std=c11', '-O1', '-g', ...warningFlags, ...sanitizerFlags,
    '-I', unityRoot, '-c', join(unityRoot, 'unity.c'), '-o', join(buildDirectory, 'unity.o'),
  ]);
  const bleMocks = join(testRoot, 'test_fixture_ble/mocks');
  compileSuite('ble', [
    join(testRoot, 'test_fixture_ble/test_fixture_ble.cpp'),
    join(repositoryRoot, 'embedded/libs/aurora-protocol/src/aurora_protocol.cpp'),
    join(repositoryRoot, 'embedded/libs/moonboard-protocol/src/moonboard_protocol.cpp'),
    join(repositoryRoot, 'embedded/libs/log-buffer/src/log_buffer.cpp'),
    join(genericMocks, 'Arduino.cpp'),
  ], [
    '-I', bleMocks,
    '-I', join(repositoryRoot, 'embedded/projects/board-controller/src/gym'),
    '-I', join(repositoryRoot, 'embedded/libs/aurora-protocol/src'),
    '-I', join(repositoryRoot, 'embedded/libs/moonboard-protocol/src'),
    '-I', join(repositoryRoot, 'embedded/libs/led-controller/src'),
    '-I', join(repositoryRoot, 'embedded/libs/log-buffer/src'),
    '-isystem', genericMocks,
  ], ['-include', join(bleMocks, 'Arduino.h')], false);
  compileSuite('buttons', [join(testRoot, 'test_fixture_buttons/test_fixture_buttons.cpp')], [
    '-I', join(testRoot, 'test_fixture_buttons/mocks'), '-I', unityRoot,
  ]);
  compileSuite('cache', [join(testRoot, 'test_fixture_cache/test_fixture_cache.cpp')], ['-I', unityRoot]);
  compileSuite('client', [join(testRoot, 'test_fixture_client/test_fixture_client.cpp')], [
    '-I', join(testRoot, 'test_fixture_client/mocks'), '-I', unityRoot,
  ]);
  compileSuite('geometry', [join(testRoot, 'test_amoled_preview/test_amoled_preview.cpp')], ['-I', unityRoot]);
  console.log(`[fixture-tests] All five suites passed${sanitize ? ' with address/undefined sanitizers' : ''}.`);
} finally {
  rmSync(buildDirectory, { recursive: true, force: true });
}
