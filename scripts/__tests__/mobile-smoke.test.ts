/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import {
  SMOKE_ROUTES,
  buildSmokeResult,
  classifySmokeFailure,
  findAndroidNativeCrashes,
  findIosNativeCrashes,
  findSmokePingProblems,
  parseSmokePingLog,
  replayProblemsForSmoke,
  shouldRetrySmoke,
  smokePingsSettled,
  type SmokeAttempt,
  type SmokeEvidence,
} from '../lib/mobile-smoke';
import { parseArgs, buildScreenshotEnv, renderSmokeSummary, smokeResultPath } from '../mobile-screenshots';
import { SCREENSHOT_READY_PORT } from '../lib/metro-dev-server';
import { NO_GRAPHQL_HIT_PROBLEM } from '../lib/screenshot-fixtures';

const ALL_PRESENT = [
  '/smoke?kind=content&route=%2Fhome&count=0',
  '/smoke?kind=content&route=%2Fhome&count=12',
  '/smoke?kind=content&route=%2Fprofile&count=9',
  '/smoke?kind=content&route=%2Fclimbs&count=20',
  '/smoke?kind=content&route=play-drawer&count=7',
].join('\n');

describe('smoke ping assertions', () => {
  it('passes when every route reported content, keeping the largest count per route', () => {
    const pings = parseSmokePingLog(ALL_PRESENT);
    expect(pings).toHaveLength(5);
    expect(findSmokePingProblems(pings, SMOKE_ROUTES)).toEqual({ errors: [], content: [] });
    expect(smokePingsSettled(pings, SMOKE_ROUTES)).toBe(true);
  });

  it('names the route whose ping never arrived', () => {
    const pings = parseSmokePingLog(ALL_PRESENT.replace('/smoke?kind=content&route=%2Fprofile&count=9\n', ''));
    expect(smokePingsSettled(pings, SMOKE_ROUTES)).toBe(false);
    const problems = findSmokePingProblems(pings, SMOKE_ROUTES);
    expect(problems.errors).toEqual([]);
    expect(problems.content).toEqual([
      'no content-ready ping from /profile within the wait: the screen never rendered.',
    ]);
  });

  it('fails a route that only ever reported a zero count', () => {
    const pings = parseSmokePingLog(ALL_PRESENT.replace('route=%2Fclimbs&count=20', 'route=%2Fclimbs&count=0'));
    expect(smokePingsSettled(pings, SMOKE_ROUTES)).toBe(false);
    expect(findSmokePingProblems(pings, SMOKE_ROUTES).content).toEqual([
      '/climbs rendered with a count of 0: the screen is empty where content is required.',
    ]);
  });

  it('fails on any error ping, even with every content ping present, and stops the wait', () => {
    const pings = parseSmokePingLog(
      `${ALL_PRESENT}\n/smoke?kind=error&message=${encodeURIComponent('Error: boom on mount')}`,
    );
    expect(findSmokePingProblems(pings, SMOKE_ROUTES).errors).toEqual([
      "the app's crash screen mounted: Error: boom on mount",
    ]);
    // An error ping settles the wait on its own: nothing more is coming.
    expect(smokePingsSettled(parseSmokePingLog('/smoke?kind=error&message=x'), SMOKE_ROUTES)).toBe(true);
  });

  it('ignores lines that are not well-formed pings', () => {
    expect(
      parseSmokePingLog('x\n/ready\n/smoke?kind=content&route=%2Fhome\n/smoke?kind=other&route=a&count=1'),
    ).toEqual([]);
  });
});

// Shaped on the tombstones from Mobile Screenshots (Android) run 37283222059,
// re-timed into `adb logcat`'s default threadtime format.
const LAUNCH_CRASH_LOGCAT = [
  '10-05 08:29:42.700   600   640 I ActivityManager: Start proc 5706:com.boardsesh.app.dev/u0a215 for next-top-activity {com.boardsesh.app.dev/expo.modules.devlauncher.launcher.DevLauncherActivity}',
  '10-05 08:29:58.800  5706  5762 I ReactNativeJS: Running "main"',
  '10-05 08:30:00.935  5706  5762 F libc    : Fatal signal 11 (SIGSEGV), code 2 (SEGV_ACCERR), fault addr 0x7c94256862e8 in tid 5762 (mqt_v_js), pid 5706 (ardsesh.app.dev)',
  '10-05 08:30:01.392  5790  5790 F DEBUG   : pid: 5706, tid: 5762, name: mqt_v_js  >>> com.boardsesh.app.dev <<<',
  '10-05 08:30:01.393  5790  5790 F DEBUG   : Cause: trying to execute non-executable memory.',
  '10-05 08:30:01.394  5790  5790 F DEBUG   :       #00 pc 00000000000172e8  [anon:scudo:primary]',
  '10-05 08:30:01.394  5790  5790 F DEBUG   :       #01 pc 00000000010f0159  /data/app/base.apk!libreactnative.so (facebook::react::MountingCoordinator::pullTransaction(bool) const+713)',
].join('\n');

