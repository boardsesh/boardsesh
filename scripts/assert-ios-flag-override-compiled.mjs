#!/usr/bin/env node
// Asserts the #5293 SchedulerDelegate flag override is really in the iOS build.
//
// Usage: node scripts/assert-ios-flag-override-compiled.mjs <xcodebuild build.log> <ios/Boardsesh/AppDelegate.swift>
//
// A green xcodebuild proves nothing about it. The first attempt at this fix
// patched a react-native header that the prebuilt React.xcframework never
// compiles, and CI stayed green. So check every half of what ships:
//   1. xcodebuild compiled BoardseshReactFlagOverrides.mm (a `CompileC` line),
//   2. the generated AppDelegate imports the module and calls install() after
//      the factory init and before startReactNative,
//   3. Expo still reads the release level from the Info.plist key our provider
//      duplicates — a rename there reverts every non-Scheduler flag to the Stable
//      default in silence, since the .mm keeps compiling either way, and
//   4. the readBeforeSwap line is logged unconditionally, not under #if DEBUG:
//      it reports a timing-contract violation that only a shipped configuration
//      produces, so a DEBUG-only log could never be read where it matters.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const OVERRIDE_SOURCE = 'BoardseshReactFlagOverrides.mm';

/** Our copy of the release-level lookup. */
export const OVERRIDE_SOURCE_PATH = `packages/mobile/modules/react-flag-overrides/ios/${OVERRIDE_SOURCE}`;

/** Expo's original, the one this pins against. */
export const EXPO_FACTORY_PATH = 'packages/mobile/node_modules/expo/ios/AppDelegates/ExpoReactNativeFactory.swift';

/**
 * Sentinels that must still appear in ExpoReactNativeFactory.swift.
 *
 * makeProvider() in the .mm re-implements that init's lookup, and the two agree
 * only by hand. If Expo renames the plist key or a level string, our provider
 * silently answers Stable for every flag the factory would have answered
 * differently — a source-text check is the only thing that sees it, because the
 * prebuilt React.xcframework compiles our file regardless.
 */
export const RELEASE_LEVEL_SENTINELS = ['ReactNativeReleaseLevel', 'canary', 'experimental', 'stable'];

/** The unconditional log the .mm must keep — see (4) above. */
export const READ_BEFORE_SWAP_LOG = 'flags read before the swap';
export const IMPORT_LINE = 'import BoardseshReactFlagOverrides';
export const INSTALL_CALL = 'BoardseshReactFlagOverrides.install()';
const FACTORY_INIT = 'ExpoReactNativeFactory(delegate: delegate)';
const START_CALL = 'factory.startReactNative(';

