/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { APP_CONFIG_PATH, BOT_EMAIL, BOT_NAME } from './lib/mobile-release-version';
import {
  NATIVE_BASELINE_TAG,
  coordinateNativeSnapshots,
  exactNativeBuilds,
  nativeRecoveryDecision,
  nativeReleaseMessage,
  nextNativeVersion,
  parseNativeReleaseMetadata,
  publishNativeBaseline,
  replaceNativeVersion,
  sameNativeFingerprints,
  type NativeBuildRun,
  type NativeCoordinatorRuntime,
  type NativeStamp,
} from './lib/native-release';
import { validateNativeStampSource } from './mobile-native-release';

const fingerprints = { ios: 'a'.repeat(40), android: 'b'.repeat(40) };
const stamp: NativeStamp = { ...fingerprints, sourceSha: 'c'.repeat(40), sha: 'd'.repeat(40), version: '2.7.1' };
const nativeRun: NativeBuildRun = {
  id: 10,
  title: `ios:${stamp.sha}`,
  status: 'completed',
  conclusion: 'failure',
  createdAt: '2026-11-01T10:00:00Z',
};
const now = Date.parse('2026-11-01T12:00:00Z');
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('main native release snapshots', () => {
  it('rejects a failed baseline push with no remote tag, even if a local candidate exists', () => {
    const runtime = {
      push: vi.fn(() => {
        throw new Error('push failed');
      }),
      remoteObject: vi.fn(() => null),
    };
    expect(() => publishNativeBaseline(stamp.sha, runtime)).toThrow('No baseline publication was confirmed');
    expect(runtime.remoteObject).toHaveBeenCalledTimes(1);
  });

  it('accepts a lost baseline push response only when the exact annotated object is remote', () => {
    expect(() =>
      publishNativeBaseline(stamp.sha, {
        push: () => {
          throw new Error('response lost after acceptance');
        },
        remoteObject: () => stamp.sha,
      }),
    ).not.toThrow();
    expect(() =>
      publishNativeBaseline(stamp.sha, {
        push: () => {
          throw new Error('response lost');
        },
        remoteObject: () => stamp.sourceSha,
      }),
    ).toThrow('exact annotated native baseline');
  });

  it('round trips full baseline and stamp provenance', () => {
    const baseline = { ...fingerprints, sourceSha: stamp.sourceSha };
    expect(parseNativeReleaseMetadata(nativeReleaseMessage(baseline, 'baseline'), 'baseline')).toEqual(baseline);
    expect(parseNativeReleaseMetadata(nativeReleaseMessage(stamp, 'version-bump'), 'version-bump')).toEqual({
      ...baseline,
      version: stamp.version,
    });
    expect(NATIVE_BASELINE_TAG).toBe('release/native-baseline');
  });

  it('rejects duplicate provenance and abbreviated native fingerprints', () => {
    const message = nativeReleaseMessage(stamp, 'version-bump');
    expect(() => parseNativeReleaseMetadata(`${message}Native-Source: ${stamp.sourceSha}\n`, 'version-bump')).toThrow(
      'exactly one',
    );
    expect(() => parseNativeReleaseMetadata(message.replace(fingerprints.ios, 'abc123'), 'version-bump')).toThrow(
      'full',
    );
    expect(() => parseNativeReleaseMetadata(message, 'baseline')).toThrow('baseline');
  });

  it('takes the next unused shared patch while preserving the merged minor version', () => {
    expect(nextNativeVersion('2.7.0', ['build-ios-v2.7.0-8-aaaaaaaaaaaa', 'release/ios-v2.6.0-cccccccccccc'])).toBe(
      '2.7.1',
    );
    expect(nextNativeVersion('2.7.1', ['build-android-v2.7.3-2000100-bbbbbbbbbbbb'])).toBe('2.7.4');
    expect(nextNativeVersion('3.0.0', ['release/android-v2.9.9-bbbbbbbbbbbb'])).toBe('3.0.1');
    expect(() => nextNativeVersion('2.0.9007199254740991', [])).toThrow('overflow');
  });

  it('changes only one literal version and compares both full platform fingerprints', () => {
    const source = "export default {\n  version: '2.7.0',\n  name: 'Boardsesh',\n};\n";
    expect(replaceNativeVersion(source, '2.7.1')).toBe(source.replace('2.7.0', '2.7.1'));
    expect(() => replaceNativeVersion(`${source}\nversion: '2.7.0',`, '2.7.1')).toThrow('exactly one');
    expect(sameNativeFingerprints(fingerprints, fingerprints)).toBe(true);
    expect(sameNativeFingerprints(fingerprints, { ...fingerprints, android: 'e'.repeat(40) })).toBe(false);
  });

  it('requires the exact source, marketing version and fingerprint to suppress a platform build', () => {
    const expected = { tag: 'build-ios-v2.7.1-9-aaaaaaaaaaaa', sha: stamp.sha };
    expect(
      exactNativeBuilds(
        [
          expected,
          { ...expected, sha: stamp.sourceSha },
          { tag: 'build-ios-v2.7.0-8-aaaaaaaaaaaa', sha: stamp.sha },
          { tag: 'build-ios-v2.7.1-10-eeeeeeeeeeee', sha: stamp.sha },
        ],
        'ios',
        stamp,
      ),
    ).toEqual([expected]);
  });

  it('replans after a concurrent main push without force-pushing a stale stamp', () => {
    const runtime: NativeCoordinatorRuntime = {
      prepare: vi
        .fn()
        .mockReturnValueOnce({ mainSha: stamp.sourceSha, stampSha: stamp.sha, previousStamp: null })
        .mockReturnValueOnce({ mainSha: 'e'.repeat(40), stampSha: 'f'.repeat(40), previousStamp: null }),
      push: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('non-fast-forward');
        })
        .mockImplementationOnce(() => undefined),
      committed: vi.fn(() => false),
      recover: vi.fn(),
    };
    expect(coordinateNativeSnapshots(runtime)).toEqual({ changed: true, sourceSha: 'f'.repeat(40) });
    expect(runtime.push).toHaveBeenCalledTimes(2);
    expect(runtime.prepare).toHaveBeenCalledTimes(2);
  });

  it('treats a lost successful push response as committed without consuming another patch', () => {
    const runtime: NativeCoordinatorRuntime = {
      prepare: vi.fn(() => ({ mainSha: stamp.sourceSha, stampSha: stamp.sha, previousStamp: null })),
      push: vi.fn(() => {
        throw new Error('connection reset after acceptance');
      }),
      committed: vi.fn(() => true),
      recover: vi.fn(),
    };
    expect(coordinateNativeSnapshots(runtime)).toEqual({ changed: true, sourceSha: stamp.sha });
    expect(runtime.prepare).toHaveBeenCalledTimes(1);
    expect(runtime.push).toHaveBeenCalledTimes(1);
  });

  it('recovers unchanged snapshots and does not write during a plan', () => {
    const runtime: NativeCoordinatorRuntime = {
      prepare: vi.fn(() => ({ mainSha: 'e'.repeat(40), stampSha: null, previousStamp: stamp })),
      push: vi.fn(),
      committed: vi.fn(),
      recover: vi.fn(),
    };
    expect(coordinateNativeSnapshots(runtime, true)).toEqual({ changed: false, sourceSha: stamp.sha });
    expect(runtime.recover).toHaveBeenCalledWith(stamp, true);
    expect(runtime.push).not.toHaveBeenCalled();
    vi.mocked(runtime.prepare).mockReturnValue({ mainSha: stamp.sourceSha, stampSha: stamp.sha, previousStamp: null });
    expect(coordinateNativeSnapshots(runtime, true)).toEqual({ changed: true, sourceSha: stamp.sha });
    expect(runtime.push).not.toHaveBeenCalled();
  });
});

