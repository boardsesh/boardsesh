/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  ANDROID_BUILD_JOB,
  ANDROID_REVIEW_JOB,
  APP_CONFIG_PATH,
  BOT_EMAIL,
  BOT_NAME,
  CONFLICT_ISSUE_LABEL,
  CONFLICT_ISSUE_TITLE,
  NATIVE_WORKFLOWS,
  DRAFT_WAIT_MAX_MS,
  MAX_PUSH_ATTEMPTS,
  RELEASE_BRANCH,
  STORE_DRAFT_WORKFLOW,
  SYNC_MERGE_MESSAGE,
  activeTrainDraftRuns,
  bumpVersionSource,
  classifyTrain,
  compareSemver,
  computeSyncPlan,
  conflictMarker,
  createGitClient,
  decideBuildRetry,
  hasReleaseTrainTrailer,
  hasSkipCiMarker,
  hasVersionBuildTag,
  isAppConfigOnlyConflict,
  isVersionOnlyChange,
  isDeferredAndroidRun,
  explainPushFailure,
  parseRunJobs,
  isVersionTaken,
  nextVersion,
  parseAnchoredIosVersions,
  parseGitHubRepository,
  parseLsRemote,
  parseMergeTreeOutput,
  parseSemver,
  parseTrailers,
  readMarketingVersion,
  renderConflictReport,
  resolveVersionOnlyConflict,
  runReleaseTrainSync,
  selectLastMergedBack,
  versionBumpMessage,
  type ClassifyTrainInput,
  type GitHubClient,
  type RunJob,
  type SyncRuntime,
  type WorkflowRun,
} from './release-train-sync';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

const APP_CONFIG_TEMPLATE = (version: string) =>
  [
    'export default {',
    '  expo: {',
    "    name: 'Boardsesh',",
    `    version: '${version}',`,
    "    slug: 'boardsesh',",
    '  },',
    '};',
    '',
  ].join('\n');

// ─── Versions ───────────────────────────────────────────────────────────────────

describe('semver helpers', () => {
  it('parses plain versions and rejects anything else', () => {
    expect(parseSemver('2.6.0')).toEqual([2, 6, 0]);
    for (const bad of ['2.6', '2.6.0-beta', 'v2.6.0', '2.6.0 ', '']) {
      expect(() => parseSemver(bad)).toThrow();
    }
  });

  it('compares numerically, not lexically', () => {
    expect(compareSemver('2.10.0', '2.9.9')).toBeGreaterThan(0);
    expect(compareSemver('2.6.0', '2.6.0')).toBe(0);
    expect(compareSemver('1.99.99', '2.0.0')).toBeLessThan(0);
  });
});

describe('nextVersion', () => {
  it('keeps a version nobody released', () => {
    const decision = nextVersion({
      baseVersion: '2.7.0',
      lastMergedBackVersion: '2.6.0',
      anchoredIosVersions: ['2.6.0'],
    });
    expect(decision).toMatchObject({ targetVersion: '2.7.0', bump: false });
  });

  // The real state on 2026-10-19: #6193 merged back 2.6.0 and Apple accepted it.
  it('bumps the merged-back, accepted 2.6.0 to the next patch', () => {
    const decision = nextVersion({
      baseVersion: '2.6.0',
      lastMergedBackVersion: '2.6.0',
      anchoredIosVersions: ['2.6.0'],
    });
    expect(decision).toMatchObject({ baseVersion: '2.6.0', targetVersion: '2.6.1', bump: true });
    expect(decision.reason).toContain('2.6.0 is taken');
  });

  it('opens the train at the floor when it is higher and free', () => {
    const decision = nextVersion({
      baseVersion: '2.6.0',
      lastMergedBackVersion: '2.6.0',
      anchoredIosVersions: ['2.5.0', '2.6.0'],
      floorVersion: '2.7.0',
    });
    expect(decision).toMatchObject({ targetVersion: '2.7.0', bump: true });
  });

  it('raises a free base version to a higher floor', () => {
    const decision = nextVersion({ baseVersion: '2.6.1', anchoredIosVersions: ['2.6.0'], floorVersion: '2.7.0' });
    expect(decision).toMatchObject({ targetVersion: '2.7.0', bump: true });
  });

  it('ignores a floor that is lower or already taken', () => {
    expect(nextVersion({ baseVersion: '2.7.0', anchoredIosVersions: [], floorVersion: '2.6.5' }).targetVersion).toBe(
      '2.7.0',
    );
    const decision = nextVersion({
      baseVersion: '2.7.0',
      lastMergedBackVersion: '2.7.0',
      anchoredIosVersions: ['2.7.0'],
      floorVersion: '2.7.0',
    });
    expect(decision.targetVersion).toBe('2.7.1');
    expect(decision.reason).toContain('floor 2.7.0 is already taken');
  });

  it('treats anything at or below the last merge-back as taken', () => {
    const decision = nextVersion({ baseVersion: '2.6.0', lastMergedBackVersion: '2.7.0', anchoredIosVersions: [] });
    expect(decision).toMatchObject({ targetVersion: '2.7.1', bump: true });
  });

  it('jumps above the highest anchor, even one above the base', () => {
    const decision = nextVersion({ baseVersion: '2.7.0', anchoredIosVersions: ['2.7.0', '2.7.1', '2.7.2'] });
    expect(decision.targetVersion).toBe('2.7.3');
  });

  it('counts an anchor as taken even with no merge-back on record', () => {
    expect(isVersionTaken('2.6.0', { anchoredIosVersions: ['2.6.0'] })).toBe(true);
    expect(isVersionTaken('2.6.1', { anchoredIosVersions: ['2.6.0'] })).toBe(false);
    expect(isVersionTaken('2.6.1', { lastMergedBackVersion: '2.6.1', anchoredIosVersions: [] })).toBe(true);
  });

  // App Store Connect refuses a version at or below the last approved one.
  it('counts every version below the highest anchor as taken, anchored or not', () => {
    expect(isVersionTaken('2.5.9', { anchoredIosVersions: ['2.6.0'] })).toBe(true);
    expect(isVersionTaken('2.6.5', { anchoredIosVersions: ['2.2.0', '2.7.0'] })).toBe(true);
    expect(isVersionTaken('2.7.1', { anchoredIosVersions: ['2.2.0', '2.7.0'] })).toBe(false);
    const decision = nextVersion({ baseVersion: '2.6.5', anchoredIosVersions: ['2.7.0'], floorVersion: '2.6.9' });
    expect(decision.targetVersion).toBe('2.7.1');
    expect(decision.reason).toContain('floor 2.6.9 is already taken');
  });

  it('rejects a malformed floor instead of guessing', () => {
    expect(() => nextVersion({ baseVersion: '2.6.0', anchoredIosVersions: [], floorVersion: '2.7' })).toThrow();
  });
});

// The train never goes backwards: the version release/next already carries is a
// lower bound in every mode, so dropping the floor cannot undo a 2.7.0 train.
describe('nextVersion with the current train version as a lower bound', () => {
  const released = { lastMergedBackVersion: '2.6.0', anchoredIosVersions: ['2.6.0'] };

  it('keeps a free 2.7.0 when the bump is recreated on a 2.6.0 main with no floor', () => {
    const decision = nextVersion({ baseVersion: '2.6.0', currentTrainVersion: '2.7.0', ...released });
    expect(decision).toMatchObject({ baseVersion: '2.6.0', targetVersion: '2.7.0', bump: true });
    expect(decision.reason).toContain('already carries 2.7.0');
  });

  it('moves past the train version once it is merged back or anchored', () => {
    expect(
      nextVersion({
        baseVersion: '2.6.0',
        currentTrainVersion: '2.7.0',
        ...released,
        anchoredIosVersions: ['2.6.0', '2.7.0'],
      }).targetVersion,
    ).toBe('2.7.1');
    expect(
      nextVersion({
        baseVersion: '2.7.0',
        currentTrainVersion: '2.7.0',
        lastMergedBackVersion: '2.7.0',
        anchoredIosVersions: [],
      }).targetVersion,
    ).toBe('2.7.1');
  });

  it('never takes a version below an approved train version, even when the base looks free', () => {
    // Apple accepted the train's 2.7.0 before the merge-back; main still says 2.6.1.
    const decision = nextVersion({
      baseVersion: '2.6.1',
      currentTrainVersion: '2.7.0',
      lastMergedBackVersion: '2.6.0',
      anchoredIosVersions: ['2.6.0', '2.7.0'],
    });
    expect(decision.targetVersion).toBe('2.7.1');
    expect(decision.reason).toContain('Apple already accepted 2.7.0');
  });

  it('ignores a train version at or below the candidate', () => {
    expect(nextVersion({ baseVersion: '2.6.0', currentTrainVersion: '2.6.0', ...released }).targetVersion).toBe(
      '2.6.1',
    );
    expect(nextVersion({ baseVersion: '2.8.0', currentTrainVersion: '2.7.0', ...released }).targetVersion).toBe(
      '2.8.0',
    );
  });

  it('still lets a higher floor win', () => {
    const decision = nextVersion({
      baseVersion: '2.6.0',
      currentTrainVersion: '2.7.0',
      ...released,
      floorVersion: '3.0.0',
    });
    expect(decision.targetVersion).toBe('3.0.0');
  });
});

