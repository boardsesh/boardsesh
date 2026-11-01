#!/usr/bin/env node
// The source patch is effective only when the archive compiles Scheduler.cpp.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function findSchedulerBuildProblems({ buildLog, podfileProperties, podfile, schedulerSource }) {
  const problems = [];
  if (!/^CompileC\s+.*[ /]Scheduler\.cpp\s/m.test(buildLog)) {
    problems.push('Scheduler.cpp was not compiled; the prebuilt React framework omits the lifetime patch (#5293).');
  }
  if (podfileProperties['ios.buildReactNativeFromSource'] !== 'true') {
    problems.push('Podfile.properties.json must enable ios.buildReactNativeFromSource.');
  }
  for (const key of ['RCT_USE_RN_DEP', 'RCT_USE_PREBUILT_RNCORE']) {
    if (!podfile.includes(`ENV['${key}'] = '0'`)) {
      problems.push(`Podfile must force ${key}=0 even when inherited from the environment.`);
    }
  }
  if (!schedulerSource.includes('*delegateInvalidated_ = true;')) {
    problems.push('The installed Scheduler lacks the delegate invalidation patch.');
  }
  if ((schedulerSource.match(/invalidated = delegateInvalidated_/g) ?? []).length !== 2) {
    problems.push('Both deferred delegate callbacks must capture their lifetime token.');
  }
  return problems;
}

export function main(args) {
  const [buildLogPath, iosDirectory = 'packages/mobile/ios'] = args;
  if (!buildLogPath) {
    console.error('usage: assert-ios-scheduler-guard-compiled.mjs <build.log> [ios-directory]');
    return 1;
  }
  const mobileRequire = createRequire(new URL('../packages/mobile/package.json', import.meta.url));
  const nativeRoot = dirname(mobileRequire.resolve('react-native/package.json'));
  const problems = findSchedulerBuildProblems({
    buildLog: readFileSync(buildLogPath, 'utf8'),
    podfileProperties: JSON.parse(readFileSync(join(iosDirectory, 'Podfile.properties.json'), 'utf8')),
    podfile: readFileSync(join(iosDirectory, 'Podfile'), 'utf8'),
    schedulerSource: readFileSync(join(nativeRoot, 'ReactCommon/react/renderer/scheduler/Scheduler.cpp'), 'utf8'),
  });
  for (const problem of problems) console.error(`[scheduler-guard] ${problem}`);
  if (problems.length === 0) console.log('[scheduler-guard] Patched Scheduler.cpp compiled from source.');
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