describe('native tester build recovery', () => {
  const input = { platform: 'ios' as const, stamp, taggedBuilds: [], runs: [nativeRun], now };
  it('recovers failed builds before upload while preserving the same stamped source', () => {
    expect(nativeRecoveryDecision(input).action).toBe('dispatch');
    expect(nativeRecoveryDecision({ ...input, uploadAttempted: true })).toMatchObject({
      action: 'inspect',
      runId: nativeRun.id,
    });
  });
  it('waits for active or recently deferred builds rather than creating a tight retry loop', () => {
    expect(nativeRecoveryDecision({ ...input, runs: [{ ...nativeRun, status: 'pending' }] }).action).toBe('wait');
    expect(nativeRecoveryDecision({ ...input, now: Date.parse('2026-11-01T10:30:00Z') }).action).toBe('wait');
  });
  it('ignores unrelated raw main runs and stops once the exact upload is tagged', () => {
    expect(
      nativeRecoveryDecision({ ...input, runs: [{ ...nativeRun, title: `ios:${'f'.repeat(40)}`, status: 'queued' }] })
        .action,
    ).toBe('dispatch');
    expect(
      nativeRecoveryDecision({
        ...input,
        uploadAttempted: true,
        taggedBuilds: [{ tag: 'build-ios-v2.7.1-9-aaaaaaaaaaaa', sha: stamp.sha }],
      }).action,
    ).toBe('done');
  });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'native-stamp-test-'));
  temporaryDirectories.push(directory);
  const git = (argumentsList: string[], environment: NodeJS.ProcessEnv = {}) =>
    execFileSync('git', argumentsList, {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git(['init', '--quiet']);
  git(['config', 'user.name', 'Tester']);
  git(['config', 'user.email', 'tester@example.com']);
  mkdirSync(join(directory, 'packages/mobile'), { recursive: true });
  writeFileSync(join(directory, APP_CONFIG_PATH), "export default {\n  version: '2.7.0',\n  name: 'Boardsesh',\n};\n");
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'native source']);
  const sourceSha = git(['rev-parse', 'HEAD']);
  const commit = (options: { extraFile?: boolean; author?: string; forgedVersion?: string } = {}) => {
    writeFileSync(
      join(directory, APP_CONFIG_PATH),
      "export default {\n  version: '2.7.1',\n  name: 'Boardsesh',\n};\n",
    );
    if (options.extraFile) writeFileSync(join(directory, 'unrelated.txt'), 'not a version bump\n');
    git(['add', '.']);
    git(
      [
        'commit',
        '--quiet',
        '-m',
        nativeReleaseMessage({ ...fingerprints, sourceSha, version: options.forgedVersion ?? '2.7.1' }, 'version-bump'),
      ],
      {
        GIT_AUTHOR_NAME: options.author ?? BOT_NAME,
        GIT_AUTHOR_EMAIL: BOT_EMAIL,
      },
    );
    return git(['rev-parse', 'HEAD']);
  };
  return { directory, git, sourceSha, commit };
}