describe('findAndroidNativeCrashes', () => {
  it('finds the launch SIGSEGV once, with its frames and how long after start it fired', () => {
    const crashes = findAndroidNativeCrashes(LAUNCH_CRASH_LOGCAT, 'com.boardsesh.app.dev');
    expect(crashes).toHaveLength(1);
    expect(crashes[0].headline).toContain('Fatal signal 11 (SIGSEGV)');
    expect(crashes[0].secondsAfterStart).toBe(18.2);
    expect(crashes[0].frames).toHaveLength(2);
    expect(crashes[0].frames[1]).toContain('MountingCoordinator::pullTransaction');
  });

  it('ignores a fatal signal in a process that is not the app', () => {
    const systemCrash = LAUNCH_CRASH_LOGCAT.replaceAll(' 5706  5762 F libc', ' 9999  9999 F libc').replace(
      '>>> com.boardsesh.app.dev <<<',
      '>>> /system/bin/surfaceflinger <<<',
    );
    expect(findAndroidNativeCrashes(systemCrash, 'com.boardsesh.app.dev')).toEqual([]);
  });

  it('counts an uncaught JVM exception in the app process', () => {
    const jvmCrash = [
      '10-05 08:29:42.700   600   640 I ActivityManager: Start proc 6001:com.boardsesh.app.dev/u0a215 for top-activity',
      '10-05 08:29:50.000  6001  6050 E AndroidRuntime: FATAL EXCEPTION: mqt_v_js',
    ].join('\n');
    expect(findAndroidNativeCrashes(jvmCrash, 'com.boardsesh.app.dev')).toHaveLength(1);
  });

  it('reports nothing for a clean log', () => {
    expect(
      findAndroidNativeCrashes(LAUNCH_CRASH_LOGCAT.split('\n').slice(0, 2).join('\n'), 'com.boardsesh.app.dev'),
    ).toEqual([]);
  });
});

describe('findIosNativeCrashes', () => {
  const exitLine = (signal: string) =>
    `2026-10-06 00:18:48.912 Df SpringBoard[80966:a1da12] [com.apple.FrontBoard:Process] [app<com.boardsesh.app>:85886] Process exited: <RBSProcessExitContext| specific, status:<RBSProcessExitStatus| domain:signal(2) code:${signal}>>.`;

  it('counts an exit on a fatal signal', () => {
    expect(findIosNativeCrashes(exitLine('SIGSEGV(11)'))).toHaveLength(1);
    expect(findIosNativeCrashes(exitLine('SIGABRT(6)'))).toHaveLength(1);
  });

  it('does not count the exits simctl terminate causes, or the echoed predicate', () => {
    expect(findIosNativeCrashes(exitLine('SIGKILL(9)'))).toEqual([]);
    expect(findIosNativeCrashes(exitLine('SIGTERM(15)'))).toEqual([]);
    expect(findIosNativeCrashes('Filtering the log data using "... Process exited ..."')).toEqual([]);
  });
});

const CLEAN: SmokeEvidence = {
  nativeCrashes: [],
  reachedHome: true,
  backendProblems: [],
  pingProblems: { errors: [], content: [] },
  maestroStatus: 0,
  captureLogProblems: [],
};
const CRASH = { headline: 'Fatal signal 11 (SIGSEGV)', frames: [], secondsAfterStart: 18.2 };

describe('classifySmokeFailure', () => {
  it('passes clean evidence', () => {
    expect(classifySmokeFailure(CLEAN)).toBeNull();
  });

  it('calls a crash before home, with no replay miss, a native crash at launch', () => {
    expect(classifySmokeFailure({ ...CLEAN, nativeCrashes: [CRASH], reachedHome: false, maestroStatus: null })).toBe(
      'native-crash-at-launch',
    );
  });

  it('does not excuse a crash after home, or one beside a replay miss', () => {
    expect(classifySmokeFailure({ ...CLEAN, nativeCrashes: [CRASH], maestroStatus: 1 })).toBe('native-crash');
    expect(
      classifySmokeFailure({ ...CLEAN, nativeCrashes: [CRASH], reachedHome: false, backendProblems: ['MISS graphql'] }),
    ).toBe('native-crash');
  });

  it('names the cause rather than its consequences', () => {
    const missingPing = { errors: [], content: ['no content-ready ping from /profile'] };
    expect(
      classifySmokeFailure({ ...CLEAN, maestroStatus: 1, pingProblems: { errors: ['boom'], content: ['x'] } }),
    ).toBe('js-error');
    expect(classifySmokeFailure({ ...CLEAN, backendProblems: ['MISS'], pingProblems: missingPing })).toBe(
      'replay-miss',
    );
    expect(classifySmokeFailure({ ...CLEAN, reachedHome: false, maestroStatus: null })).toBe('no-home');
    expect(classifySmokeFailure({ ...CLEAN, maestroStatus: 1, pingProblems: missingPing })).toBe('flow');
    expect(classifySmokeFailure({ ...CLEAN, pingProblems: missingPing })).toBe('no-content');
    expect(classifySmokeFailure({ ...CLEAN, captureLogProblems: ['no render line'] })).toBe('capture-log');
  });
});

