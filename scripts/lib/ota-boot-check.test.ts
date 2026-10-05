/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  androidEasClientPrefsXml,
  BOOT_CHECK_CLIENT_IDS,
  checkBinary,
  evidenceFromCapture,
  expectationFromReceipt,
  findFatalLogLines,
  formatVerdict,
  judgeBoot,
  parseUpdateRows,
  parseUpdatesLog,
  pinAndroidManifest,
  readEmbeddedManifest,
  readServedHead,
  resolveExpectedUpdate,
  sha256HexToBase64Url,
  updatesLogSince,
} from './ota-boot-check';
import type { BootCapture, BootPlatform, ServedHead } from './ota-boot-check';

/**
 * Captures written by real runs of scripts/mobile-ota-boot-check.ts: the
 * `updates` table as sqlite3 printed it, and expo-updates' own log.
 *
 *   *-green   the head of pr-staging for main commit 042b342 (2026-10-05), on an
 *             iOS 26.5 simulator and an Android 16 emulator.
 *   *-red     the per-PR preview of #6129, whose root layout throws while its
 *             module loads.
 */
const FIXTURES = resolve(import.meta.dirname, '..', '__tests__', 'fixtures', 'ota-boot-check');

function loadCapture(name: string): BootCapture {
  const file = JSON.parse(readFileSync(join(FIXTURES, `${name}.capture.json`), 'utf8')) as { capture: BootCapture };
  return file.capture;
}

const COMMIT = '042b342adb84c91a3cc43f9ab408809c35365016';
const IOS_RUNTIME = 'b71bdb600c5a3e954d75c9ca673f056c62247ea9';
const BUNDLE_SHA256 = 'f58ecfaade1267b101d065747d3b233d1437abce3e66f0cefc6a888949244829';
const stageReceipt = {
  commitHash: COMMIT,
  message: 'fix(mobile): something',
  platforms: {
    ios: { runtimeVersion: IOS_RUNTIME, bundleSha256: BUNDLE_SHA256 },
    android: { runtimeVersion: '154bc941c504727afc914057aed2edff2c096576', bundleSha256: 'a'.repeat(64) },
  },
};
const servedHead: ServedHead = {
  id: 'c2d9ef81-43d1-9991-0283-e06ae6dd62c7',
  createdAt: '2026-10-05T11:51:01.000Z',
  runtimeVersion: IOS_RUNTIME,
  branch: 'pr-staging',
  launchAssetHash: sha256HexToBase64Url(BUNDLE_SHA256),
  assetCount: 388,
};

describe('which update is under test', () => {
  it('reads a stage receipt and ties it to the commit', () => {
    expect(expectationFromReceipt(stageReceipt, 'ios', COMMIT)).toEqual({
      commit: COMMIT,
      runtimeVersion: IOS_RUNTIME,
      bundleSha256: BUNDLE_SHA256,
      updateId: null,
    });
  });

  it('refuses a receipt for another commit, or one that names no update', () => {
    expect(() => expectationFromReceipt(stageReceipt, 'ios', 'f'.repeat(40))).toThrow('not the commit under test');
    expect(() => expectationFromReceipt(stageReceipt, 'ios', 'main')).toThrow('40-character commit SHA');
    const nameless = { commitHash: COMMIT, platforms: { ios: { runtimeVersion: IOS_RUNTIME } } };
    expect(() => expectationFromReceipt(nameless, 'ios', COMMIT)).toThrow('nothing ties it to a commit');
    expect(() => expectationFromReceipt({ commitHash: COMMIT, platforms: {} }, 'android', COMMIT)).toThrow(
      'Receipt android entry must be an object',
    );
  });

  it('reads the fields it needs out of a served manifest', () => {
    expect(
      readServedHead({
        id: 'C2D9EF81-43D1-9991-0283-E06AE6DD62C7',
        createdAt: '2026-10-05T11:51:01.000Z',
        runtimeVersion: IOS_RUNTIME,
        launchAsset: { hash: servedHead.launchAssetHash },
        assets: Array.from({ length: 388 }, () => ({})),
        extra: { branch: 'pr-staging', expoClient: {} },
      }),
    ).toEqual(servedHead);
  });

  it('accepts the branch head when its bundle is the staged one', () => {
    const expected = resolveExpectedUpdate(
      expectationFromReceipt(stageReceipt, 'ios', COMMIT),
      servedHead,
      'pr-staging',
    );
    expect(expected).toEqual({ ok: true, updateId: servedHead.id, head: servedHead });
  });

  it('fails, with the reason, when the branch is not serving the commit', () => {
    const expectation = expectationFromReceipt(stageReceipt, 'ios', COMMIT);
    const reasonFor = (served: ServedHead | null, branch = 'pr-staging'): string => {
      const expected = resolveExpectedUpdate(expectation, served, branch);
      return expected.ok ? 'accepted' : expected.reason;
    };

    expect(reasonFor(null)).toContain('no update at all');
    // What the live server answers for a branch with nothing on this runtime.
    expect(reasonFor({ ...servedHead, branch: 'production' })).toContain('answered from production');
    expect(reasonFor({ ...servedHead, runtimeVersion: 'c'.repeat(40) })).toContain('answered with runtime');
    expect(reasonFor({ ...servedHead, launchAssetHash: sha256HexToBase64Url('b'.repeat(64)) })).toContain(
      'its bundle is not the one staged for commit',
    );

    const byId = expectationFromReceipt(
      {
        commitHash: COMMIT,
        platforms: { ios: { runtimeVersion: IOS_RUNTIME, updateId: 'd'.repeat(8) + servedHead.id.slice(8) } },
      },
      'ios',
      COMMIT,
    );
    const mismatch = resolveExpectedUpdate(byId, servedHead, 'pr-staging');
    expect(mismatch.ok ? 'accepted' : mismatch.reason).toContain(`is update ${servedHead.id}`);
  });
});