/** Drops `//` line comments so a commented-out call does not count. */
function stripSwiftLineComments(source) {
  return source
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/**
 * Drops every `#if DEBUG` … `#endif` region so a DEBUG-only line does not count
 * as shipped. Conditions other than DEBUG are left alone, and the regions in this
 * file do not nest.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripDebugBlocks(source) {
  const kept = [];
  let depth = 0;
  for (const line of source.split('\n')) {
    const directive = line.trim();
    if (depth > 0) {
      if (/^#\s*if/.test(directive)) depth += 1;
      else if (/^#\s*endif/.test(directive)) depth -= 1;
      continue;
    }
    if (/^#\s*if\s+DEBUG\b/.test(directive) || /^#\s*ifdef\s+DEBUG\b/.test(directive)) {
      depth = 1;
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * The two source-text assertions: Expo's lookup still says what our copy assumes,
 * and the readBeforeSwap log survives a release build.
 *
 * @param {{ overrideSource: string, expoFactorySource: string }} input
 * @returns {string[]} one message per problem
 */
export function findOverrideSourceProblems({ overrideSource, expoFactorySource }) {
  const problems = [];

  for (const sentinel of RELEASE_LEVEL_SENTINELS) {
    if (!expoFactorySource.includes(sentinel)) {
      problems.push(
        `ExpoReactNativeFactory.swift no longer mentions "${sentinel}", so makeProvider() in ${OVERRIDE_SOURCE} ` +
          "is no longer mirroring Expo's release-level lookup. Every flag except " +
          'enableSchedulerDelegateInvalidation would silently fall back to the Stable default (#5361). ' +
          `Re-read ${EXPO_FACTORY_PATH} and update both sides.`,
      );
    }
  }

  const shipped = stripDebugBlocks(overrideSource);
  if (!shipped.includes(READ_BEFORE_SWAP_LOG)) {
    problems.push(
      `${OVERRIDE_SOURCE} logs "${READ_BEFORE_SWAP_LOG}" only under #if DEBUG (or not at all). That line reports ` +
        'flags read BEFORE dangerouslyForceOverride — the timing-contract violation — which only a release ' +
        'configuration produces, so it has to be logged unconditionally (#5361).',
    );
  }

  return problems;
}

/**
 * @param {{ buildLog: string, appDelegate: string }} input
 * @returns {string[]} one message per problem; empty means the override ships
 */
export function findFlagOverrideProblems({ buildLog, appDelegate }) {
  const problems = [];

  const compiled = buildLog.split('\n').some((line) => /^\s*CompileC\s/.test(line) && line.includes(OVERRIDE_SOURCE));
  if (!compiled) {
    problems.push(
      `No CompileC line for ${OVERRIDE_SOURCE} in the xcodebuild log, so the #5293 flag override was not compiled. ` +
        'Check that modules/react-flag-overrides is still autolinked (pod install lists BoardseshReactFlagOverrides).',
    );
  }

  const code = stripSwiftLineComments(appDelegate);
  if (!code.split('\n').some((line) => line.trim() === IMPORT_LINE)) {
    problems.push(`AppDelegate.swift does not "${IMPORT_LINE}" (plugins/with-scheduler-delegate-invalidation.js).`);
  }
  const installIndex = code.indexOf(INSTALL_CALL);
  const factoryIndex = code.indexOf(FACTORY_INIT);
  const startIndex = code.indexOf(START_CALL);
  if (installIndex === -1) {
    problems.push(`AppDelegate.swift never calls ${INSTALL_CALL} (plugins/with-scheduler-delegate-invalidation.js).`);
  } else if (factoryIndex === -1 || startIndex === -1 || installIndex < factoryIndex || installIndex > startIndex) {
    problems.push(
      `${INSTALL_CALL} must sit after "${FACTORY_INIT}" and before "${START_CALL}" in AppDelegate.swift ` +
        `(install at ${installIndex}, factory at ${factoryIndex}, start at ${startIndex}).`,
    );
  }

  return problems;
}

/** Reads a repo-relative source file, or pushes a fail-closed problem. */
function readSource(relativePath, problems) {
  const path = resolve(REPO_ROOT, relativePath);
  if (!existsSync(path)) {
    problems.push(
      `${relativePath} is not there, so the #5361 source assertions cannot run. A missing path is a failure, ` +
        'not a pass: either the file moved or the dependency is not installed.',
    );
    return null;
  }
  return readFileSync(path, 'utf8');
}

function main(argv) {
  const [buildLogPath, appDelegatePath] = argv;
  if (!buildLogPath || !appDelegatePath) {
    console.error('usage: assert-ios-flag-override-compiled.mjs <build.log> <AppDelegate.swift>');
    return 2;
  }
  const problems = findFlagOverrideProblems({
    buildLog: readFileSync(buildLogPath, 'utf8'),
    appDelegate: readFileSync(appDelegatePath, 'utf8'),
  });

  const overrideSource = readSource(OVERRIDE_SOURCE_PATH, problems);
  const expoFactorySource = readSource(EXPO_FACTORY_PATH, problems);
  if (overrideSource !== null && expoFactorySource !== null) {
    problems.push(...findOverrideSourceProblems({ overrideSource, expoFactorySource }));
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::${problem}`);
    return 1;
  }
  console.log(
    `${OVERRIDE_SOURCE} compiled, ${INSTALL_CALL} runs before startReactNative, Expo still reads ` +
      'ReactNativeReleaseLevel and the readBeforeSwap log is unconditional — #5293/#5361 override ships.',
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