describe('isVersionOnlyChange', () => {
  const before = APP_CONFIG_TEMPLATE('2.6.0');

  it('accepts a change to the version line alone', () => {
    expect(isVersionOnlyChange(before, APP_CONFIG_TEMPLATE('2.7.0'))).toBe(true);
  });

  it('rejects any other edit to the file, or none at all', () => {
    expect(isVersionOnlyChange(before, `${APP_CONFIG_TEMPLATE('2.7.0')}// note\n`)).toBe(false);
    expect(isVersionOnlyChange(before, APP_CONFIG_TEMPLATE('2.7.0').replace("'boardsesh'", "'other'"))).toBe(false);
    expect(isVersionOnlyChange(before, 'export default {};\n')).toBe(false);
  });
});

// ─── app.config.ts version line ─────────────────────────────────────────────────

describe('bumpVersionSource', () => {
  const appConfig = readFileSync('packages/mobile/app.config.ts', 'utf8');
  const currentVersion = readMarketingVersion(appConfig);

  it('rewrites only the version line', () => {
    const bumped = bumpVersionSource(appConfig, '9.8.7');
    const before = appConfig.split('\n');
    const after = bumped.split('\n');
    expect(after).toHaveLength(before.length);
    const changed = after.flatMap((line, index) => (line === before[index] ? [] : [index]));
    expect(changed).toHaveLength(1);
    expect(after[changed[0]]).toBe(before[changed[0]].replace(`'${currentVersion}'`, "'9.8.7'"));
    expect(readMarketingVersion(bumped)).toBe('9.8.7');
  });

  // Three readers parse the same line. Each regex is copied from its source, and
  // the copy is pinned against that source so a change there fails here.
  it.each([
    {
      reader: 'ios-testflight-rn.yml',
      file: '.github/workflows/ios-testflight-rn.yml',
      literal: String.raw`appConfig.match(/\bversion:\s*['"]([^'"]+)['"]/)`,
      pattern: /\bversion:\s*['"]([^'"]+)['"]/,
    },
    {
      reader: 'fastlane mobile_app_version',
      file: 'fastlane/Fastfile',
      literal: String.raw`.match(/^[ \t]*version:\s*['"](\d[^'"]*)['"]/)`,
      // Ruby's ^ is a line anchor; JavaScript needs the m flag for the same meaning.
      pattern: /^[ \t]*version:\s*['"](\d[^'"]*)['"]/m,
    },
    {
      reader: 'mobile-auto-version-bump.ts',
      file: 'scripts/mobile-auto-version-bump.ts',
      literal: String.raw`content.match(/version:\s*'(\d+\.\d+\.\d+)'/)`,
      pattern: /version:\s*'(\d+\.\d+\.\d+)'/,
    },
  ])('still parses under the $reader reader', ({ file, literal, pattern }) => {
    expect(readFileSync(file, 'utf8')).toContain(literal);
    expect(appConfig.match(pattern)?.[1]).toBe(currentVersion);
    expect(bumpVersionSource(appConfig, '2.7.0').match(pattern)?.[1]).toBe('2.7.0');
  });

  it('refuses a file with no version line or with two', () => {
    expect(() => bumpVersionSource("export default { name: 'x' };\n", '2.7.0')).toThrow(/found 0/);
    const twice = "  version: '2.6.0',\n  nested: {\n    version: '1.0.0',\n  },\n";
    expect(() => bumpVersionSource(twice, '2.7.0')).toThrow(/found 2/);
    expect(() => readMarketingVersion(twice)).toThrow(/found 2/);
  });

  it('refuses a version that is not major.minor.patch', () => {
    expect(() => bumpVersionSource("  version: '2.6.0',\n", '2.7')).toThrow();
  });
});

describe('resolveVersionOnlyConflict', () => {
  const wrap = (middle: string[]) =>
    ['export default {', "  name: 'Boardsesh',", ...middle, "  slug: 'x',", '};', ''].join('\n');

  it('keeps the higher version from either side', () => {
    const trainHigher = wrap([
      '<<<<<<< train',
      "    version: '2.7.0',",
      '=======',
      "    version: '2.6.1',",
      '>>>>>>> main',
    ]);
    expect(resolveVersionOnlyConflict(trainHigher)).toBe(wrap(["    version: '2.7.0',"]));
    const mainHigher = wrap([
      '<<<<<<< train',
      "    version: '2.6.1',",
      '=======',
      "    version: '2.10.0',",
      '>>>>>>> main',
    ]);
    expect(resolveVersionOnlyConflict(mainHigher)).toBe(wrap(["    version: '2.10.0',"]));
  });

  it('accepts the diff3 style with a base section', () => {
    const diff3 = wrap([
      '<<<<<<< train',
      "    version: '2.7.0',",
      '||||||| base',
      "    version: '2.6.0',",
      '=======',
      "    version: '2.6.1',",
      '>>>>>>> main',
    ]);
    expect(resolveVersionOnlyConflict(diff3)).toBe(wrap(["    version: '2.7.0',"]));
  });

  it('gives up when the block holds more than the version line', () => {
    const wider = wrap([
      '<<<<<<< train',
      "    version: '2.7.0',",
      "    slug: 'a',",
      '=======',
      "    version: '2.6.1',",
      '>>>>>>> main',
    ]);
    expect(resolveVersionOnlyConflict(wider)).toBeNull();
  });

  it('gives up on a second conflict block or a non-version conflict', () => {
    const block = ['<<<<<<< train', "    version: '2.7.0',", '=======', "    version: '2.6.1',", '>>>>>>> main'];
    expect(resolveVersionOnlyConflict(wrap([...block, ...block]))).toBeNull();
    expect(
      resolveVersionOnlyConflict(wrap(['<<<<<<< train', "  slug: 'a',", '=======', "  slug: 'b',", '>>>>>>> main'])),
    ).toBeNull();
    expect(resolveVersionOnlyConflict(wrap(["    version: '2.7.0',"]))).toBeNull();
    expect(resolveVersionOnlyConflict(wrap(['<<<<<<< train', "    version: '2.7.0',", '=======']))).toBeNull();
  });
});

// ─── Commit messages ────────────────────────────────────────────────────────────

describe('trailers', () => {
  it('reads the bot messages this script writes', () => {
    expect(hasReleaseTrainTrailer(versionBumpMessage('2.7.0'), 'version-bump')).toBe(true);
    expect(hasReleaseTrainTrailer(SYNC_MERGE_MESSAGE, 'sync')).toBe(true);
    expect(hasReleaseTrainTrailer(SYNC_MERGE_MESSAGE, 'version-bump')).toBe(false);
  });

  it('only reads trailers from the last paragraph, never the subject', () => {
    expect(parseTrailers('Release-Train: version-bump')).toEqual([]);
    expect(parseTrailers('subject\n\nRelease-Train: version-bump\n\nbody after')).toEqual([]);
    expect(
      parseTrailers('subject\n\nbody\n\nRelease-Train: version-bump\nCo-Authored-By: Someone <s@example.com>\n'),
    ).toEqual([
      { key: 'Release-Train', value: 'version-bump' },
      { key: 'Co-Authored-By', value: 'Someone <s@example.com>' },
    ]);
  });

  it('matches the trailer key and value case-insensitively', () => {
    expect(hasReleaseTrainTrailer('chore: x\n\nrelease-train: Version-Bump\n', 'version-bump')).toBe(true);
  });
});

describe('hasSkipCiMarker', () => {
  it.each(['[skip ci]', '[ci skip]', '[no ci]', '[skip actions]', '[actions skip]', '[SKIP CI]', '[Skip Actions]'])(
    'finds %s anywhere in the message',
    (marker) => {
      expect(hasSkipCiMarker(`chore: regenerate changelog ${marker}`)).toBe(true);
      expect(hasSkipCiMarker(`chore: regenerate changelog\n\nbody ${marker}\n`)).toBe(true);
    },
  );

  it('finds a skip-checks trailer with or without the space', () => {
    expect(hasSkipCiMarker('chore: x\n\n\nskip-checks: true\n')).toBe(true);
    expect(hasSkipCiMarker('chore: x\n\n\nskip-checks:true')).toBe(true);
    expect(hasSkipCiMarker('chore: x\n\n\nSkip-Checks: TRUE')).toBe(true);
  });

  it('ignores near misses', () => {
    expect(hasSkipCiMarker('fix: skip ci flake in the runner')).toBe(false);
    expect(hasSkipCiMarker('chore: x\n\nskip-checks: false')).toBe(false);
    expect(hasSkipCiMarker(versionBumpMessage('2.7.0'))).toBe(false);
    expect(hasSkipCiMarker(SYNC_MERGE_MESSAGE)).toBe(false);
  });
});