describe('real git native stamp provenance', () => {
  it('accepts the version-only bot stamp after later raw native or JS main commits', () => {
    const repository = fixture();
    const source = repository.commit();
    writeFileSync(join(repository.directory, 'later-native.txt'), 'a later raw merge has no stamp yet\n');
    repository.git(['add', '.']);
    repository.git(['commit', '--quiet', '-m', 'later native merge']);
    const mainSha = repository.git(['rev-parse', 'HEAD']);
    expect(validateNativeStampSource(source, mainSha, repository.directory)).toMatchObject({
      sha: source,
      sourceSha: repository.sourceSha,
      version: '2.7.1',
      ...fingerprints,
    });
  });
  it.each([
    [{ extraFile: true }, 'only the app version'],
    [{ author: 'Impersonator' }, 'unexpected author'],
    [{ forgedVersion: '2.7.2' }, 'version'],
  ] as const)('rejects invalid stamp provenance %j', (options, message) => {
    const repository = fixture();
    const source = repository.commit(options);
    expect(() => validateNativeStampSource(source, source, repository.directory)).toThrow(message);
  });
  it('rejects a stamp not yet merged into main', () => {
    const repository = fixture();
    const source = repository.commit();
    expect(() => validateNativeStampSource(source, repository.sourceSha, repository.directory)).toThrow('ancestor');
  });
});

