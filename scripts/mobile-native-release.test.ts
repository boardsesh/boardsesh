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
  nativeGateAdmissionRuns,
  nativeReleaseMessage,
  nextNativeVersion,
  nativeStampKind,
  nativeVersionTagNames,
  planNativeVersion,
  parseNativeReleaseMetadata,
  publishNativeBaseline,
  publishNativeRestoration,
  replaceNativeVersion,
  sameNativeFingerprints,
  type NativeBuildRun,
  type NativeCoordinatorRuntime,
  type NativeStamp,
  type NativeStampKind,
} from './lib/native-release';
import {
  getSupersededNativeStampShas,
  findUploadedNativePlatform,
  nativePlatformBuildDecision,
  nativePlatformHistory,
  prepareNativeVersionRestoration,
  prepareNativeVersionStamp,
  validateNativeStampSource,
  writeNativeStamp,
} from './mobile-native-release';

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

  it('defaults restoration to a read-only plan and confirms a lost successful push without retrying', () => {
    const runtime = {
      push: vi.fn(() => {
        throw new Error('response lost');
      }),
      committed: vi.fn(() => true),
    };
    expect(publishNativeRestoration(stamp.sha, runtime)).toBe(false);
    expect(runtime.push).not.toHaveBeenCalled();
    expect(runtime.committed).not.toHaveBeenCalled();
    expect(publishNativeRestoration(stamp.sha, runtime, true)).toBe(true);
    expect(runtime.push).toHaveBeenCalledTimes(1);
    expect(runtime.committed).toHaveBeenCalledWith(stamp.sha);
    vi.mocked(runtime.committed).mockReturnValue(false);
    expect(() => publishNativeRestoration(stamp.sha, runtime, true)).toThrow('Main moved');
    expect(runtime.push).toHaveBeenCalledTimes(2);
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

  it('adopts an already-raised unreleased version despite same-version tester builds', () => {
    const tester = { tag: 'build-ios-v2.7.0-8-aaaaaaaaaaaa', sha: stamp.sourceSha };
    expect(planNativeVersion('2.7.0', '2.6.0', [tester])).toEqual({ kind: 'version-adoption', version: '2.7.0' });
    expect(
      planNativeVersion('2.7.0', '2.6.0', [{ tag: 'release/ios-v2.7.0-aaaaaaaaaaaa', sha: stamp.sourceSha }]),
    ).toEqual({ kind: 'version-bump', version: '2.7.1' });
    expect(
      planNativeVersion('2.7.0', '2.6.0', [{ tag: 'build-ios-v2.8.0-1-aaaaaaaaaaaa', sha: stamp.sourceSha }]),
    ).toEqual({ kind: 'version-bump', version: '2.8.1' });
  });

  it('keeps the open version for every native change until a store accepts it', () => {
    const testers = [
      { tag: 'build-ios-v2.7.0-9-aaaaaaaaaaaa', sha: stamp.sourceSha },
      { tag: 'build-android-v2.7.0-2001557-bbbbbbbbbbbb', sha: stamp.sourceSha },
      { tag: 'release/ios-v2.6.0-cccccccccccc', sha: 'e'.repeat(40) },
    ];
    // An unsubmitted or in-review 2.7.0 has only tester builds: rebuild it with new build numbers.
    expect(planNativeVersion('2.7.0', '2.7.0', testers)).toEqual({ kind: 'version-adoption', version: '2.7.0' });
    // Either store accepting 2.7.0 cuts its anchor and closes the version.
    for (const anchor of ['release/ios-v2.7.0-aaaaaaaaaaaa', 'release/android-v2.7.0-bbbbbbbbbbbb'])
      expect(planNativeVersion('2.7.0', '2.7.0', [...testers, { tag: anchor, sha: stamp.sourceSha }])).toEqual({
        kind: 'version-bump',
        version: '2.7.1',
      });
    // A live higher reservation still wins over keeping the open version.
    expect(
      planNativeVersion('2.7.0', '2.7.0', [...testers, { tag: 'build-ios-v2.7.1-1-aaaaaaaaaaaa', sha: stamp.sha }]),
    ).toEqual({ kind: 'version-bump', version: '2.7.2' });
    // A main version below the last native stamp is never adopted.
    expect(planNativeVersion('2.6.9', '2.7.0', testers)).toEqual({ kind: 'version-bump', version: '2.7.1' });
  });

  it('ignores only explicitly superseded tester sources when reserving the next patch', () => {
    const bad = { tag: 'build-ios-v2.7.1-1-aaaaaaaaaaaa', sha: stamp.sha };
    const publicAnchor = { tag: 'release/ios-v2.7.1-aaaaaaaaaaaa', sha: stamp.sha };
    const other = { tag: 'build-android-v2.7.3-2000100-aaaaaaaaaaaa', sha: stamp.sourceSha };
    expect(nativeVersionTagNames([bad, publicAnchor, other], [stamp.sha])).toEqual([publicAnchor.tag, other.tag]);
    expect(planNativeVersion('2.7.0', '2.7.0', [bad])).toEqual({ kind: 'version-bump', version: '2.7.2' });
    expect(planNativeVersion('2.7.0', '2.7.0', [bad], [stamp.sha])).toEqual({
      kind: 'version-adoption',
      version: '2.7.0',
    });
    expect(planNativeVersion('2.7.0', '2.7.0', [bad, publicAnchor], [stamp.sha]).version).toBe('2.7.2');
    expect(planNativeVersion('2.7.0', '2.7.0', [bad, other], [stamp.sha]).version).toBe('2.7.4');
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
      currentMain: vi.fn(() => 'e'.repeat(40)),
      committed: vi.fn(() => false),
      recover: vi.fn(),
    };
    expect(coordinateNativeSnapshots(runtime)).toEqual({ changed: true, sourceSha: 'f'.repeat(40) });
    expect(runtime.push).toHaveBeenCalledTimes(2);
    expect(runtime.prepare).toHaveBeenCalledTimes(2);
  });

  it('stops after an unconfirmed push on unchanged main without leaking subprocess output', () => {
    const runtime: NativeCoordinatorRuntime = {
      prepare: vi.fn(() => ({ mainSha: stamp.sourceSha, stampSha: stamp.sha, previousStamp: null })),
      push: vi.fn(() => {
        throw new Error('GH013 repository rule violation; credential-bearing command must stay private');
      }),
      currentMain: vi.fn(() => stamp.sourceSha),
      committed: vi.fn(() => false),
      recover: vi.fn(),
    };
    expect(() => coordinateNativeSnapshots(runtime)).toThrow(
      new Error(
        'Native stamp push failed while main was unchanged. Check repository App credentials and its bypass permissions for every main branch rule. No stamp publication was confirmed.',
      ),
    );
    expect(runtime.committed).toHaveBeenCalledExactlyOnceWith(stamp.sha, stamp.sourceSha);
    expect(runtime.prepare).toHaveBeenCalledTimes(1);
    expect(runtime.push).toHaveBeenCalledTimes(1);
    expect(runtime.recover).not.toHaveBeenCalled();
  });

  it('treats a lost successful push response as committed without consuming another patch', () => {
    const runtime: NativeCoordinatorRuntime = {
      prepare: vi.fn(() => ({ mainSha: stamp.sourceSha, stampSha: stamp.sha, previousStamp: null })),
      push: vi.fn(() => {
        throw new Error('connection reset after acceptance');
      }),
      currentMain: vi.fn(() => stamp.sha),
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
      currentMain: vi.fn(),
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

  it('dispatches empty adoption stamps immediately after a confirmed push, including a lost response', () => {
    const adopted = { ...stamp, kind: 'version-adoption' as const, version: '2.7.0' };
    const runtime: NativeCoordinatorRuntime = {
      prepare: vi.fn(() => ({
        mainSha: stamp.sourceSha,
        stampSha: stamp.sha,
        previousStamp: null,
        immediateRecoveryStamp: adopted,
      })),
      push: vi.fn(() => {
        throw new Error('accepted response lost');
      }),
      currentMain: vi.fn(() => stamp.sha),
      committed: vi.fn(() => true),
      recover: vi.fn(),
    };
    expect(coordinateNativeSnapshots(runtime)).toEqual({ changed: true, sourceSha: stamp.sha });
    expect(runtime.recover).toHaveBeenCalledExactlyOnceWith(adopted, false);
    vi.mocked(runtime.recover).mockClear();
    vi.mocked(runtime.push).mockClear();
    coordinateNativeSnapshots(runtime, true);
    expect(runtime.recover).not.toHaveBeenCalled();
    expect(runtime.push).not.toHaveBeenCalled();
    vi.mocked(runtime.prepare).mockReturnValue({
      mainSha: stamp.sourceSha,
      stampSha: stamp.sha,
      previousStamp: null,
      immediateRecoveryStamp: { ...adopted, sha: stamp.sourceSha },
    });
    expect(() => coordinateNativeSnapshots(runtime)).toThrow('committed stamp');
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
  it('waits for active predecessor builds and inspects uncertain uploads in the same unchanged runtime', () => {
    const predecessorSha = 'e'.repeat(40);
    const predecessorRun = { ...nativeRun, title: `ios:${predecessorSha}` };
    const related = { ...input, runs: [predecessorRun], relatedStampShas: [predecessorSha] };
    expect(nativeRecoveryDecision({ ...related, runs: [{ ...predecessorRun, status: 'in_progress' }] })).toMatchObject({
      action: 'wait',
      runId: predecessorRun.id,
    });
    expect(
      nativeRecoveryDecision({ ...related, uploadAttempted: true, uploadAttemptedRunId: predecessorRun.id }),
    ).toMatchObject({ action: 'inspect', runId: predecessorRun.id });
    expect(nativeRecoveryDecision(related).action).toBe('dispatch');
    expect(nativeRecoveryDecision({ ...input, runs: [{ ...predecessorRun, status: 'in_progress' }] }).action).toBe(
      'dispatch',
    );
  });
  it('admits reruns and older queued workflows while retaining previous-attempt upload inspection', () => {
    const current = { ...nativeRun, status: 'in_progress' };
    const successor = { ...current, id: current.id + 1, status: 'queued' };
    expect(nativeGateAdmissionRuns([current, successor], current.id, 1)).toEqual({
      activeRun: undefined,
      inspectRuns: [],
    });
    expect(nativeGateAdmissionRuns([current, successor], current.id, 2)).toEqual({
      activeRun: undefined,
      inspectRuns: [current],
    });
    const completedSuccessor = { ...successor, status: 'completed' };
    expect(nativeGateAdmissionRuns([current, completedSuccessor], current.id, 2)).toEqual({
      activeRun: undefined,
      inspectRuns: [current, completedSuccessor],
    });
    expect(nativeGateAdmissionRuns([current, completedSuccessor], current.id, 1)).toEqual({
      activeRun: undefined,
      inspectRuns: [completedSuccessor],
    });
    expect(() => nativeGateAdmissionRuns([current], Number.NaN, 1)).toThrow('valid GitHub run ID');
    expect(() => nativeGateAdmissionRuns([current], current.id, 0)).toThrow('valid GitHub run ID');
    const predecessor = { ...current, id: current.id - 1 };
    expect(nativeGateAdmissionRuns([predecessor, current, successor], current.id, 1).activeRun).toEqual(predecessor);
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

function fixture(initialVersion = '2.7.0') {
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
  writeFileSync(
    join(directory, APP_CONFIG_PATH),
    `export default {\n  version: '${initialVersion}',\n  name: 'Boardsesh',\n};\n`,
  );
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

const baselineFingerprints = { ios: 'e'.repeat(40), android: 'f'.repeat(40) };
function nativeHistory() {
  const repository = fixture('2.6.0');
  repository.git([
    'tag',
    '-a',
    NATIVE_BASELINE_TAG,
    '-m',
    nativeReleaseMessage({ ...baselineFingerprints, sourceSha: repository.sourceSha }, 'baseline'),
  ]);
  writeFileSync(
    join(repository.directory, APP_CONFIG_PATH),
    "export default {\n  version: '2.7.0',\n  name: 'Boardsesh',\n};\n",
  );
  writeFileSync(join(repository.directory, 'native.txt'), 'new native runtime\n');
  repository.git(['add', '.']);
  repository.git(['commit', '--quiet', '-m', 'open native 2.7.0 before merging']);
  const sourceSha = repository.git(['rev-parse', 'HEAD']);
  return { ...repository, sourceSha, setHead: (sha: string) => repository.git(['update-ref', 'HEAD', sha]) };
}
function mistakenBump() {
  const repository = nativeHistory();
  // Reproduce the old coordinator's extra bump of the open 2.7.0 (946156a72d).
  const bad = writeNativeStamp(repository.directory, repository.sourceSha, fingerprints, '2.7.1', 'version-bump');
  repository.setHead(bad.sha);
  return { ...repository, bad };
}
function forgedStamp(
  repository: ReturnType<typeof nativeHistory>,
  parent: string,
  kind: NativeStampKind,
  version: string,
  options: { tree?: string; author?: string; supersedes?: string; pair?: typeof fingerprints } = {},
) {
  return execFileSync(
    'git',
    ['commit-tree', options.tree ?? repository.git(['rev-parse', `${parent}^{tree}`]), '-p', parent],
    {
      cwd: repository.directory,
      encoding: 'utf8',
      input: nativeReleaseMessage(
        {
          ...(options.pair ?? fingerprints),
          sourceSha: parent,
          version,
          ...(options.supersedes ? { supersedes: options.supersedes } : {}),
        },
        kind,
      ),
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: options.author ?? BOT_NAME,
        GIT_AUTHOR_EMAIL: BOT_EMAIL,
        GIT_COMMITTER_NAME: BOT_NAME,
        GIT_COMMITTER_EMAIL: BOT_EMAIL,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ).trim();
}

function platformHistory() {
  const repository = nativeHistory();
  const first = writeNativeStamp(repository.directory, repository.sourceSha, fingerprints, '2.7.0', 'version-adoption');
  repository.setHead(first.sha);
  const append = (pair: typeof fingerprints, version = '2.7.1') => {
    const parent = repository.git(['rev-parse', 'HEAD']);
    const previousVersion = /version: '([^']+)'/.exec(repository.git(['show', `${parent}:${APP_CONFIG_PATH}`]))![1];
    const next = writeNativeStamp(
      repository.directory,
      parent,
      pair,
      version,
      version === previousVersion ? 'version-adoption' : 'version-bump',
    );
    repository.setHead(next.sha);
    repository.git(['update-ref', 'refs/remotes/origin/main', next.sha]);
    return next;
  };
  const tagIosUpload = (uploaded: NativeStamp, buildNumber = 1) => {
    const tag = `build-ios-v${uploaded.version}-${buildNumber}-${uploaded.ios.slice(0, 12)}`;
    repository.git(['tag', tag, uploaded.sha]);
    return { tag, sha: uploaded.sha };
  };
  return { ...repository, first, append, tagIosUpload };
}

describe('per-platform native upload reuse', { timeout: 30_000 }, () => {
  it('keeps Android on the open version when the accepted iOS binary is unchanged', () => {
    const repository = platformHistory();
    const receipt = repository.tagIosUpload(repository.first);
    const anchor = { tag: 'release/ios-v2.7.0-aaaaaaaaaaaa', sha: repository.first.sha };
    repository.git(['tag', anchor.tag, anchor.sha]);
    const adopted = prepareNativeVersionStamp(
      repository.directory,
      repository.first.sha,
      { ...fingerprints, android: 'c'.repeat(40) },
      repository.first.version,
      [receipt, anchor],
    );
    expect(adopted).toMatchObject({ kind: 'version-adoption', version: '2.7.0' });
    expect(validateNativeStampSource(adopted.sha, adopted.sha, repository.directory)).toMatchObject(adopted);
    expect(findUploadedNativePlatform('ios', adopted, repository.directory)).toEqual(receipt);
    expect(findUploadedNativePlatform('android', adopted, repository.directory)).toBeNull();
  });

  it('restores an Android-only bump and reuses the accepted iOS binary through later Android changes', () => {
    const repository = platformHistory();
    const receipt = repository.tagIosUpload(repository.first);
    repository.git(['tag', 'release/ios-v2.7.0-aaaaaaaaaaaa', repository.first.sha]);
    const pair = { ...fingerprints, android: 'c'.repeat(40) };
    const bad = repository.append(pair);
    repository.tagIosUpload(bad);
    repository.git(['tag', 'build-android-v2.7.1-2000100-cccccccccccc', bad.sha]);
    const restored = prepareNativeVersionRestoration(repository.directory, bad.sha, '2.7.0', bad.sha, pair).stamp;
    repository.setHead(restored.sha);
    repository.git(['update-ref', 'refs/remotes/origin/main', restored.sha]);
    expect(validateNativeStampSource(restored.sha, restored.sha, repository.directory)).toMatchObject(restored);
    expect(getSupersededNativeStampShas(repository.directory, restored.sha)).toEqual([bad.sha]);
    expect(findUploadedNativePlatform('ios', restored, repository.directory)).toEqual(receipt);
    expect(findUploadedNativePlatform('android', restored, repository.directory)).toBeNull();
    for (const platform of ['ios', 'android'] as const)
      expect(
        nativePlatformBuildDecision(
          { platform, sourceSha: restored.sha, fingerprint: restored[platform], version: '2.7.0', forced: false },
          repository.directory,
        ).shouldBuild,
      ).toBe(platform === 'android');
    expect(() =>
      nativePlatformBuildDecision(
        { platform: 'ios', sourceSha: restored.sha, fingerprint: restored.ios, version: '2.7.0', forced: true },
        repository.directory,
      ),
    ).toThrow('Apple already approved');
    const references = [
      receipt,
      { tag: 'release/ios-v2.7.0-aaaaaaaaaaaa', sha: repository.first.sha },
      { tag: 'build-ios-v2.7.1-1-aaaaaaaaaaaa', sha: bad.sha },
      { tag: 'build-android-v2.7.1-2000100-cccccccccccc', sha: bad.sha },
    ];
    const next = prepareNativeVersionStamp(
      repository.directory,
      restored.sha,
      { ...pair, android: 'd'.repeat(40) },
      restored.version,
      references,
      [bad.sha],
    );
    expect(next).toMatchObject({ kind: 'version-adoption', version: '2.7.0' });
    expect(findUploadedNativePlatform('ios', next, repository.directory)).toEqual(receipt);
    // iOS changing again must open a new version, even while Android stays open.
    expect(
      prepareNativeVersionStamp(
        repository.directory,
        restored.sha,
        { ...pair, ios: 'd'.repeat(40) },
        restored.version,
        references,
        [bad.sha],
      ),
    ).toMatchObject({ kind: 'version-bump', version: '2.7.1' });
  });

  it.each([
    'changed-ios',
    'missing-upload',
    'wrong-anchor-source',
    'wrong-anchor-fingerprint',
    'released-android',
    'higher-release',
    'higher-tester',
    'superseded-upload-only',
  ] as const)('refuses a platform restoration without reusable release proof: %s', (failure) => {
    const repository = platformHistory();
    if (failure !== 'missing-upload' && failure !== 'superseded-upload-only') repository.tagIosUpload(repository.first);
    const pair = { ...fingerprints, android: 'c'.repeat(40) };
    if (failure === 'changed-ios') pair.ios = `${'a'.repeat(12)}${'d'.repeat(28)}`;
    const bad = repository.append(pair);
    const anchor = `release/ios-v2.7.0-${failure === 'wrong-anchor-fingerprint' ? 'dddddddddddd' : 'aaaaaaaaaaaa'}`;
    repository.git(['tag', anchor, failure === 'wrong-anchor-source' ? bad.sha : repository.first.sha]);
    if (failure === 'superseded-upload-only') repository.tagIosUpload(bad);
    if (failure === 'released-android')
      repository.git(['tag', 'release/android-v2.7.0-bbbbbbbbbbbb', repository.first.sha]);
    if (failure === 'higher-release') repository.git(['tag', 'release/ios-v2.7.2-aaaaaaaaaaaa', repository.first.sha]);
    if (failure === 'higher-tester')
      repository.git(['tag', 'build-android-v2.7.2-2000101-bbbbbbbbbbbb', repository.first.sha]);
    expect(() => prepareNativeVersionRestoration(repository.directory, bad.sha, '2.7.0', bad.sha, pair)).toThrow();
    expect(repository.git(['rev-parse', 'HEAD'])).toBe(bad.sha);
  });

  it('skips TestFlight for an Android-only patch after the previous iOS version was accepted', () => {
    const repository = platformHistory();
    const receipt = repository.tagIosUpload(repository.first);
    repository.git(['tag', 'release/ios-v2.7.0-aaaaaaaaaaaa', repository.first.sha]);
    const next = repository.append({ ...fingerprints, android: 'c'.repeat(40) });
    expect(findUploadedNativePlatform('ios', next, repository.directory)).toEqual(receipt);
    expect(findUploadedNativePlatform('android', next, repository.directory)).toBeNull();
    expect(
      nativePlatformBuildDecision(
        { platform: 'ios', sourceSha: next.sha, fingerprint: next.ios, version: next.version, forced: false },
        repository.directory,
      ),
    ).toMatchObject({ shouldBuild: false });
    expect(
      nativePlatformBuildDecision(
        { platform: 'android', sourceSha: next.sha, fingerprint: next.android, version: next.version, forced: false },
        repository.directory,
      ),
    ).toMatchObject({ shouldBuild: true });
  });

  it('keeps reusing the uploaded iOS runtime across multiple Android-only stamps and repeated recovery checks', () => {
    const repository = platformHistory();
    const receipt = repository.tagIosUpload(repository.first);
    repository.append({ ...fingerprints, android: 'c'.repeat(40) });
    const latest = repository.append({ ...fingerprints, android: 'd'.repeat(40) });
    for (let recovery = 0; recovery < 2; recovery += 1)
      expect(findUploadedNativePlatform('ios', latest, repository.directory)).toEqual(receipt);
    expect(findUploadedNativePlatform('android', latest, repository.directory)).toBeNull();
  });

  it('recovers a missing unchanged-platform upload instead of treating matching fingerprints as success', () => {
    const repository = platformHistory();
    repository.append({ ...fingerprints, android: 'c'.repeat(40) });
    const latest = repository.append({ ...fingerprints, android: 'd'.repeat(40) });
    expect(findUploadedNativePlatform('ios', latest, repository.directory)).toBeNull();
    expect(
      nativePlatformBuildDecision(
        { platform: 'ios', sourceSha: latest.sha, fingerprint: latest.ios, version: latest.version, forced: false },
        repository.directory,
      ).shouldBuild,
    ).toBe(true);
  });

  it('builds native rollbacks and never borrows a pre-transition receipt for a missing rollback upload', () => {
    const repository = platformHistory();
    repository.tagIosUpload(repository.first);
    const changed = repository.append({ ...fingerprints, ios: 'c'.repeat(40) });
    repository.tagIosUpload(changed, 2);
    const rollback = repository.append(fingerprints);
    expect(findUploadedNativePlatform('ios', rollback, repository.directory)).toBeNull();
    const androidOnly = repository.append({ ...fingerprints, android: 'd'.repeat(40) });
    expect(findUploadedNativePlatform('ios', androidOnly, repository.directory)).toBeNull();
    const rollbackReceipt = repository.tagIosUpload(rollback, 3);
    expect(findUploadedNativePlatform('ios', androidOnly, repository.directory)).toEqual(rollbackReceipt);
  });

  it('tracks uncertain-build lineage through unchanged stamps and stops at native transitions', () => {
    const repository = platformHistory();
    const sameIos = repository.append({ ...fingerprints, android: 'c'.repeat(40) });
    const changedIos = repository.append({ ...fingerprints, ios: 'd'.repeat(40), android: 'c'.repeat(40) });
    const latest = repository.append({ ...fingerprints, ios: 'd'.repeat(40), android: 'e'.repeat(40) });
    expect(nativePlatformHistory('ios', sameIos, repository.directory).map((previous) => previous.sha)).toEqual([
      sameIos.sha,
      repository.first.sha,
    ]);
    expect(nativePlatformHistory('ios', latest, repository.directory).map((previous) => previous.sha)).toEqual([
      latest.sha,
      changedIos.sha,
    ]);
  });

  it('requires the full validated fingerprint even when an older receipt has a colliding short prefix', () => {
    const repository = platformHistory();
    repository.tagIosUpload(repository.first);
    const latest = repository.append({ ...fingerprints, ios: `${'a'.repeat(12)}${'c'.repeat(28)}` });
    expect(findUploadedNativePlatform('ios', latest, repository.directory)).toBeNull();
  });

  it('accepts a confirmed upload at the exact baseline source for an unchanged platform', () => {
    const repository = nativeHistory();
    const baselineSha = repository.git(['rev-parse', `${NATIVE_BASELINE_TAG}^{commit}`]);
    const tag = 'build-ios-v2.6.0-1-eeeeeeeeeeee';
    repository.git(['tag', tag, baselineSha]);
    const next = writeNativeStamp(
      repository.directory,
      repository.sourceSha,
      { ...fingerprints, ios: baselineFingerprints.ios },
      '2.7.0',
      'version-adoption',
    );
    expect(findUploadedNativePlatform('ios', next, repository.directory)).toEqual({ tag, sha: baselineSha });
  });

  it('preserves forced hotfix builds and the closed iOS marketing-version guard', () => {
    const repository = platformHistory();
    repository.tagIosUpload(repository.first);
    const latest = repository.append({ ...fingerprints, android: 'c'.repeat(40) });
    const input = { platform: 'ios' as const, sourceSha: latest.sha, fingerprint: latest.ios, version: latest.version };
    expect(nativePlatformBuildDecision({ ...input, forced: false }, repository.directory).shouldBuild).toBe(false);
    expect(nativePlatformBuildDecision({ ...input, forced: true }, repository.directory).shouldBuild).toBe(true);
    repository.git(['tag', 'release/ios-v2.7.1-aaaaaaaaaaaa', latest.sha]);
    expect(nativePlatformBuildDecision({ ...input, forced: false }, repository.directory).shouldBuild).toBe(false);
    expect(() => nativePlatformBuildDecision({ ...input, forced: true }, repository.directory)).toThrow(
      'Apple already approved',
    );
  });

  it('does not inherit a receipt from an explicitly superseded stamp', () => {
    const repository = mistakenBump();
    repository.git(['tag', 'build-ios-v2.7.1-1-aaaaaaaaaaaa', repository.bad.sha]);
    const restored = prepareNativeVersionRestoration(
      repository.directory,
      repository.bad.sha,
      '2.7.0',
      repository.bad.sha,
      fingerprints,
    ).stamp;
    expect(findUploadedNativePlatform('ios', restored, repository.directory)).toBeNull();
    expect(nativePlatformHistory('ios', restored, repository.directory).map((previous) => previous.sha)).toEqual([
      restored.sha,
    ]);
  });
});

describe('pre-raised native version adoption and explicit restoration', { timeout: 30_000 }, () => {
  it('adopts cutover 2.7.0 from the 2.6.0 baseline without modifying its tree', () => {
    const repository = nativeHistory();
    const adopted = prepareNativeVersionStamp(repository.directory, repository.sourceSha, fingerprints, '2.6.0', [
      { tag: 'build-ios-v2.7.0-8-aaaaaaaaaaaa', sha: repository.sourceSha },
    ]);
    expect(adopted).toMatchObject({ kind: 'version-adoption', version: '2.7.0', sourceSha: repository.sourceSha });
    expect(repository.git(['rev-parse', `${adopted.sha}^{tree}`])).toBe(
      repository.git(['rev-parse', `${repository.sourceSha}^{tree}`]),
    );
    expect(repository.git(['rev-parse', 'HEAD'])).toBe(repository.sourceSha);
    expect(validateNativeStampSource(adopted.sha, adopted.sha, repository.directory)).toMatchObject(adopted);
    repository.setHead(adopted.sha);
    repository.git(['tag', 'release/ios-v2.7.0-aaaaaaaaaaaa']);
    // Store approval after creation cannot invalidate an archived adoption proof.
    expect(validateNativeStampSource(adopted.sha, adopted.sha, repository.directory)).toMatchObject(adopted);
  });

  it.each(['changed-tree', 'wrong-author', 'wrong-version', 'unchanged-fingerprints', 'lowered'] as const)(
    'rejects invalid adoption provenance: %s',
    (failure) => {
      const repository = nativeHistory();
      const bad = writeNativeStamp(repository.directory, repository.sourceSha, fingerprints, '2.7.1', 'version-bump');
      let parent = repository.sourceSha;
      if (failure === 'lowered') {
        writeFileSync(
          join(repository.directory, APP_CONFIG_PATH),
          "export default {\n  version: '2.5.0',\n  name: 'Boardsesh',\n};\n",
        );
        repository.git(['add', '.']);
        repository.git(['commit', '--quiet', '-m', 'version below the 2.6.0 baseline']);
        parent = repository.git(['rev-parse', 'HEAD']);
      }
      const source = forgedStamp(
        repository,
        parent,
        'version-adoption',
        failure === 'lowered' ? '2.5.0' : failure === 'wrong-version' ? '2.8.0' : '2.7.0',
        {
          ...(failure === 'changed-tree' ? { tree: repository.git(['rev-parse', `${bad.sha}^{tree}`]) } : {}),
          ...(failure === 'wrong-author' ? { author: 'Impersonator' } : {}),
          ...(failure === 'unchanged-fingerprints' ? { pair: baselineFingerprints } : {}),
        },
      );
      expect(() => validateNativeStampSource(source, source, repository.directory)).toThrow();
    },
  );

  it('restores only the mistaken extra bump, retains proof, and carries supersession into later stamps', () => {
    const repository = mistakenBump();
    writeFileSync(join(repository.directory, 'later.txt'), 'later non-native changes stay\n');
    repository.git(['add', '.']);
    repository.git(['commit', '--quiet', '-m', 'later trusted main changes']);
    const mainSha = repository.git(['rev-parse', 'HEAD']);
    const prepared = prepareNativeVersionRestoration(
      repository.directory,
      mainSha,
      '2.7.0',
      repository.bad.sha,
      fingerprints,
    );
    expect(prepared.alreadyApplied).toBe(false);
    expect(repository.git(['rev-parse', 'HEAD'])).toBe(mainSha);
    expect(prepared.stamp).toMatchObject({
      kind: 'version-restoration',
      version: '2.7.0',
      supersedes: repository.bad.sha,
      sourceSha: mainSha,
    });
    expect(repository.git(['diff-tree', '--no-commit-id', '--name-only', '-r', prepared.stamp.sha])).toBe(
      APP_CONFIG_PATH,
    );
    expect(validateNativeStampSource(prepared.stamp.sha, prepared.stamp.sha, repository.directory)).toMatchObject(
      prepared.stamp,
    );
    repository.setHead(prepared.stamp.sha);
    expect(
      prepareNativeVersionRestoration(
        repository.directory,
        prepared.stamp.sha,
        '2.7.0',
        repository.bad.sha,
        fingerprints,
      ),
    ).toEqual({ stamp: prepared.stamp, alreadyApplied: true });
    expect(getSupersededNativeStampShas(repository.directory, prepared.stamp.sha)).toEqual([repository.bad.sha]);
    const next = prepareNativeVersionStamp(
      repository.directory,
      prepared.stamp.sha,
      { ios: '1'.repeat(40), android: '2'.repeat(40) },
      '2.7.0',
      [{ tag: 'build-ios-v2.7.1-1-aaaaaaaaaaaa', sha: repository.bad.sha }],
      getSupersededNativeStampShas(repository.directory, prepared.stamp.sha),
    );
    expect(next).toMatchObject({ kind: 'version-adoption', version: '2.7.0' });
    repository.setHead(next.sha);
    expect(getSupersededNativeStampShas(repository.directory, next.sha)).toEqual([repository.bad.sha]);
    repository.git(['tag', 'release/ios-v2.7.0-aaaaaaaaaaaa', prepared.stamp.sha]);
    expect(validateNativeStampSource(prepared.stamp.sha, next.sha, repository.directory)).toMatchObject(prepared.stamp);
    expect(validateNativeStampSource(repository.bad.sha, next.sha, repository.directory).version).toBe('2.7.1');
  });

  it.each([
    'wrong-expected',
    'wrong-target',
    'changed-native',
    'released-target',
    'changed-version',
    'higher-reservation',
  ] as const)('refuses unsafe restoration plan: %s', (failure) => {
    const repository = mistakenBump();
    if (failure === 'released-target') repository.git(['tag', 'release/android-v2.7.0-aaaaaaaaaaaa']);
    if (failure === 'higher-reservation')
      repository.git(['tag', 'build-android-v2.8.0-2000100-aaaaaaaaaaaa', repository.sourceSha]);
    if (failure === 'changed-version') {
      writeFileSync(
        join(repository.directory, APP_CONFIG_PATH),
        "export default {\n  version: '2.8.0',\n  name: 'Boardsesh',\n};\n",
      );
      repository.git(['add', '.']);
      repository.git(['commit', '--quiet', '-m', 'another deliberate version']);
    }
    const mainSha = repository.git(['rev-parse', 'HEAD']);
    expect(() =>
      prepareNativeVersionRestoration(
        repository.directory,
        mainSha,
        failure === 'wrong-target' ? '2.6.0' : '2.7.0',
        failure === 'wrong-expected' ? repository.sourceSha : repository.bad.sha,
        failure === 'changed-native' ? { ...fingerprints, ios: '1'.repeat(40) } : fingerprints,
      ),
    ).toThrow();
    expect(repository.git(['rev-parse', 'HEAD'])).toBe(mainSha);
  });

  it('rejects a forged restoration that changes file mode or names the wrong superseded stamp', () => {
    const repository = mistakenBump();
    const prepared = prepareNativeVersionRestoration(
      repository.directory,
      repository.bad.sha,
      '2.7.0',
      repository.bad.sha,
      fingerprints,
    );
    repository.git(['update-index', '--chmod=+x', APP_CONFIG_PATH]);
    const wrongMode = forgedStamp(repository, repository.bad.sha, 'version-restoration', '2.7.0', {
      tree: repository.git(['write-tree']),
      supersedes: repository.bad.sha,
    });
    expect(() => validateNativeStampSource(wrongMode, wrongMode, repository.directory)).toThrow('file mode');
    const wrongSource = forgedStamp(repository, repository.bad.sha, 'version-restoration', '2.7.0', {
      tree: repository.git(['rev-parse', `${prepared.stamp.sha}^{tree}`]),
      supersedes: repository.sourceSha,
    });
    expect(() => validateNativeStampSource(wrongSource, wrongSource, repository.directory)).toThrow();
    expect(nativeStampKind(nativeReleaseMessage(prepared.stamp, 'version-restoration'))).toBe('version-restoration');
    expect(() => nativeReleaseMessage({ ...prepared.stamp, supersedes: undefined }, 'version-restoration')).toThrow(
      'full',
    );
  });

  it('cannot undo the patch opened after a store accepted the previous version', () => {
    const repository = fixture('2.6.0');
    repository.git([
      'tag',
      '-a',
      NATIVE_BASELINE_TAG,
      '-m',
      nativeReleaseMessage({ ...baselineFingerprints, sourceSha: repository.sourceSha }, 'baseline'),
    ]);
    const anchor = 'release/ios-v2.6.0-eeeeeeeeeeee';
    repository.git(['tag', anchor, repository.sourceSha]);
    const legitimate = prepareNativeVersionStamp(repository.directory, repository.sourceSha, fingerprints, '2.6.0', [
      { tag: anchor, sha: repository.sourceSha },
    ]);
    repository.git(['update-ref', 'HEAD', legitimate.sha]);
    expect(legitimate).toMatchObject({ kind: 'version-bump', version: '2.6.1' });
    expect(() =>
      prepareNativeVersionRestoration(repository.directory, legitimate.sha, '2.6.0', legitimate.sha, fingerprints),
    ).toThrow('public release anchor');
  });

  it('keeps restored 2.7.0 open for the next native change and can undo the second extra bump', () => {
    // The incident: 7305e664a0 restored 2.7.0, then the native merge 2315895fb5 got e3a4fc467f (2.7.1).
    const repository = mistakenBump();
    repository.git(['tag', 'build-ios-v2.7.1-1-aaaaaaaaaaaa', repository.bad.sha]);
    const restored = prepareNativeVersionRestoration(
      repository.directory,
      repository.bad.sha,
      '2.7.0',
      repository.bad.sha,
      fingerprints,
    ).stamp;
    repository.setHead(restored.sha);
    repository.git(['tag', 'build-ios-v2.7.0-9-aaaaaaaaaaaa', restored.sha]);
    const nativeChange = (name: string) => {
      writeFileSync(join(repository.directory, name), `${name} changes the native pair\n`);
      repository.git(['add', '.']);
      repository.git(['commit', '--quiet', '-m', `native merge ${name}`]);
      return repository.git(['rev-parse', 'HEAD']);
    };
    const references = () =>
      repository
        .git(['for-each-ref', '--format=%(refname:strip=2) %(objectname)', 'refs/tags/build-*', 'refs/tags/release/*'])
        .split('\n')
        .map((line) => line.split(' '))
        .map(([tag, sha]) => ({ tag: tag!, sha: sha! }));
    const secondPair = { ios: '1'.repeat(40), android: '2'.repeat(40) };
    const secondMerge = nativeChange('second-native.txt');

    // Fixed coordinator: the open 2.7.0 is rebuilt, not replaced by 2.7.1.
    const kept = prepareNativeVersionStamp(
      repository.directory,
      secondMerge,
      secondPair,
      restored.version,
      references(),
      getSupersededNativeStampShas(repository.directory, secondMerge),
    );
    expect(kept).toMatchObject({ kind: 'version-adoption', version: '2.7.0', sourceSha: secondMerge });
    expect(repository.git(['rev-parse', `${kept.sha}^{tree}`])).toBe(
      repository.git(['rev-parse', `${secondMerge}^{tree}`]),
    );
    expect(validateNativeStampSource(kept.sha, kept.sha, repository.directory)).toMatchObject(kept);

    // The bump main actually received can be undone with the same restore-version dispatch.
    const secondBad = writeNativeStamp(repository.directory, secondMerge, secondPair, '2.7.1', 'version-bump');
    repository.setHead(secondBad.sha);
    repository.git(['tag', 'build-ios-v2.7.1-2-111111111111', secondBad.sha]);
    repository.git(['tag', 'build-android-v2.7.1-2001563-222222222222', secondBad.sha]);
    const restoredAgain = prepareNativeVersionRestoration(
      repository.directory,
      secondBad.sha,
      '2.7.0',
      secondBad.sha,
      secondPair,
    );
    expect(restoredAgain.alreadyApplied).toBe(false);
    expect(restoredAgain.stamp).toMatchObject({ kind: 'version-restoration', version: '2.7.0', ...secondPair });
    expect(
      validateNativeStampSource(restoredAgain.stamp.sha, restoredAgain.stamp.sha, repository.directory),
    ).toMatchObject(restoredAgain.stamp);
    repository.setHead(restoredAgain.stamp.sha);
    const retired = getSupersededNativeStampShas(repository.directory, restoredAgain.stamp.sha);
    expect(retired).toEqual([secondBad.sha, repository.bad.sha]);

    const thirdMerge = nativeChange('third-native.txt');
    const thirdPair = { ios: '3'.repeat(40), android: '4'.repeat(40) };
    expect(
      prepareNativeVersionStamp(repository.directory, thirdMerge, thirdPair, '2.7.0', references(), retired),
    ).toMatchObject({ kind: 'version-adoption', version: '2.7.0' });
    // Once a store accepts 2.7.0, the next native change opens 2.7.1 again.
    repository.git(['tag', 'release/ios-v2.7.0-aaaaaaaaaaaa', restored.sha]);
    expect(
      prepareNativeVersionStamp(repository.directory, thirdMerge, thirdPair, '2.7.0', references(), retired),
    ).toMatchObject({ kind: 'version-bump', version: '2.7.1' });
  });
});

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

  it('requires explicit restoration inputs and apply before minting a push token', () => {
    const inputs = coordinator.on.workflow_dispatch.inputs;
    expect(inputs.action.options).toContain('restore-version');
    expect(inputs.action.default).toBe('plan');
    expect(inputs.apply.default).toBe(false);
    expect(inputs.target_version.type).toBe('string');
    expect(inputs.expected_stamp_sha.type).toBe('string');
    const steps = coordinator.jobs.coordinate.steps as Array<{ id?: string; if?: string; run?: string }>;
    expect(steps.find((step) => step.id === 'push_token')?.if).toBe(
      "inputs.action != 'plan' && (inputs.action != 'restore-version' || inputs.apply)",
    );
    expect(steps.find((step) => step.run?.includes('restore-version)'))?.run).toContain(
      'args=(restore-version --target-version "$TARGET_VERSION" --expected-stamp-sha "$EXPECTED_STAMP_SHA")',
    );
  });

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
    expect(coordinator.concurrency).toEqual({
      group: 'mobile-native-release',
      'cancel-in-progress': false,
      queue: 'max',
    });
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
    const schemaCheck = steps.find(
      (step: { name?: string }) => step.name === 'Require the live backend schema before tester upload',
    );
    expect(schemaCheck?.env?.TRUSTED_WORKFLOW_SHA).toBe('${{ github.workflow_sha }}');
    expect(schemaCheck?.run).toContain(
      'git show "$TRUSTED_WORKFLOW_SHA:scripts/mobile-ota-schema-ready.mjs" > scripts/mobile-ota-schema-ready.mjs',
    );
    expect(schemaCheck?.run).toContain(
      'GITHUB_SHA="$NATIVE_SOURCE_SHA" node scripts/mobile-ota-schema-ready.mjs --allow-compatible-schema',
    );
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
