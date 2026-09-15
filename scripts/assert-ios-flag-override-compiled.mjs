#!/usr/bin/env node
// Asserts the #5293 SchedulerDelegate flag override is really in the iOS build.
//
// Usage: node scripts/assert-ios-flag-override-compiled.mjs <xcodebuild build.log> <ios/Boardsesh/AppDelegate.swift>
//
// A green xcodebuild proves nothing about it. The first attempt at this fix
// patched a react-native header that the prebuilt React.xcframework never
// compiles, and CI stayed green. So check both halves of what ships:
//   1. xcodebuild compiled BoardseshReactFlagOverrides.mm (a `CompileC` line), and
//   2. the generated AppDelegate imports the module and calls install() after
//      the factory init and before startReactNative.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const OVERRIDE_SOURCE = 'BoardseshReactFlagOverrides.mm';
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
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::${problem}`);
    return 1;
  }
  console.log(`${OVERRIDE_SOURCE} compiled and ${INSTALL_CALL} runs before startReactNative — #5293 override ships.`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
