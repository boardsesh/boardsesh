/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  EXPO_FACTORY_PATH,
  OVERRIDE_SOURCE_PATH,
  findFlagOverrideProblems,
  findOverrideSourceProblems,
  stripDebugBlocks,
} from '../assert-ios-flag-override-compiled.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function repoSource(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

const COMPILE_LINE =
  'CompileC /Users/runner/work/boardsesh/boardsesh/packages/mobile/ios/build/Build/Intermediates.noindex/Pods.build/' +
  'Debug-iphonesimulator/BoardseshReactFlagOverrides.build/Objects-normal/arm64/BoardseshReactFlagOverrides.o ' +
  '/Users/runner/work/boardsesh/boardsesh/packages/mobile/modules/react-flag-overrides/ios/BoardseshReactFlagOverrides.mm ' +
  "normal arm64 objective-c++ com.apple.compilers.llvm.clang.1_0.compiler (in target 'BoardseshReactFlagOverrides' from project 'Pods')";

const GOOD_APP_DELEGATE = `internal import Expo
import React
import BoardseshReactFlagOverrides

    let factory = ExpoReactNativeFactory(delegate: delegate)
    BoardseshReactFlagOverrides.install()
    factory.startReactNative(
`;

describe('findFlagOverrideProblems', () => {
  it('passes when the .mm compiled and install() runs between the factory init and startReactNative', () => {
    expect(
      findFlagOverrideProblems({ buildLog: `noise\n${COMPILE_LINE}\nmore`, appDelegate: GOOD_APP_DELEGATE }),
    ).toEqual([]);
  });

  it('fails when the build log has no CompileC for the override (prebuilt or unlinked)', () => {
    const problems = findFlagOverrideProblems({
      buildLog: 'CompileC /x/RNSScrollViewFinder.o /x/RNSScrollViewFinder.mm normal arm64\n',
      appDelegate: GOOD_APP_DELEGATE,
    });

    expect(problems).toEqual([expect.stringContaining('No CompileC line for BoardseshReactFlagOverrides.mm')]);
  });

  it('does not accept a mention of the file that is not a compile step', () => {
    const problems = findFlagOverrideProblems({
      buildLog: 'Analyzing BoardseshReactFlagOverrides.mm\n',
      appDelegate: GOOD_APP_DELEGATE,
    });

    expect(problems).toHaveLength(1);
  });

  it('fails when the call is commented out', () => {
    const problems = findFlagOverrideProblems({
      buildLog: COMPILE_LINE,
      appDelegate: GOOD_APP_DELEGATE.replace(
        '    BoardseshReactFlagOverrides.install()',
        '    // BoardseshReactFlagOverrides.install()',
      ),
    });

    expect(problems).toEqual([expect.stringContaining('never calls BoardseshReactFlagOverrides.install()')]);
  });

  it('fails when install() lands after startReactNative', () => {
    const problems = findFlagOverrideProblems({
      buildLog: COMPILE_LINE,
      appDelegate: `import BoardseshReactFlagOverrides
    let factory = ExpoReactNativeFactory(delegate: delegate)
    factory.startReactNative(
    BoardseshReactFlagOverrides.install()
`,
    });

    expect(problems).toEqual([expect.stringContaining('must sit after')]);
  });

  it('fails when the module import is missing', () => {
    const problems = findFlagOverrideProblems({
      buildLog: COMPILE_LINE,
      appDelegate: GOOD_APP_DELEGATE.replace('import BoardseshReactFlagOverrides\n', ''),
    });

    expect(problems).toEqual([expect.stringContaining('does not "import BoardseshReactFlagOverrides"')]);
  });
});

describe('stripDebugBlocks', () => {
  it('drops a DEBUG-only region and keeps the rest', () => {
    const stripped = stripDebugBlocks(
      ['shipped();', '#if DEBUG', '  debugOnly();', '#endif', 'alsoShipped();'].join('\n'),
    );

    expect(stripped).toContain('shipped();');
    expect(stripped).toContain('alsoShipped();');
    expect(stripped).not.toContain('debugOnly();');
  });

  it('leaves a non-DEBUG conditional alone', () => {
    const stripped = stripDebugBlocks(['#if TARGET_OS_IOS', '  always();', '#endif'].join('\n'));

    expect(stripped).toContain('always();');
  });

  it('skips a nested conditional inside a DEBUG region without eating what follows', () => {
    const stripped = stripDebugBlocks(
      ['#if DEBUG', '#if TARGET_OS_IOS', '  inner();', '#endif', '#endif', 'after();'].join('\n'),
    );

    expect(stripped).not.toContain('inner();');
    expect(stripped).toContain('after();');
  });
});

describe('findOverrideSourceProblems', () => {
  // The two files as they really are: this is what turns the assertions below
  // into a guard on the shipped source rather than on two fixture strings.
  const overrideSource = repoSource(OVERRIDE_SOURCE_PATH);
  const expoFactorySource = repoSource(EXPO_FACTORY_PATH);

  it('passes against the sources in this checkout', () => {
    expect(findOverrideSourceProblems({ overrideSource, expoFactorySource })).toEqual([]);
  });

  it('fails when Expo renames the Info.plist release-level key', () => {
    const problems = findOverrideSourceProblems({
      overrideSource,
      expoFactorySource: expoFactorySource.replaceAll('ReactNativeReleaseLevel', 'RCTReleaseLevelKey'),
    });

    expect(problems).toEqual([expect.stringContaining('no longer mentions "ReactNativeReleaseLevel"')]);
  });

  it('fails when Expo drops one of the release-level names our provider mirrors', () => {
    const problems = findOverrideSourceProblems({
      overrideSource,
      expoFactorySource: expoFactorySource.replaceAll('canary', 'nightly'),
    });

    expect(problems).toEqual([expect.stringContaining('no longer mentions "canary"')]);
  });

  it('fails when the readBeforeSwap log goes back under #if DEBUG', () => {
    // The #5361 regression exactly: the log still exists, still compiles, and is
    // invisible in every build where the timing violation can happen.
    const debugOnly = overrideSource.replace(
      '    NSLog(\n        @"[BoardseshReactFlagOverrides] enableSchedulerDelegateInvalidation',
      '#if DEBUG\n    NSLog(\n        @"[BoardseshReactFlagOverrides] enableSchedulerDelegateInvalidation',
    );

    const problems = findOverrideSourceProblems({ overrideSource: debugOnly, expoFactorySource });

    expect(problems).toEqual([expect.stringContaining('only under #if DEBUG')]);
  });

  it('fails when the log is deleted outright', () => {
    const problems = findOverrideSourceProblems({
      overrideSource: overrideSource.replaceAll('flags read before the swap', 'flags read'),
      expoFactorySource,
    });

    expect(problems).toEqual([expect.stringContaining('only under #if DEBUG')]);
  });
});