describe('native release workflow boundaries', () => {
  const coordinator = parse(readFileSync('.github/workflows/mobile-native-release.yml', 'utf8'));
  const ios = parse(readFileSync('.github/workflows/ios-testflight-rn.yml', 'utf8'));
  const android = parse(readFileSync('.github/workflows/android-apk-rn.yml', 'utf8'));

  it('keeps canonical resolver environment identical to the binaries, isolating Maps to Android', () => {
    for (const [name, contents] of Object.entries(ios.env)) expect(coordinator.env[name], name).toEqual(contents);
    expect(coordinator.env.GOOGLE_MAPS_API_KEY).toBeUndefined();
    expect(android.env.GOOGLE_MAPS_API_KEY).toBe('${{ secrets.GOOGLE_MAPS_API_KEY }}');
    const executeStep = coordinator.jobs.coordinate.steps.find(
      (step: { name?: string }) => step.name === 'Plan, stamp, or recover native tester builds',
    );
    expect(executeStep.env.NATIVE_ANDROID_MAPS_KEY).toBe('${{ secrets.GOOGLE_MAPS_API_KEY }}');
  });
  it('allows only main, pins native sources, and keeps public submission outside the coordinator', () => {
    expect(coordinator.on.push.branches).toEqual(['main']);
    expect(coordinator.on.workflow_run.branches).toEqual(['main']);
    expect(coordinator.concurrency).toEqual({ group: 'mobile-native-release', 'cancel-in-progress': false });
    for (const workflow of [ios, android]) {
      expect(workflow.on.push.branches).toEqual(['main']);
      expect(workflow.on.workflow_dispatch.inputs.source_sha.type).toBe('string');
      expect(workflow.jobs.gate.if).toBe("github.ref == 'refs/heads/main'");
      expect(workflow.jobs.gate.outputs.source_sha).toBe('${{ steps.source.outputs.source_sha }}');
      const steps = workflow.jobs.gate.steps as Array<{ name?: string; run?: string; env?: Record<string, string> }>;
      const guardsIndex = steps.findIndex(
        (step) => step.name === 'Preserve trusted release guards before pinning native source',
      );
      expect(guardsIndex).toBeGreaterThanOrEqual(0);
      expect(guardsIndex).toBeLessThan(steps.findIndex((step) => step.name === 'Checkout exact native source'));
      const gate = steps.find((step) => step.name === 'Resolve fingerprint and check for an existing native build');
      expect(gate?.run).toContain('$RUNNER_TEMP/native-release-tools/scripts/mobile-native-release.ts');
      expect(gate?.env?.NATIVE_RELEASE_ROOT).toBe('${{ github.workspace }}');
      expect(JSON.stringify(workflow)).not.toContain('release/next');
    }
    expect(JSON.stringify(coordinator)).not.toContain('mobile-store-submit');
  });
  it('checks backend readiness before the Android tester upload and preserves provenance artifacts', () => {
    const steps = android.jobs['build-and-release'].steps;
    expect(
      steps.findIndex(
        (step: { name?: string }) => step.name === 'Require the live backend schema before tester upload',
      ),
    ).toBeLessThan(steps.findIndex((step: { id?: string }) => step.id === 'play_upload'));
    expect(
      ios.jobs['build-and-upload'].steps.some(
        (step: { with?: { name?: string } }) => step.with?.name === 'native-build-source-${{ github.run_attempt }}',
      ),
    ).toBe(true);
    expect(
      android.jobs['record-candidate'].steps.some(
        (step: { with?: { name?: string } }) => step.with?.name === 'native-build-source-${{ github.run_attempt }}',
      ),
    ).toBe(true);
  });
});