describe('replayProblemsForSmoke', () => {
  const miss = 'MISS graphql GetBoard';

  it('does not hold the silence of an app that never got home against the recorded set', () => {
    expect(replayProblemsForSmoke([NO_GRAPHQL_HIT_PROBLEM], false)).toEqual([]);
    // So a crash before home, with nothing else wrong, keeps its own class.
    expect(
      classifySmokeFailure({
        ...CLEAN,
        nativeCrashes: [CRASH],
        reachedHome: false,
        maestroStatus: null,
        backendProblems: replayProblemsForSmoke([NO_GRAPHQL_HIT_PROBLEM], false),
      }),
    ).toBe('native-crash-at-launch');
  });

  it('keeps a real miss, and keeps the silence once the app did get home', () => {
    expect(replayProblemsForSmoke([miss, NO_GRAPHQL_HIT_PROBLEM], false)).toEqual([miss]);
    expect(replayProblemsForSmoke([NO_GRAPHQL_HIT_PROBLEM], true)).toEqual([NO_GRAPHQL_HIT_PROBLEM]);
  });
});

describe('the one fresh-boot retry', () => {
  const attempt = (failureClass: SmokeAttempt['failureClass']): SmokeAttempt => ({
    failureClass,
    problems: [],
    pings: [],
  });

  it('is earned by a launch crash on the first attempt only', () => {
    expect(shouldRetrySmoke([attempt('native-crash-at-launch')])).toBe(true);
    expect(shouldRetrySmoke([attempt('native-crash-at-launch'), attempt('native-crash-at-launch')])).toBe(false);
  });

  it.each([
    'native-crash',
    'js-error',
    'replay-miss',
    'no-home',
    'flow',
    'no-content',
    'capture-log',
    'setup',
  ] as const)('is not earned by %s', (failureClass) => {
    expect(shouldRetrySmoke([attempt(failureClass)])).toBe(false);
  });

  it('keeps counting the launch crash in a result the retry recovered', () => {
    const result = buildSmokeResult('android', [attempt('native-crash-at-launch'), attempt(null)]);
    expect(result).toMatchObject({ passed: true, failureClass: null, nativeCrashAtLaunchCount: 1 });
    expect(renderSmokeSummary(result)).toContain('- Attempt 1: native crash at launch.');
  });

  it('reports the last attempt as the failure class', () => {
    const result = buildSmokeResult('ios', [attempt('native-crash-at-launch'), attempt('no-content')]);
    expect(result).toMatchObject({ passed: false, failureClass: 'no-content', nativeCrashAtLaunchCount: 1 });
  });

  it('is not a pass when nothing was judged', () => {
    expect(buildSmokeResult('ios', []).passed).toBe(false);
  });
});

describe('--flow smoke', () => {
  it('is an accepted flow, on one phone in en-US unless told otherwise', () => {
    const options = parseArgs(['--flow', 'smoke', '--platform', 'ios']);
    expect(options.flow).toBe('smoke');
    expect(options.devices).toEqual(['iPhone 16 Pro Max']);
    expect(options.appLocales).toEqual(['en-US']);
    expect(parseArgs(['--flow', 'smoke', '--locales', 'fr']).appLocales).toEqual(['fr']);
  });

  it('refuses to run both platforms in one invocation', () => {
    expect(() => parseArgs(['--flow', 'smoke', '--platform', 'all'])).toThrow(/one platform per invocation/);
  });

  it('gives the bundle the smoke ping URL, and only for the smoke', () => {
    const smoke = buildScreenshotEnv(parseArgs(['--flow', 'smoke']), { NODE_ENV: 'test' });
    expect(smoke.EXPO_PUBLIC_SCREENSHOT_SMOKE_URL).toBe(`http://localhost:${SCREENSHOT_READY_PORT}/smoke`);
    const store = buildScreenshotEnv(parseArgs(['--flow', 'app-store']), { NODE_ENV: 'test' });
    expect(store.EXPO_PUBLIC_SCREENSHOT_SMOKE_URL).toBeUndefined();
  });

  it('writes its result where the workflow says, defaulting under .boardsesh', () => {
    expect(smokeResultPath({ NODE_ENV: 'test', SMOKE_RESULT_PATH: '/tmp/result.json' })).toBe('/tmp/result.json');
    expect(smokeResultPath({ NODE_ENV: 'test' })).toMatch(/\.boardsesh\/smoke-result\.json$/);
  });
});
