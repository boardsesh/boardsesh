import { describe, expect, it } from 'vitest';
import { findSchedulerBuildProblems } from '../assert-ios-scheduler-guard-compiled.mjs';

const validBuild = {
  buildLog:
    'CompileC /DerivedData/React-Fabric.build/Scheduler.o /repo/node_modules/react-native/ReactCommon/react/renderer/scheduler/Scheduler.cpp normal arm64 c++\n',
  podfileProperties: { 'ios.buildReactNativeFromSource': 'true' },
  podfile: "ENV['RCT_USE_RN_DEP'] = '0'\nENV['RCT_USE_PREBUILT_RNCORE'] = '0'\n",
  schedulerSource:
    '*delegateInvalidated_ = true;\ninvalidated = delegateInvalidated_;\ninvalidated = delegateInvalidated_;',
};

describe('Scheduler source compilation gate', () => {
  it('accepts a source compilation with the installed guard', () => {
    expect(findSchedulerBuildProblems(validBuild)).toEqual([]);
  });

  it('rejects a log that only mentions the source outside a compile command', () => {
    expect(findSchedulerBuildProblems({ ...validBuild, buildLog: 'Copying Scheduler.cpp\n' })).toContainEqual(
      expect.stringContaining('was not compiled'),
    );
  });

  it('rejects properties alone when an environment override could select prebuilt core', () => {
    expect(
      findSchedulerBuildProblems({ ...validBuild, podfile: "ENV['RCT_USE_PREBUILT_RNCORE'] ||= '0'\n" }),
    ).toHaveLength(2);
  });

  it('rejects an unpatched source even when the compiler ran', () => {
    expect(findSchedulerBuildProblems({ ...validBuild, schedulerSource: '' })).toHaveLength(2);
  });
});