// ─── Classification ─────────────────────────────────────────────────────────────

describe('classifyTrain', () => {
  const native = { sha: SHA_B, message: 'feat(mobile): [native-train] Lock Screen timer (#6537)\n' };
  const bump = { sha: SHA_C, message: versionBumpMessage('2.7.0'), versionOnly: true };
  const base: ClassifyTrainInput = {
    trainTip: SHA_B,
    mainTip: SHA_A,
    trainTipIsAncestorOfMain: false,
    mainTipIsAncestorOfTrain: false,
    lastMergedBackHeadOid: null,
    trainOnlyCommits: [native],
  };

  it('creates a missing train from main', () => {
    expect(classifyTrain({ ...base, trainTip: null, trainOnlyCommits: [] }).mode).toBe('create');
  });

  it('fast-forwards a train with nothing of its own', () => {
    expect(classifyTrain({ ...base, trainTipIsAncestorOfMain: true, trainOnlyCommits: [] }).mode).toBe('fast-forward');
  });

  it('resets a train still at the head of a squash-merged merge-back', () => {
    expect(classifyTrain({ ...base, lastMergedBackHeadOid: SHA_B }).mode).toBe('reset-after-merge-back');
    expect(classifyTrain({ ...base, lastMergedBackHeadOid: SHA_C }).mode).toBe('merge');
  });

  it('recreates a train that only carries bot bumps', () => {
    expect(classifyTrain({ ...base, trainTip: SHA_C, trainOnlyCommits: [bump] }).mode).toBe('recreate-bump');
    // Still recreated when main is already inside it: the bump is replaced, not stacked.
    const inSync = { ...base, trainTip: SHA_C, trainOnlyCommits: [bump], mainTipIsAncestorOfTrain: true };
    expect(classifyTrain(inSync).mode).toBe('recreate-bump');
  });

  it('merges main into a train with native work, bump or not', () => {
    const classification = classifyTrain({ ...base, trainTip: SHA_C, trainOnlyCommits: [bump, native] });
    expect(classification.mode).toBe('merge');
    expect(classification.reason).toContain('#6537');
  });

  it('keeps a train that already contains main', () => {
    expect(classifyTrain({ ...base, mainTipIsAncestorOfTrain: true }).mode).toBe('ahead');
  });

  it('does not mistake a human commit mentioning the trailer in its body for a bump', () => {
    const lookalike = {
      sha: SHA_C,
      message: 'chore: x\n\nRelease-Train: version-bump\n\nmore words',
      versionOnly: true,
    };
    expect(classifyTrain({ ...base, trainOnlyCommits: [lookalike] }).mode).toBe('merge');
  });

  it('never drops a bump-trailer commit that changes more than the version line', () => {
    const notesToo = { ...bump, versionOnly: false };
    expect(classifyTrain({ ...base, trainTip: SHA_C, trainOnlyCommits: [notesToo] }).mode).toBe('merge');
    expect(
      classifyTrain({ ...base, trainTip: SHA_C, trainOnlyCommits: [{ ...bump, versionOnly: undefined }] }).mode,
    ).toBe('merge');
  });
});

// ─── Parsing ────────────────────────────────────────────────────────────────────

describe('git and gh output parsing', () => {
  it('parses ls-remote and fails loudly on anything else', () => {
    expect(parseLsRemote(`${SHA_A}\trefs/heads/main\n${SHA_B}\trefs/heads/release/next\n`)).toEqual([
      { sha: SHA_A, ref: 'refs/heads/main' },
      { sha: SHA_B, ref: 'refs/heads/release/next' },
    ]);
    expect(parseLsRemote('')).toEqual([]);
    expect(() => parseLsRemote('fatal: could not read from remote')).toThrow(/Unexpected/);
  });

  it('reads anchored iOS versions, including peeled annotated tags', () => {
    const refs = parseLsRemote(
      [
        `${SHA_A}\trefs/tags/release/ios-v2.6.0-84dca13e7422`,
        `${SHA_B}\trefs/tags/release/ios-v2.10.0-15f9b78d219b`,
        `${SHA_C}\trefs/tags/release/ios-v2.10.0-15f9b78d219b^{}`,
        `${SHA_A}\trefs/tags/release/ios-v2.2.0-08f1cf331ae6`,
      ].join('\n'),
    );
    expect(parseAnchoredIosVersions(refs)).toEqual(['2.2.0', '2.6.0', '2.10.0']);
    expect(() => parseAnchoredIosVersions([{ sha: SHA_A, ref: 'refs/tags/release/ios-v2.6.0-rc1' }])).toThrow();
  });

  it('finds a build tag for exactly this platform and version', () => {
    const refs = [{ sha: SHA_A, ref: 'refs/tags/build-ios-v2.7.0-5-a7cb366b87a0' }];
    expect(hasVersionBuildTag(refs, 'ios', '2.7.0')).toBe(true);
    expect(hasVersionBuildTag(refs, 'android', '2.7.0')).toBe(false);
    expect(hasVersionBuildTag(refs, 'ios', '2.7.01')).toBe(false);
    expect(hasVersionBuildTag([{ sha: SHA_A, ref: 'refs/tags/build-ios-v2.7.01-5-abc' }], 'ios', '2.7.0')).toBe(false);
  });

  it('picks the latest same-repository merge-back', () => {
    const latest = selectLastMergedBack([
      {
        number: 4845,
        mergedAt: '2026-09-01T01:07:43Z',
        mergeCommit: { oid: SHA_A },
        headRefOid: SHA_A,
        isCrossRepository: false,
      },
      {
        number: 6193,
        mergedAt: '2026-10-07T08:51:03Z',
        mergeCommit: { oid: SHA_B },
        headRefOid: SHA_C,
        isCrossRepository: false,
      },
      {
        number: 9999,
        mergedAt: '2026-10-09T00:00:00Z',
        mergeCommit: { oid: SHA_C },
        headRefOid: SHA_C,
        isCrossRepository: true,
      },
    ]);
    expect(latest).toEqual({
      number: 6193,
      mergedAt: '2026-10-07T08:51:03Z',
      mergeCommitOid: SHA_B,
      headRefOid: SHA_C,
    });
    expect(selectLastMergedBack([])).toBeNull();
    expect(() => selectLastMergedBack([{ number: '1' }])).toThrow();
  });

  it('parses merge-tree output and spots a version-only conflict', () => {
    const conflict = parseMergeTreeOutput(
      [
        SHA_A,
        `100644 ${SHA_B} 1\t${APP_CONFIG_PATH}`,
        `100644 ${SHA_B} 2\t${APP_CONFIG_PATH}`,
        `100644 ${SHA_C} 3\t${APP_CONFIG_PATH}`,
        '',
        `Auto-merging ${APP_CONFIG_PATH}`,
        `CONFLICT (content): Merge conflict in ${APP_CONFIG_PATH}`,
        '',
      ].join('\n'),
      false,
    );
    expect(conflict.tree).toBe(SHA_A);
    expect(conflict.conflicts).toHaveLength(3);
    expect(isAppConfigOnlyConflict(conflict)).toBe(true);

    const deleted = parseMergeTreeOutput(
      [
        SHA_A,
        `100644 ${SHA_B} 1\t${APP_CONFIG_PATH}`,
        `100644 ${SHA_B} 2\t${APP_CONFIG_PATH}`,
        '',
        'CONFLICT (modify/delete): x',
        '',
      ].join('\n'),
      false,
    );
    expect(isAppConfigOnlyConflict(deleted)).toBe(false);

    const clean = parseMergeTreeOutput(`${SHA_A}\n\n`, true);
    expect(clean).toEqual({ clean: true, tree: SHA_A, conflicts: [], messages: [] });
    expect(isAppConfigOnlyConflict(clean)).toBe(false);
    expect(() => parseMergeTreeOutput('error: nope\n', false)).toThrow();
  });

  it('reads the repository from either remote URL form', () => {
    expect(parseGitHubRepository('git@github.com:boardsesh/boardsesh.git')).toBe('boardsesh/boardsesh');
    expect(parseGitHubRepository('https://github.com/boardsesh/boardsesh.git\n')).toBe('boardsesh/boardsesh');
    expect(parseGitHubRepository('https://github.com/boardsesh/boardsesh')).toBe('boardsesh/boardsesh');
    expect(() => parseGitHubRepository('/srv/git/repo.git')).toThrow();
  });
});

function workflowRun(overrides: Partial<WorkflowRun>): WorkflowRun {
  return {
    databaseId: 1,
    status: 'completed',
    conclusion: 'success',
    headSha: SHA_A,
    headBranch: RELEASE_BRANCH,
    event: 'push',
    displayTitle: 'run',
    createdAt: '2026-10-19T00:00:00Z',
    url: 'https://github.com/boardsesh/boardsesh/actions/runs/1',
    ...overrides,
  };
}