describe('the binary', () => {
  const expectation = expectationFromReceipt(stageReceipt, 'ios', COMMIT);
  const publishedAtMs = Date.parse(servedHead.createdAt);
  const embedded = { embeddedUpdateId: '4f2ebe91-b04a-456a-84a8-a28e61bab715' };

  it('accepts a binary of the same runtime whose embedded bundle is older than the update', () => {
    expect(
      checkBinary(
        { ...embedded, runtimeVersion: IOS_RUNTIME, embeddedCommitTimeMs: publishedAtMs - 1 },
        expectation,
        servedHead,
      ),
    ).toBeNull();
    // An APK's manifest is compiled, so its runtime version is not checked here.
    expect(
      checkBinary(
        { ...embedded, runtimeVersion: null, embeddedCommitTimeMs: publishedAtMs - 1 },
        expectation,
        servedHead,
      ),
    ).toBeNull();
  });

  it('refuses a binary that would never be offered the update', () => {
    expect(
      checkBinary({ ...embedded, runtimeVersion: 'c'.repeat(40), embeddedCommitTimeMs: 0 }, expectation, servedHead),
    ).toContain('bakes runtime version');
    // Measured during the spike: a binary built from main's head, committed ten
    // minutes after the update was published, answered "no update available".
    expect(
      checkBinary(
        { ...embedded, runtimeVersion: IOS_RUNTIME, embeddedCommitTimeMs: 1791201711000 },
        expectation,
        servedHead,
      ),
    ).toContain('expo-updates would not download it');
  });

  it('reads the embedded bundle out of app.manifest', () => {
    expect(
      readEmbeddedManifest('{"id":"4F2EBE91-B04A-456A-84A8-A28E61BAB715","commitTime":1791150000000,"assets":[]}'),
    ).toEqual({
      embeddedUpdateId: '4f2ebe91-b04a-456a-84a8-a28e61bab715',
      embeddedCommitTimeMs: 1791150000000,
    });
    expect(() => readEmbeddedManifest('{"id":"x"}')).toThrow('no commitTime');
  });

  it('pins a generated Android manifest to a branch, once', () => {
    const generated =
      '<meta-data android:name="expo.modules.updates.UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY" ' +
      'android:value="{&quot;expo-app-id&quot;:&quot;007e6fd7-f200-448c-9449-8d48ba5d51fc&quot;,' +
      '&quot;expo-channel-name&quot;:&quot;production&quot;,&quot;xprem-branch&quot;:&quot;&quot;}"/>';
    const pinned = pinAndroidManifest(generated, 'pr-staging');
    expect(pinned).toContain('&quot;xprem-branch&quot;:&quot;pr-staging&quot;}');
    expect(() => pinAndroidManifest(pinned, 'pr-beta')).toThrow('found 0');
    expect(() => pinAndroidManifest(generated, 'pr staging"')).toThrow('Branch name is not valid');
  });

  it('seeds one fixed device id per platform', () => {
    expect(BOOT_CHECK_CLIENT_IDS.ios).not.toBe(BOOT_CHECK_CLIENT_IDS.android);
    for (const clientId of Object.values(BOOT_CHECK_CLIENT_IDS)) {
      expect(clientId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(androidEasClientPrefsXml(BOOT_CHECK_CLIENT_IDS.android)).toContain(
      `<string name="eas-client-id">${BOOT_CHECK_CLIENT_IDS.android}</string>`,
    );
  });
});

describe.each(['ios', 'android'] as const)('a real %s run that booted', (platform: BootPlatform) => {
  const capture = loadCapture(`${platform}-green`);
  const evidence = evidenceFromCapture(capture);

  it('parses the updates table the device left behind', () => {
    expect(evidence.afterSecondLaunch.map((row) => row.id)).toEqual([
      capture.embeddedUpdateId,
      capture.expectedUpdateId,
    ]);
    const update = evidence.afterSecondLaunch[1];
    expect(update.ready).toBe(true);
    expect(update.headers).toEqual({
      'expo-app-id': '007e6fd7-f200-448c-9449-8d48ba5d51fc',
      'expo-channel-name': 'production',
      'xprem-branch': 'pr-staging',
    });
  });

  it('passes', () => {
    const verdict = judgeBoot(evidence);
    expect(verdict).toMatchObject({
      passed: true,
      launchedUpdateId: capture.expectedUpdateId,
      embeddedLaunch: false,
      emergencyLaunch: false,
      failures: [],
    });
    expect(formatVerdict(platform, 'pr-staging', evidence, verdict)).toContain(
      `PASS: ${platform} boot check on pr-staging`,
    );
  });

  it('fails when the second launch ran the embedded bundle', () => {
    // The same run, as it would read had the update been skipped at launch.
    const rows = parseUpdateRows(capture.updatesAfterSecondLaunch);
    const stayedOnEmbedded = rows.map((row) =>
      row.id === capture.embeddedUpdateId
        ? {
            ...row,
            lastAccessed: capture.secondLaunchStartedAtMs + 500,
            successfulLaunchCount: row.successfulLaunchCount + 1,
          }
        : { ...row, lastAccessed: capture.secondLaunchStartedAtMs - 60_000, successfulLaunchCount: 0 },
    );
    const verdict = judgeBoot({ ...evidence, afterSecondLaunch: stayedOnEmbedded });
    expect(verdict).toMatchObject({ passed: false, embeddedLaunch: true, launchedUpdateId: capture.embeddedUpdateId });
    expect(verdict.failures.join('\n')).toContain('ran the embedded bundle');
  });

  it('fails when nothing was launched from the database, which is what an emergency launch leaves', () => {
    const verdict = judgeBoot({ ...evidence, afterSecondLaunch: evidence.afterFirstLaunch });
    expect(verdict).toMatchObject({ passed: false, emergencyLaunch: true, launchedUpdateId: null });
  });

  it('fails when the update never reached the disk', () => {
    const embeddedOnly = evidence.afterFirstLaunch.filter((row) => row.id === capture.embeddedUpdateId);
    const verdict = judgeBoot({ ...evidence, afterFirstLaunch: embeddedOnly, afterSecondLaunch: embeddedOnly });
    expect(verdict.passed).toBe(false);
    expect(verdict.failures[0]).toContain('did not leave update');
  });

  it('fails when the process died or the device log has a crash line, even with the update launched', () => {
    expect(judgeBoot({ ...evidence, processAliveAtEnd: false }).failures).toEqual([
      "The app's process was gone 30s after the second launch.",
    ]);
    expect(judgeBoot({ ...evidence, fatalLogLines: ['FATAL EXCEPTION: main'] }).failures).toEqual([
      'The device log has 1 crash line(s).',
    ]);
  });
});

describe.each([
  { platform: 'ios', ranInstead: 'another update' },
  { platform: 'android', ranInstead: 'the embedded bundle' },
] as const)('a real $platform run of an update that throws at startup', ({ platform, ranInstead }) => {
  const capture = loadCapture(`${platform}-red`);
  const evidence = evidenceFromCapture(capture);
  const verdict = judgeBoot(evidence);

  it('fails', () => {
    expect(verdict.passed).toBe(false);
    expect(verdict.secondsToFirstScreen).toBeNull();
    expect(verdict.launchedUpdateId).not.toBe(capture.expectedUpdateId);
  });

  it('says the update was downloaded, launched, and failed', () => {
    const broken = evidence.afterSecondLaunch.find((row) => row.id === capture.expectedUpdateId);
    expect(broken).toMatchObject({ ready: true, successfulLaunchCount: 0, failedLaunchCount: 1 });
    // expo-updates' error recovery then put something else on screen: the
    // embedded bundle on Android, an update the server fell back to on iOS.
    expect(verdict.failures).toEqual([
      expect.stringContaining(`The second launch ran ${ranInstead}`),
      `expo-updates recorded 1 failed launch(es) of ${capture.expectedUpdateId}: its JS threw before the first screen.`,
      expect.stringMatching(/^The device log has \d+ crash line\(s\)\.$/),
    ]);
    expect(verdict.embeddedLaunch).toBe(platform === 'android');
  });

  it('carries the thrown error in the evidence', () => {
    expect(capture.fatalLogLines.length).toBeGreaterThan(0);
    expect(evidence.updatesLogErrors.length).toBeGreaterThan(0);
    const report = formatVerdict(platform, 'pr-6129', evidence, verdict);
    expect(report).toContain(`FAIL: ${platform} boot check on pr-6129`);
    expect(report).toContain('first screen      never drawn');
  });
});

describe('logs', () => {
  it('reads expo-updates log lines with and without the level marker', () => {
    const ios =
      '🟢 {"timestamp":1791207574000,"message":"AppController sharedInstance created","level":"info","code":"None"}';
    const android =
      '{"timestamp":1791207631259,"message":"UpdatesController onBackgroundUpdateFinished: No update available","code":"NoUpdatesAvailable","level":"info"}';
    expect(parseUpdatesLog(`${ios}\nnot a log line\n${android}\n`)).toEqual([
      {
        timestamp: 1791207574000,
        level: 'info',
        code: 'None',
        message: 'AppController sharedInstance created',
        updateId: null,
      },
      {
        timestamp: 1791207631259,
        level: 'info',
        code: 'NoUpdatesAvailable',
        message: 'UpdatesController onBackgroundUpdateFinished: No update available',
        updateId: null,
      },
    ]);
  });

  it('keeps only the second launch, without the per-asset lines', () => {
    const lines = [
      '{"timestamp":1000,"message":"first launch","code":"None","level":"info"}',
      '{"timestamp":5000,"message":"AppController appLoaderTask didLoadAsset: [...]","code":"None","level":"info"}',
      '{"timestamp":5000,"message":"embeddedAssetFileMap: 96032e,ttf => file:///android_res/raw/x.ttf","code":"None","level":"info"}',
      '{"timestamp":5000,"message":"second launch","code":"None","level":"info"}',
    ];
    expect(updatesLogSince(lines.join('\n'), 4000)).toBe(lines[3]);
  });

  it('picks crash lines out of a device log and leaves ordinary errors alone', () => {
    const androidLog = [
      '10-06 00:40:29.669  5012  5012 I ReactNativeJS: Running "main"',
      '10-06 00:40:30.101  5012  5046 E AndroidRuntime: FATAL EXCEPTION: mqt_v_js',
      '10-06 00:40:30.101  5012  5046 E AndroidRuntime: com.facebook.react.common.JavascriptException: Error: boom',
      '10-06 00:40:30.300  5012  5012 E SQLiteLog: (1) no such table: x',
    ].join('\n');
    expect(findFatalLogLines('android', androidLog)).toHaveLength(2);
    const iosLog = [
      '2026-10-06 00:30:17.053 Df Boardsesh[59466:a4efed] [com.apple.xpc:connection] failed to do a bootstrap look-up: xpc_error=[3: No such process]',
      '2026-10-06 00:30:17.978 Df Boardsesh[59466:a4efe5] [com.apple.CFNetwork:Default] Task finished with error [-999]',
      'EXC_CRASH report written: Boardsesh-2026-10-06-003018.ips',
    ].join('\n');
    expect(findFatalLogLines('ios', iosLog)).toEqual(['EXC_CRASH report written: Boardsesh-2026-10-06-003018.ips']);
  });
});