describe('run decisions', () => {
  it('waits only for in-progress store drafts that pinned release/next', () => {
    const runs = [
      workflowRun({ databaseId: 1, status: 'in_progress', displayTitle: 'Mobile Store Draft (release/next)' }),
      workflowRun({ databaseId: 2, status: 'in_progress', displayTitle: 'Mobile Store Draft (main)' }),
      workflowRun({ databaseId: 3, status: 'queued', displayTitle: 'Mobile Store Draft (release/next)' }),
      workflowRun({ databaseId: 4, status: 'in_progress', displayTitle: 'Mobile Store Draft (release/next) retry' }),
    ];
    expect(activeTrainDraftRuns(runs).map((run) => run.databaseId)).toEqual([1]);
  });

  it('retries only a tip nothing ran at, or an Android run that deferred', () => {
    const decide = (runs: WorkflowRun[], options: { hasBuildTag?: boolean; deferred?: boolean } = {}) =>
      decideBuildRetry({
        hasBuildTag: options.hasBuildTag ?? false,
        runs,
        tipSha: SHA_A,
        version: '2.7.0',
        latestAtTipDeferred: options.deferred ?? false,
      }).action;
    expect(decide([], { hasBuildTag: true })).toBe('skip');
    expect(decide([])).toBe('dispatch');
    expect(decide([workflowRun({ status: 'queued' })])).toBe('skip');
    expect(decide([workflowRun({ status: 'waiting' })])).toBe('skip');
    expect(decide([workflowRun({ status: 'pending' })])).toBe('skip');
    // Android deferred while Play reviewed another release: retry.
    expect(decide([workflowRun({ conclusion: 'success' })], { deferred: true })).toBe('dispatch');
    // Succeeded without a tag (a gate built "to be safe" and could not tag): never
    // an hourly 60-minute rebuild.
    expect(decide([workflowRun({ conclusion: 'success' })])).toBe('skip');
    expect(decide([workflowRun({ conclusion: 'failure' })])).toBe('skip');
    expect(decide([workflowRun({ conclusion: 'cancelled' })])).toBe('skip');
    expect(decide([workflowRun({ conclusion: 'timed_out' })])).toBe('skip');
    // Runs at an older tip say nothing about this one.
    expect(decide([workflowRun({ conclusion: 'failure', headSha: SHA_B })])).toBe('dispatch');
    expect(decide([workflowRun({ conclusion: 'success', headSha: SHA_B })])).toBe('dispatch');
    // Only the newest run at the tip counts.
    expect(
      decide(
        [
          workflowRun({ databaseId: 2, conclusion: 'success', createdAt: '2026-10-19T02:00:00Z' }),
          workflowRun({ databaseId: 1, conclusion: 'failure', createdAt: '2026-10-19T01:00:00Z' }),
        ],
        { deferred: true },
      ),
    ).toBe('dispatch');
  });

  it('recognises a deferred Android run from its jobs', () => {
    const job = (name: string, conclusion: string): RunJob => ({ name, status: 'completed', conclusion });
    expect(
      isDeferredAndroidRun([
        job('gate', 'success'),
        job('play-review', 'success'),
        job('build-and-release', 'skipped'),
      ]),
    ).toBe(true);
    // The fingerprint and version were already built: nothing ran, nothing deferred.
    expect(
      isDeferredAndroidRun([
        job('gate', 'success'),
        job('play-review', 'skipped'),
        job('build-and-release', 'skipped'),
      ]),
    ).toBe(false);
    // The review check failed open and the build ran.
    expect(isDeferredAndroidRun([job('play-review', 'failure'), job('build-and-release', 'success')])).toBe(false);
    expect(isDeferredAndroidRun([])).toBe(false);
  });

  it('parses gh run view jobs and fails on anything else', () => {
    const json = JSON.stringify({
      jobs: [{ name: 'play-review', status: 'completed', conclusion: 'success', steps: [] }],
    });
    expect(parseRunJobs(json)).toEqual([{ name: 'play-review', status: 'completed', conclusion: 'success' }]);
    expect(() => parseRunJobs('{}')).toThrow();
  });

  it('says which permission or rule refused a push', () => {
    const workflows =
      '!\trefs/heads/release/next:refs/heads/release/next\t[remote rejected] (refusing to allow a GitHub App to create or update workflow `.github/workflows/release-train-sync.yml` without `workflows` permission)';
    expect(explainPushFailure(workflows)).toContain('permission-workflows: write');
    const ruleset = [
      'remote: error: GH013: Repository rule violations found for refs/heads/release/next.',
      '!\trefs/heads/release/next:refs/heads/release/next\t[remote rejected] (push declined due to repository rule violations)',
    ].join('\n');
    expect(explainPushFailure(ruleset)).toContain('bypass actor');
    expect(explainPushFailure('[remote rejected] (pre-receive hook declined)')).toContain('rejected the push');
  });

  it('writes the manual merge commands and a per-state marker into the conflict report', () => {
    const report = renderConflictReport({ paths: ['b.ts', 'a.ts'], mainTip: SHA_A, trainTip: SHA_B, runUrl: null });
    expect(report).toContain('`a.ts`');
    expect(report).toContain(`git switch ${RELEASE_BRANCH} && git pull`);
    expect(report).toContain('git merge origin/main');
    expect(report).toContain(`git push origin ${RELEASE_BRANCH}`);
    expect(report).toContain(conflictMarker(SHA_B, ['a.ts', 'b.ts']));
  });

  it('keys the conflict marker on the train commit and the files, not on main', () => {
    expect(conflictMarker(SHA_B, ['b.ts', 'a.ts'])).toBe(conflictMarker(SHA_B, ['a.ts', 'b.ts']));
    expect(conflictMarker(SHA_B, ['a.ts'])).not.toBe(conflictMarker(SHA_B, ['a.ts', 'b.ts']));
    expect(conflictMarker(SHA_C, ['a.ts'])).not.toBe(conflictMarker(SHA_B, ['a.ts']));
    // A path cannot close the HTML comment early.
    expect(conflictMarker(SHA_B, ['weird-->.ts'])).not.toContain('-->.ts');
  });
});

// ─── End to end against real git repositories ──────────────────────────────────

const temporaryRoots: string[] = [];
afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

type Fixture = {
  env: Record<string, string | undefined>;
  origin: string;
  work: string;
  author: string;
  /** Commit files on a branch as a human and push it; returns the new SHA. */
  commit(branch: string, files: Record<string, string>, message: string, from?: string): string;
  remoteSha(branch: string): string | null;
  pushTag(name: string, sha: string): void;
  gitIn(cwd: string, args: string[], allowFailure?: boolean): string;
  readAt(revision: string, path: string): string;
};

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'release-train-sync-'));
  temporaryRoots.push(root);
  const globalConfig = join(root, 'gitconfig');
  writeFileSync(globalConfig, '');
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Human',
    GIT_AUTHOR_EMAIL: 'human@example.com',
    GIT_COMMITTER_NAME: 'Test Human',
    GIT_COMMITTER_EMAIL: 'human@example.com',
  };
  for (const leaked of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_DATE']) {
    delete env[leaked];
  }
  let clock = 1_760_000_000;

  const gitIn = (cwd: string, args: string[], allowFailure = false): string => {
    try {
      return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      if (allowFailure) return '';
      throw error;
    }
  };

  const origin = join(root, 'origin.git');
  const author = join(root, 'author');
  const work = join(root, 'work');
  gitIn(root, ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  gitIn(root, ['init', '--quiet', '--initial-branch=main', author]);
  gitIn(author, ['remote', 'add', 'origin', origin]);

  const writeFiles = (files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(author, path)), { recursive: true });
      writeFileSync(join(author, path), content);
    }
  };
  const commitAndPush = (branch: string, message: string) => {
    clock += 60;
    const dated = { ...env, GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000` };
    gitIn(author, ['add', '-A']);
    execFileSync('git', ['commit', '--quiet', '--no-gpg-sign', '-m', message], { cwd: author, env: dated });
    gitIn(author, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]);
    return gitIn(author, ['rev-parse', 'HEAD']).trim();
  };

  writeFiles({ [APP_CONFIG_PATH]: APP_CONFIG_TEMPLATE('2.6.0'), 'shared.ts': 'export const shared = 1;\n' });
  commitAndPush('main', 'chore: initial');
  gitIn(root, ['clone', '--quiet', origin, work]);

  const remoteSha = (branch: string) => {
    const line = gitIn(author, ['ls-remote', 'origin', `refs/heads/${branch}`]).trim();
    return line === '' ? null : line.split('\t')[0];
  };

  return {
    env,
    origin,
    work,
    author,
    gitIn,
    remoteSha,
    commit(branch, files, message, from) {
      gitIn(author, ['fetch', '--quiet', 'origin']);
      const start = remoteSha(branch) !== null ? `origin/${branch}` : (from ?? 'origin/main');
      gitIn(author, ['checkout', '--quiet', '-B', branch, start]);
      writeFiles(files);
      return commitAndPush(branch, message);
    },
    pushTag(name, sha) {
      gitIn(author, ['fetch', '--quiet', 'origin']);
      gitIn(author, ['tag', name, sha]);
      gitIn(author, ['push', '--quiet', 'origin', `refs/tags/${name}`]);
    },
    readAt(revision, path) {
      gitIn(work, ['fetch', '--quiet', 'origin']);
      return gitIn(work, ['show', `${revision}:${path}`]);
    },
  };
}

type FakeIssue = {
  number: number;
  title: string;
  labels: string[];
  open: boolean;
  bodies: string[];
  closedWith?: string;
};

type FakeGitHub = GitHubClient & {
  mergedBack: unknown[];
  runs: Map<string, WorkflowRun[]>;
  dispatches: { file: string; ref: string; inputs: Record<string, string> }[];
  issues: FakeIssue[];
  jobs: Map<number, RunJob[]>;
  /** Called on every store-draft listing; returns the runs to report. */
  onDraftListing?: (call: number) => WorkflowRun[];
};

function createFakeGitHub(fixture: Fixture): FakeGitHub {
  let draftListings = 0;
  const fake: FakeGitHub = {
    mergedBack: [],
    runs: new Map(),
    dispatches: [],
    issues: [],
    jobs: new Map(),
    listMergedBackPullRequests: () => fake.mergedBack,
    listRunJobs: (runId) => fake.jobs.get(runId) ?? [],
    listWorkflowRuns(file, filter) {
      if (file === STORE_DRAFT_WORKFLOW) {
        draftListings += 1;
        return fake.onDraftListing?.(draftListings) ?? [];
      }
      return (fake.runs.get(file) ?? []).filter((run) => !filter.branch || run.headBranch === filter.branch);
    },
    dispatchWorkflow(file, ref, inputs) {
      fake.dispatches.push({ file, ref, inputs });
      const headSha = fixture.remoteSha(RELEASE_BRANCH) ?? '';
      const runs = fake.runs.get(file) ?? [];
      runs.unshift(
        workflowRun({
          databaseId: 1000 + fake.dispatches.length,
          status: 'queued',
          headSha,
          event: 'workflow_dispatch',
        }),
      );
      fake.runs.set(file, runs);
    },
    findOpenConflictIssue: () =>
      fake.issues.find(
        (issue) => issue.open && issue.title === CONFLICT_ISSUE_TITLE && issue.labels.includes(CONFLICT_ISSUE_LABEL),
      )?.number ?? null,
    issueMentions: (issueNumber, text) =>
      fake.issues.some((issue) => issue.number === issueNumber && issue.bodies.some((body) => body.includes(text))),
    ensureConflictLabel() {},
    createConflictIssue(body) {
      fake.issues.push({
        number: fake.issues.length + 1,
        title: CONFLICT_ISSUE_TITLE,
        labels: [CONFLICT_ISSUE_LABEL],
        open: true,
        bodies: [body],
      });
    },
    commentOnIssue(issueNumber, body) {
      fake.issues.find((issue) => issue.number === issueNumber)?.bodies.push(body);
    },
    closeIssue(issueNumber, comment) {
      const issue = fake.issues.find((candidate) => candidate.number === issueNumber);
      if (issue) Object.assign(issue, { open: false, closedWith: comment });
    },
  };
  return fake;
}

type TestRuntime = SyncRuntime & { logs: string[]; slept: number };

function createRuntime(fixture: Fixture, github: FakeGitHub, overrides: Partial<SyncRuntime> = {}): TestRuntime {
  let clock = 0;
  const runtime: TestRuntime = {
    git: createGitClient({ cwd: fixture.work, remote: 'origin', env: fixture.env }),
    github,
    dryRun: false,
    pushDestination: 'origin',
    runUrl: null,
    logs: [],
    slept: 0,
    log: (line) => runtime.logs.push(line),
    warn: (line) => runtime.logs.push(`warning: ${line}`),
    summary: () => {},
    sleep: async (milliseconds) => {
      clock += milliseconds;
      runtime.slept += milliseconds;
    },
    now: () => clock,
    ...overrides,
  };
  return runtime;
}

/** A human native PR on the train, as #6537 was. */
function landNativeChange(fixture: Fixture, name = 'native.ts'): string {
  if (fixture.remoteSha(RELEASE_BRANCH) === null) {
    fixture.gitIn(fixture.author, ['fetch', '--quiet', 'origin']);
    fixture.gitIn(fixture.author, ['push', '--quiet', 'origin', 'refs/remotes/origin/main:refs/heads/release/next']);
  }
  return fixture.commit(
    RELEASE_BRANCH,
    { [name]: `export const ${name.replace('.ts', '')} = true;\n` },
    `feat(mobile): [native-train] ${name}`,
  );
}

describe('runReleaseTrainSync against real repositories', { timeout: 60_000 }, () => {
  it('creates a missing train from main with the bump, then has nothing to push', async () => {
    const fixture = createFixture();
    const mainTip = fixture.remoteSha('main');
    fixture.pushTag('release/ios-v2.6.0-84dca13e7422', mainTip ?? '');
    const github = createFakeGitHub(fixture);

    const first = await runReleaseTrainSync(createRuntime(fixture, github, { floorVersion: '2.7.0' }));
    expect(first.exitCode).toBe(0);
    expect(first.plan.classification.mode).toBe('create');
    const trainTip = fixture.remoteSha(RELEASE_BRANCH);
    expect(trainTip).toBe(first.pushedSha);

    const bump = fixture.gitIn(fixture.work, [
      'show',
      '-s',
      '--format=%P%n%an <%ae>%n%cn <%ce>%n%ct%n%B',
      trainTip ?? '',
    ]);
    const [parents, authorLine, committerLine, committedAt] = bump.split('\n');
    expect(parents).toBe(mainTip);
    expect(authorLine).toBe(`${BOT_NAME} <${BOT_EMAIL}>`);
    expect(committerLine).toBe(`${BOT_NAME} <${BOT_EMAIL}>`);
    expect(committedAt).toBe(fixture.gitIn(fixture.work, ['show', '-s', '--format=%ct', mainTip ?? '']).trim());
    expect(bump).toContain(versionBumpMessage('2.7.0').trim());
    expect(readMarketingVersion(fixture.readAt(trainTip ?? '', APP_CONFIG_PATH))).toBe('2.7.0');

    const second = await runReleaseTrainSync(createRuntime(fixture, github, { floorVersion: '2.7.0' }));
    expect(second.plan.classification.mode).toBe('recreate-bump');
    expect(second.pushedSha).toBeNull();
    expect(fixture.remoteSha(RELEASE_BRANCH)).toBe(trainTip);
  });

  it('fast-forwards a train with nothing of its own and dispatches builds past a [skip ci] tip', async () => {
    const fixture = createFixture();
    fixture.gitIn(fixture.author, ['push', '--quiet', 'origin', 'refs/remotes/origin/main:refs/heads/release/next']);
    const mainTip = fixture.commit('main', { 'CHANGELOG.md': '# changes\n' }, 'chore: regenerate changelog [skip ci]');
    const github = createFakeGitHub(fixture);
    const runtime = createRuntime(fixture, github);

    const outcome = await runReleaseTrainSync(runtime);
    expect(outcome.plan.classification.mode).toBe('fast-forward');
    expect(outcome.plan.kind === 'ready' && outcome.plan.versionDecision.bump).toBe(false);
    expect(fixture.remoteSha(RELEASE_BRANCH)).toBe(mainTip);
    // Two skip-ci dispatches; the missing-build retry then sees them queued and stays quiet.
    expect(github.dispatches).toEqual(
      NATIVE_WORKFLOWS.map(({ file }) => ({ file, ref: RELEASE_BRANCH, inputs: { force_native: 'false' } })),
    );
  });

  it('recreates the bot bump on a moved main and stays idempotent', async () => {
    const fixture = createFixture();
    fixture.pushTag('release/ios-v2.6.0-84dca13e7422', fixture.remoteSha('main') ?? '');
    const github = createFakeGitHub(fixture);
    await runReleaseTrainSync(createRuntime(fixture, github));
    const oldTrain = fixture.remoteSha(RELEASE_BRANCH);

    const newMain = fixture.commit('main', { 'backend.ts': 'export const backend = 2;\n' }, 'fix(backend): something');
    const outcome = await runReleaseTrainSync(createRuntime(fixture, github));
    expect(outcome.plan.classification.mode).toBe('recreate-bump');
    const newTrain = fixture.remoteSha(RELEASE_BRANCH);
    expect(newTrain).not.toBe(oldTrain);
    expect(fixture.gitIn(fixture.work, ['show', '-s', '--format=%P', newTrain ?? '']).trim()).toBe(newMain);
    expect(readMarketingVersion(fixture.readAt(newTrain ?? '', APP_CONFIG_PATH))).toBe('2.6.1');
    // The old bump is gone from the train's history, not stacked.
    expect(fixture.gitIn(fixture.work, ['rev-list', '--count', `${newMain}..${newTrain}`]).trim()).toBe('1');

    const again = await runReleaseTrainSync(createRuntime(fixture, github));
    expect(again.pushedSha).toBeNull();
  });

  it('merges main into a train with native work, computing the same SHA in a dry run', async () => {
    const fixture = createFixture();
    fixture.pushTag('release/ios-v2.6.0-84dca13e7422', fixture.remoteSha('main') ?? '');
    const nativeTip = landNativeChange(fixture);
    const mainTip = fixture.commit('main', { 'backend.ts': 'export const backend = 2;\n' }, 'fix(backend): something');
    const github = createFakeGitHub(fixture);

    const dryRuntime = createRuntime(fixture, github, { dryRun: true });
    const dry = await runReleaseTrainSync(dryRuntime);
    expect(dry.plan.classification.mode).toBe('merge');
    expect(fixture.remoteSha(RELEASE_BRANCH)).toBe(nativeTip);
    expect(github.dispatches).toEqual([]);
    expect(dryRuntime.logs.some((line) => line.startsWith('dry run: would push'))).toBe(true);

    const live = await runReleaseTrainSync(createRuntime(fixture, github));
    const target = dry.plan.kind === 'ready' ? dry.plan.targetSha : 'missing';
    expect(live.pushedSha).toBe(target);
    expect(fixture.remoteSha(RELEASE_BRANCH)).toBe(target);

    const bumpParent = fixture.gitIn(fixture.work, ['show', '-s', '--format=%P', target]).trim();
    const merge = fixture.gitIn(fixture.work, ['show', '-s', '--format=%P%n%ct%n%an%n%B', bumpParent]).split('\n');
    expect(merge[0]).toBe(`${nativeTip} ${mainTip}`);
    const parentTimes = [nativeTip, mainTip].map((sha) =>
      Number(fixture.gitIn(fixture.work, ['show', '-s', '--format=%ct', sha])),
    );
    expect(Number(merge[1])).toBe(Math.max(...parentTimes));
    expect(merge[2]).toBe(BOT_NAME);
    expect(`${merge.slice(3).join('\n').trim()}\n`).toBe(SYNC_MERGE_MESSAGE);
    expect(readMarketingVersion(fixture.readAt(target, APP_CONFIG_PATH))).toBe('2.6.1');

    const again = await runReleaseTrainSync(createRuntime(fixture, github));
    expect(again.plan.classification.mode).toBe('ahead');
    expect(again.pushedSha).toBeNull();
  });

  it('resolves a conflict confined to the version line to the higher version', async () => {
    const fixture = createFixture();
    landNativeChange(fixture);
    fixture.commit(RELEASE_BRANCH, { [APP_CONFIG_PATH]: APP_CONFIG_TEMPLATE('2.7.0') }, 'chore(mobile): 2.7.0 by hand');
    fixture.commit('main', { [APP_CONFIG_PATH]: APP_CONFIG_TEMPLATE('2.6.1') }, 'chore(mobile): 2.6.1 on main');
    const github = createFakeGitHub(fixture);

    const outcome = await runReleaseTrainSync(createRuntime(fixture, github));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.plan.kind === 'ready' && outcome.plan.baseDescription).toContain('version-line conflict resolved');
    const config = fixture.readAt(fixture.remoteSha(RELEASE_BRANCH) ?? '', APP_CONFIG_PATH);
    expect(config).toBe(APP_CONFIG_TEMPLATE('2.7.0'));
  });

  it('stops at any other conflict, keeps one issue, and closes it once a human merges', async () => {
    const fixture = createFixture();
    landNativeChange(fixture);
    const trainTip = fixture.commit(RELEASE_BRANCH, { 'shared.ts': 'export const shared = 2;\n' }, 'feat: train side');
    fixture.commit('main', { 'shared.ts': 'export const shared = 3;\n' }, 'feat: main side');
    const github = createFakeGitHub(fixture);

    const first = await runReleaseTrainSync(createRuntime(fixture, github));
    expect(first.exitCode).toBe(1);
    expect(first.plan.kind === 'conflict' && first.plan.paths).toEqual(['shared.ts']);
    expect(fixture.remoteSha(RELEASE_BRANCH)).toBe(trainTip);
    expect(github.issues).toHaveLength(1);
    expect(github.issues[0].bodies[0]).toContain('`shared.ts`');

    // Same state again: no duplicate issue and no repeated comment.
    await runReleaseTrainSync(createRuntime(fixture, github));
    expect(github.issues).toHaveLength(1);
    expect(github.issues[0].bodies).toHaveLength(1);

    // main moves on but the conflict is the same one: still no new comment.
    fixture.commit('main', { 'backend.ts': 'export const backend = 2;\n' }, 'fix(backend): something');
    await runReleaseTrainSync(createRuntime(fixture, github));
    expect(github.issues).toHaveLength(1);
    expect(github.issues[0].bodies).toHaveLength(1);

    // The train moves (another native PR lands): the same issue gets one new comment.
    landNativeChange(fixture, 'second.ts');
    await runReleaseTrainSync(createRuntime(fixture, github));
    expect(github.issues).toHaveLength(1);
    expect(github.issues[0].bodies).toHaveLength(2);

    // A human merges main into the train by hand.
    fixture.gitIn(fixture.author, ['fetch', '--quiet', 'origin']);
    fixture.gitIn(fixture.author, ['checkout', '--quiet', '-B', RELEASE_BRANCH, `origin/${RELEASE_BRANCH}`]);
    fixture.gitIn(fixture.author, ['merge', '--no-gpg-sign', 'origin/main'], true);
    writeFileSync(join(fixture.author, 'shared.ts'), 'export const shared = 4;\n');
    fixture.gitIn(fixture.author, ['add', 'shared.ts']);
    fixture.gitIn(fixture.author, ['commit', '--quiet', '--no-gpg-sign', '--no-edit']);
    fixture.gitIn(fixture.author, ['push', '--quiet', 'origin', `HEAD:refs/heads/${RELEASE_BRANCH}`]);

    const resolved = await runReleaseTrainSync(createRuntime(fixture, github));
    expect(resolved.exitCode).toBe(0);
    expect(resolved.plan.classification.mode).toBe('ahead');
    expect(github.issues[0].open).toBe(false);
    expect(github.issues[0].closedWith).toContain('in sync');
  });

  it('restarts from main after a squash merge-back and bumps past the shipped version', async () => {
    const fixture = createFixture();
    const nativeTip = landNativeChange(fixture);
    const squash = fixture.commit(
      'main',
      { 'native.ts': 'export const native = true;\n', [APP_CONFIG_PATH]: APP_CONFIG_TEMPLATE('2.7.0') },
      'Release 2.7.0 (#6600)',
    );
    const github = createFakeGitHub(fixture);
    github.mergedBack = [
      {
        number: 6600,
        mergedAt: '2026-10-20T00:00:00Z',
        mergeCommit: { oid: squash },
        headRefOid: nativeTip,
        isCrossRepository: false,
      },
    ];

    const outcome = await runReleaseTrainSync(createRuntime(fixture, github));
    expect(outcome.plan.classification.mode).toBe('reset-after-merge-back');
    const trainTip = fixture.remoteSha(RELEASE_BRANCH) ?? '';
    expect(fixture.gitIn(fixture.work, ['show', '-s', '--format=%P', trainTip]).trim()).toBe(squash);
    expect(readMarketingVersion(fixture.readAt(trainTip, APP_CONFIG_PATH))).toBe('2.7.1');
  });

  it('waits for a release/next store draft, then plans again from what changed meanwhile', async () => {
    const fixture = createFixture();
    landNativeChange(fixture);
    fixture.commit('main', { 'backend.ts': 'export const backend = 2;\n' }, 'fix(backend): before the run');
    const github = createFakeGitHub(fixture);
    let movedMain = '';
    github.onDraftListing = (call) => {
      if (call === 2)
        movedMain = fixture.commit('main', { 'backend.ts': 'export const backend = 9;\n' }, 'fix: during the wait');
      return call <= 2
        ? [
            workflowRun({ databaseId: 77, status: 'in_progress', displayTitle: 'Mobile Store Draft (release/next)' }),
            workflowRun({ databaseId: 78, status: 'in_progress', displayTitle: 'Mobile Store Draft (main)' }),
          ]
        : [];
    };
    const runtime = createRuntime(fixture, github);

    const outcome = await runReleaseTrainSync(runtime);
    expect(runtime.slept).toBeGreaterThanOrEqual(60_000);
    expect(outcome.pushedSha).not.toBeNull();
    // The pushed merge includes the commit that landed on main during the wait.
    expect(
      fixture.gitIn(fixture.work, ['merge-base', '--is-ancestor', movedMain, outcome.pushedSha ?? '']).trim(),
    ).toBe('');
  });

  it('recomputes when release/next moves between planning and pushing', async () => {
    const fixture = createFixture();
    landNativeChange(fixture);
    fixture.commit('main', { 'backend.ts': 'export const backend = 2;\n' }, 'fix(backend): something');
    const github = createFakeGitHub(fixture);
    let lateNative = '';
    github.onDraftListing = (call) => {
      // Lands after the first plan read release/next, before its push.
      if (call === 1) lateNative = landNativeChange(fixture, 'late.ts');
      return [];
    };
    const runtime = createRuntime(fixture, github);

    const outcome = await runReleaseTrainSync(runtime);
    expect(outcome.exitCode).toBe(0);
    expect(runtime.logs.some((line) => line.includes('moved while this run planned'))).toBe(true);
    expect(
      fixture.gitIn(fixture.work, ['merge-base', '--is-ancestor', lateNative, outcome.pushedSha ?? '']).trim(),
    ).toBe('');
  });

  it('stops after MAX_PUSH_ATTEMPTS lease rejections, with no further push', async () => {
    const fixture = createFixture();
    landNativeChange(fixture);
    fixture.commit('main', { 'backend.ts': 'export const backend = 2;\n' }, 'fix(backend): something');
    const github = createFakeGitHub(fixture);
    // Someone lands a native PR between every plan and its push.
    let lastRacing = '';
    github.onDraftListing = (call) => {
      lastRacing = landNativeChange(fixture, `racing-${call}.ts`);
      return [];
    };
    const runtime = createRuntime(fixture, github);
    const realGit = runtime.git;
    const pushResults: boolean[] = [];
    runtime.git = {
      ...realGit,
      push: (input) => {
        const result = realGit.push(input);
        pushResults.push(result.ok);
        return result;
      },
    };

    await expect(runReleaseTrainSync(runtime)).rejects.toThrow(
      new RegExp(`moved between planning and pushing on all ${MAX_PUSH_ATTEMPTS} attempts`),
    );
    expect(pushResults).toEqual(Array.from({ length: MAX_PUSH_ATTEMPTS }, () => false));
    expect(runtime.logs.filter((line) => line.includes('moved while this run planned'))).toHaveLength(
      MAX_PUSH_ATTEMPTS - 1,
    );
    // The branch still holds the last racing commit: the sync overwrote nothing.
    expect(fixture.remoteSha(RELEASE_BRANCH)).toBe(lastRacing);
  });

  it('waits out a store draft that never finishes, warns, then plans again and pushes once', async () => {
    const fixture = createFixture();
    landNativeChange(fixture);
    fixture.commit('main', { 'backend.ts': 'export const backend = 2;\n' }, 'fix(backend): before the run');
    const github = createFakeGitHub(fixture);
    let movedMain = '';
    github.onDraftListing = (call) => {
      // main moves on while the sync waits for the stuck draft.
      if (call === 2) {
        movedMain = fixture.commit('main', { 'backend.ts': 'export const backend = 9;\n' }, 'fix: during the wait');
      }
      return [
        workflowRun({ databaseId: 77, status: 'in_progress', displayTitle: 'Mobile Store Draft (release/next)' }),
      ];
    };
    const runtime = createRuntime(fixture, github);
    const realGit = runtime.git;
    const pushedAt: number[] = [];
    runtime.git = {
      ...realGit,
      push: (input) => {
        pushedAt.push(runtime.now());
        return realGit.push(input);
      },
    };

    const outcome = await runReleaseTrainSync(runtime);
    expect(outcome.exitCode).toBe(0);
    // Exactly one push, made once the wait reached its deadline and not before.
    expect(pushedAt).toEqual([DRAFT_WAIT_MAX_MS]);
    expect(runtime.logs.filter((line) => line.startsWith('warning: A store draft for release/next'))).toHaveLength(1);
    expect(fixture.remoteSha(RELEASE_BRANCH)).toBe(outcome.pushedSha);
    // The push was planned after the wait, so it carries what landed on main meanwhile.
    expect(
      fixture.gitIn(fixture.work, ['merge-base', '--is-ancestor', movedMain, outcome.pushedSha ?? '']).trim(),
    ).toBe('');
  });

  it('dispatches a missing version build on a run with nothing to push', async () => {
    const fixture = createFixture();
    const github = createFakeGitHub(fixture);
    await runReleaseTrainSync(createRuntime(fixture, github));
    const trainTip = fixture.remoteSha(RELEASE_BRANCH) ?? '';
    fixture.pushTag('build-ios-v2.6.0-5-a7cb366b87a0', trainTip);
    // A success without a tag that did not defer stays down: no hourly rebuild.
    github.runs.set('android-apk-rn.yml', [workflowRun({ databaseId: 501, headSha: trainTip, conclusion: 'success' })]);
    github.jobs.set(501, [
      { name: 'play-review', status: 'completed', conclusion: 'skipped' },
      { name: 'build-and-release', status: 'completed', conclusion: 'success' },
    ]);
    github.dispatches.length = 0;
    await runReleaseTrainSync(createRuntime(fixture, github));
    expect(github.dispatches).toEqual([]);

    // Android deferred (a Play review was pending): success, no tag, build job skipped.
    github.jobs.set(501, [
      { name: 'play-review', status: 'completed', conclusion: 'success' },
      { name: 'build-and-release', status: 'completed', conclusion: 'skipped' },
    ]);
    const outcome = await runReleaseTrainSync(createRuntime(fixture, github));
    expect(outcome.pushedSha).toBeNull();
    expect(github.dispatches).toEqual([
      { file: 'android-apk-rn.yml', ref: RELEASE_BRANCH, inputs: { force_native: 'false' } },
    ]);
  });

  it('fails with the fix spelled out when GitHub refuses the push', async () => {
    const fixture = createFixture();
    // Stand in for GitHub refusing an App token without the Workflows permission.
    const hook = join(fixture.origin, 'hooks', 'pre-receive');
    writeFileSync(
      hook,
      '#!/bin/sh\necho "refusing to allow a GitHub App to create or update workflow `.github/workflows/x.yml` without `workflows` permission" >&2\nexit 1\n',
    );
    chmodSync(hook, 0o755);
    const github = createFakeGitHub(fixture);
    const runtime = createRuntime(fixture, github);
    await expect(runReleaseTrainSync(runtime)).rejects.toThrow(/permission-workflows: write/);
    expect(fixture.remoteSha(RELEASE_BRANCH)).toBeNull();
  });

  it('keeps 2.7.0 when the floor goes away, and moves on once 2.7.0 is taken', async () => {
    const fixture = createFixture();
    fixture.pushTag('release/ios-v2.6.0-84dca13e7422', fixture.remoteSha('main') ?? '');
    const github = createFakeGitHub(fixture);
    await runReleaseTrainSync(createRuntime(fixture, github, { floorVersion: '2.7.0' }));
    const versionAtTip = () =>
      readMarketingVersion(fixture.readAt(fixture.remoteSha(RELEASE_BRANCH) ?? '', APP_CONFIG_PATH));
    expect(versionAtTip()).toBe('2.7.0');

    // The floor variable is deleted and main moves on, still at 2.6.0.
    const newMain = fixture.commit('main', { 'backend.ts': 'export const backend = 2;\n' }, 'fix(backend): something');
    const withoutFloor = await runReleaseTrainSync(createRuntime(fixture, github));
    expect(withoutFloor.plan.classification.mode).toBe('recreate-bump');
    const trainTip = fixture.remoteSha(RELEASE_BRANCH) ?? '';
    expect(fixture.gitIn(fixture.work, ['show', '-s', '--format=%P', trainTip]).trim()).toBe(newMain);
    expect(versionAtTip()).toBe('2.7.0');

    // Apple accepts 2.7.0: the normal next-patch rule takes over.
    fixture.pushTag('release/ios-v2.7.0-0123456789ab', trainTip);
    await runReleaseTrainSync(createRuntime(fixture, github));
    expect(versionAtTip()).toBe('2.7.1');
  });

  it('keeps a hand-made bump commit as it is, then recreates it as the bot on the next main', async () => {
    const fixture = createFixture();
    fixture.pushTag('release/ios-v2.6.0-84dca13e7422', fixture.remoteSha('main') ?? '');
    // Marco opens the train by hand, with the trailer, as a human author.
    const manual = fixture.commit(
      RELEASE_BRANCH,
      { [APP_CONFIG_PATH]: APP_CONFIG_TEMPLATE('2.7.0') },
      versionBumpMessage('2.7.0').trim(),
      'origin/main',
    );
    const github = createFakeGitHub(fixture);

    const first = await runReleaseTrainSync(createRuntime(fixture, github));
    expect(first.plan.classification.mode).toBe('recreate-bump');
    expect(first.plan.kind === 'ready' && first.plan.versionDecision.targetVersion).toBe('2.7.0');
    expect(first.pushedSha).toBeNull();
    expect(fixture.remoteSha(RELEASE_BRANCH)).toBe(manual);

    const newMain = fixture.commit('main', { 'backend.ts': 'export const backend = 2;\n' }, 'fix(backend): something');
    const second = await runReleaseTrainSync(createRuntime(fixture, github));
    const trainTip = second.pushedSha ?? '';
    const [parents, authorName] = fixture.gitIn(fixture.work, ['show', '-s', '--format=%P%n%an', trainTip]).split('\n');
    expect(parents).toBe(newMain);
    expect(authorName).toBe(BOT_NAME);
    expect(readMarketingVersion(fixture.readAt(trainTip, APP_CONFIG_PATH))).toBe('2.7.0');
  });

  it('never drops release notes riding on a commit with the bump trailer', async () => {
    const fixture = createFixture();
    fixture.commit(
      RELEASE_BRANCH,
      { [APP_CONFIG_PATH]: APP_CONFIG_TEMPLATE('2.7.0'), 'notes.txt': 'Lock Screen timer\n' },
      versionBumpMessage('2.7.0').trim(),
      'origin/main',
    );
    const github = createFakeGitHub(fixture);

    const first = await runReleaseTrainSync(createRuntime(fixture, github));
    expect(first.plan.classification.mode).toBe('ahead');
    expect(first.pushedSha).toBeNull();

    fixture.commit('main', { 'backend.ts': 'export const backend = 2;\n' }, 'fix(backend): something');
    const second = await runReleaseTrainSync(createRuntime(fixture, github));
    expect(second.plan.classification.mode).toBe('merge');
    const trainTip = fixture.remoteSha(RELEASE_BRANCH) ?? '';
    expect(fixture.readAt(trainTip, 'notes.txt')).toBe('Lock Screen timer\n');
    expect(readMarketingVersion(fixture.readAt(trainTip, APP_CONFIG_PATH))).toBe('2.7.0');
  });

  it('plans a missing train without writing to origin', () => {
    const fixture = createFixture();
    const github = createFakeGitHub(fixture);
    const plan = computeSyncPlan(createRuntime(fixture, github));
    expect(plan).toMatchObject({ kind: 'ready', trainTip: null, needsPush: true });
    expect(fixture.remoteSha(RELEASE_BRANCH)).toBeNull();
  });

  it('keeps the push token out of a failed push report', () => {
    const fixture = createFixture();
    const git = createGitClient({ cwd: fixture.work, remote: 'origin', env: fixture.env });
    const secret = 'ghs_not-a-real-token';
    const outcome = git.push({
      destination: join(fixture.work, secret, 'missing.git'),
      targetSha: fixture.remoteSha('main') ?? '',
      expectedTrainSha: null,
      secret,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.output).not.toContain(secret);
    expect(outcome.ok === false && outcome.leaseRejected).toBe(false);
  });
});

// ─── Workflow contract ──────────────────────────────────────────────────────────

type WorkflowStep = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
};

describe('release-train-sync.yml', () => {
  const source = readFileSync('.github/workflows/release-train-sync.yml', 'utf8');
  const workflow = parse(source) as {
    name: string;
    on: Record<string, Record<string, unknown> | Record<string, unknown>[]>;
    concurrency: { group: string; 'cancel-in-progress': boolean };
    permissions: Record<string, string>;
    jobs: Record<string, { environment?: unknown; steps: WorkflowStep[] }>;
  };
  const triggers = workflow.on as {
    push: { branches: string[] };
    workflow_run: { workflows: string[]; types: string[]; branches: string[] };
    schedule: { cron: string }[];
    workflow_dispatch: { inputs: { dry_run: { type: string; default: boolean } } };
  };
  const [job] = Object.values(workflow.jobs);
  const steps = job.steps;
  const workflowName = (file: string) =>
    (parse(readFileSync(`.github/workflows/${file}`, 'utf8')) as { name: string }).name;

  it('runs on main pushes, after the anchor and deploy workflows, hourly and on demand', () => {
    expect(workflow.name).toBe('Release Train Sync');
    expect(triggers.push.branches).toEqual(['main']);
    expect(triggers.workflow_run.workflows).toEqual([
      workflowName('mobile-auto-version-bump.yml'),
      workflowName('production-deploy.yml'),
    ]);
    expect(triggers.workflow_run.workflows).toEqual(['Mobile Release Anchor', 'Production Deploy']);
    expect(triggers.workflow_run.types).toEqual(['completed']);
    expect(triggers.workflow_run.branches).toEqual(['main']);
    expect(triggers.schedule).toHaveLength(1);
    expect(triggers.schedule[0].cron).toMatch(/^([1-9]|[1-5][0-9]) \* \* \* \*$/);
    expect(triggers.workflow_dispatch.inputs.dry_run).toMatchObject({ type: 'boolean', default: false });
  });

  it('serializes live runs without cancelling and keeps dry runs out of their group', () => {
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    expect(workflow.concurrency.group).toContain("'release-train-sync'");
    expect(workflow.concurrency.group).toContain('inputs.dry_run');
    expect(workflow.concurrency.group).toContain('github.run_id');
  });

  it('asks GITHUB_TOKEN only for what the script uses and needs no environment', () => {
    expect(workflow.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
      issues: 'write',
      actions: 'write',
    });
    expect(job.environment).toBeUndefined();
  });

  it('pushes with the App token and never persists it', () => {
    const mint = steps.find((step) => step.uses?.startsWith('actions/create-github-app-token@'));
    expect(mint?.with).toEqual({
      'app-id': '${{ vars.OTA_PUSH_APP_ID }}',
      'private-key': '${{ secrets.OTA_PUSH_APP_PRIVATE_KEY }}',
      'permission-contents': 'write',
      // A sync carrying main's .github/workflows/ edits is refused without it.
      'permission-workflows': 'write',
    });
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with).toEqual({ ref: 'main', 'fetch-depth': 0, 'fetch-tags': true, 'persist-credentials': false });

    const sync = steps.find((step) => step.run?.includes('scripts/release-train-sync.ts'));
    expect(sync?.run).toContain('node --import tsx scripts/release-train-sync.ts');
    expect(sync?.run).toContain('--dry-run');
    expect(sync?.env).toMatchObject({
      GH_TOKEN: '${{ github.token }}',
      PUSH_TOKEN: `\${{ steps.${mint?.id}.outputs.token }}`,
      RELEASE_TRAIN_MIN_VERSION: '${{ vars.RELEASE_TRAIN_MIN_VERSION }}',
    });
    expect(steps.some((step) => step.uses?.startsWith('voidzero-dev/setup-vp@'))).toBe(true);
    expect(steps.some((step) => step.run === 'vp install --frozen-lockfile')).toBe(true);
  });

  it('mints the token after install, directly before the only step that uses it', () => {
    const mintIndex = steps.findIndex((step) => step.uses?.startsWith('actions/create-github-app-token@'));
    const installIndex = steps.findIndex((step) => step.run === 'vp install --frozen-lockfile');
    const syncIndex = steps.findIndex((step) => step.run?.includes('scripts/release-train-sync.ts'));
    expect(installIndex).toBeGreaterThan(-1);
    expect(mintIndex).toBeGreaterThan(installIndex);
    expect(syncIndex).toBe(mintIndex + 1);
    const tokenUsers = steps.filter((step) => JSON.stringify(step).includes('steps.push_token.outputs.token'));
    expect(tokenUsers).toEqual([steps[syncIndex]]);
  });

  // isDeferredAndroidRun reads these job names from `gh run view --json jobs`.
  it('reads the Android deferral from jobs that exist under those names', () => {
    const android = parse(readFileSync('.github/workflows/android-apk-rn.yml', 'utf8')) as {
      jobs: Record<string, { name?: string; needs?: string | string[] }>;
    };
    expect(android.jobs).toHaveProperty(ANDROID_REVIEW_JOB);
    expect(android.jobs).toHaveProperty(ANDROID_BUILD_JOB);
    expect(android.jobs[ANDROID_REVIEW_JOB].name).toBeUndefined();
    expect(android.jobs[ANDROID_BUILD_JOB].name).toBeUndefined();
    expect(android.jobs[ANDROID_BUILD_JOB].needs).toContain(ANDROID_REVIEW_JOB);
  });

  it('dispatches only workflows that accept force_native', () => {
    for (const { file } of NATIVE_WORKFLOWS) {
      const native = parse(readFileSync(`.github/workflows/${file}`, 'utf8')) as {
        on: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
      };
      expect(native.on.workflow_dispatch?.inputs, file).toHaveProperty('force_native');
    }
  });

  it('waits on store drafts whose run name carries the branch in parentheses', () => {
    const draft = parse(readFileSync(`.github/workflows/${STORE_DRAFT_WORKFLOW}`, 'utf8')) as { 'run-name'?: string };
    expect(draft['run-name']).toMatch(/\(\$\{\{.*\}\}\)/);
  });
});
