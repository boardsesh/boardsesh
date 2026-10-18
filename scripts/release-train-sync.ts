/// <reference types="node" />

/**
 * Keeps the native release train (`release/next`) in step with `main`, and keeps a
 * marketing version on it that no store has released yet. Run by
 * .github/workflows/release-train-sync.yml on every push to main, after the release
 * anchor and production deploy workflows, and hourly.
 *
 * How the train follows main (the "hybrid" sync):
 *   - release/next is missing, or has nothing of its own, or is still at the head of
 *     the last merged-back PR (a squash merge-back leaves it there) → it moves to main.
 *   - release/next only carries version-bump commits (the `Release-Train: version-bump`
 *     trailer, and nothing changed but the `version:` line, whoever wrote them) → they
 *     are dropped and the bump is recreated on top of main. A trailer commit that also
 *     changes anything else counts as the train's own work and is never dropped.
 *   - release/next carries native work → main is merged in with a merge commit.
 * Never a rebase: scripts/generate-changelog.ts keeps a PR only when its merge commit
 * is an ancestor of HEAD, so rewriting the train's own merge commits would drop their
 * release notes.
 *
 * The version never goes backwards: the version release/next already carries is a
 * lower bound until it is taken (merged back or anchored), so removing the floor
 * variable or recreating the bump on an older main keeps it.
 *
 * Every commit this script writes is deterministic (fixed identity, fixed message,
 * dates taken from the parents), so a run with nothing new computes the SHA that is
 * already on the branch and pushes nothing.
 *
 * Usage:
 *   node --import tsx scripts/release-train-sync.ts --dry-run   # plan only, no remote writes
 *   node --import tsx scripts/release-train-sync.ts             # CI only: needs PUSH_TOKEN
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MAIN_BRANCH = 'main';
export const RELEASE_BRANCH = 'release/next';
export const APP_CONFIG_PATH = 'packages/mobile/app.config.ts';

export const BOT_NAME = 'boardsesh-repo-bot[bot]';
export const BOT_EMAIL = 'boardsesh-repo-bot[bot]@users.noreply.github.com';

export const RELEASE_TRAIN_TRAILER = 'Release-Train';
export const VERSION_BUMP_TRAILER_VALUE = 'version-bump';
export const SYNC_TRAILER_VALUE = 'sync';

export const SYNC_MERGE_MESSAGE = `chore(release): sync main into release/next\n\n${RELEASE_TRAIN_TRAILER}: ${SYNC_TRAILER_VALUE}\n`;

export function versionBumpMessage(version: string): string {
  return `chore(mobile): open release train at v${version}\n\n${RELEASE_TRAIN_TRAILER}: ${VERSION_BUMP_TRAILER_VALUE}\n`;
}

export const CONFLICT_ISSUE_TITLE = 'release/next sync blocked by a merge conflict';
export const CONFLICT_ISSUE_LABEL = 'release-train';

export type Platform = 'ios' | 'android';

/** The two native build workflows the train's pushes start. */
export const NATIVE_WORKFLOWS: readonly { platform: Platform; file: string }[] = [
  { platform: 'ios', file: 'ios-testflight-rn.yml' },
  { platform: 'android', file: 'android-apk-rn.yml' },
];

/** Pins the release branch's SHA and aborts if it moves mid-run. */
export const STORE_DRAFT_WORKFLOW = 'mobile-store-draft.yml';

export const DRAFT_WAIT_POLL_MS = 30_000;
export const DRAFT_WAIT_MAX_MS = 30 * 60_000;
/** How long to wait for GitHub to register the runs a push or dispatch just started. */
export const RUN_REGISTRATION_WAIT_MS = 60_000;
export const RUN_REGISTRATION_POLL_MS = 10_000;
/** Lease rejections (someone pushed release/next mid-run) recompute and retry this often. */
export const MAX_PUSH_ATTEMPTS = 3;

// ─── Versions ───────────────────────────────────────────────────────────────────

const STRICT_SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export type Semver = readonly [major: number, minor: number, patch: number];

export function parseSemver(version: string): Semver {
  const match = STRICT_SEMVER.exec(version);
  if (!match) throw new Error(`"${version}" is not a plain major.minor.patch version.`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareSemver(left: string, right: string): number {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function highestVersion(versions: readonly string[]): string | undefined {
  return versions.reduce<string | undefined>(
    (highest, version) => (highest === undefined || compareSemver(version, highest) > 0 ? version : highest),
    undefined,
  );
}

function nextPatch(version: string): string {
  const [major, minor, patch] = parseSemver(version);
  return `${major}.${minor}.${patch + 1}`;
}

export type VersionInputs = {
  /** The version on the commit the train will sit on before any bump. */
  baseVersion: string;
  /**
   * The version at origin/release/next's tip before this run, if the branch exists.
   * A lower bound: the train never moves to an older version than it already carries.
   */
  currentTrainVersion?: string;
  /** The version at the merge commit of the most recent merged-back PR. */
  lastMergedBackVersion?: string;
  /** Versions with a release/ios-v<version>-* anchor, i.e. accepted by Apple. */
  anchoredIosVersions: readonly string[];
  /** vars.RELEASE_TRAIN_MIN_VERSION: the lever for minor and major bumps. */
  floorVersion?: string;
};

export type VersionDecision = {
  baseVersion: string;
  targetVersion: string;
  bump: boolean;
  reason: string;
};

/**
 * PURE: a version is taken once it was merged back, or once Apple accepted it or any
 * higher version: App Store Connect refuses a version at or below the last approved
 * one, so everything up to the highest release/ios-v<version>-* anchor is spent.
 */
export function isVersionTaken(
  version: string,
  inputs: Pick<VersionInputs, 'lastMergedBackVersion' | 'anchoredIosVersions'>,
): boolean {
  if (inputs.lastMergedBackVersion !== undefined && compareSemver(version, inputs.lastMergedBackVersion) <= 0) {
    return true;
  }
  const highestAnchor = highestVersion(inputs.anchoredIosVersions);
  return highestAnchor !== undefined && compareSemver(version, highestAnchor) <= 0;
}

/**
 * PURE: the version the train should carry.
 *
 * The base version stays when nobody released it. Otherwise the train takes the
 * smallest patch above everything released so far. Two lower
 * bounds then apply, each only when it is higher:
 *   - the version release/next already carries. The train never goes backwards, so
 *     removing the floor, or recreating the bump on a main that is still on the old
 *     version, keeps it. Once that version is taken, the next free patch above it
 *     applies instead.
 *   - the floor (RELEASE_TRAIN_MIN_VERSION) when it is still free, which is how the
 *     train opens a new minor or major.
 */
export function nextVersion(inputs: VersionInputs): VersionDecision {
  const { baseVersion, currentTrainVersion, lastMergedBackVersion, anchoredIosVersions, floorVersion } = inputs;
  parseSemver(baseVersion);
  const anchored = new Set(anchoredIosVersions.map((version) => parseSemver(version).join('.')));
  const reasons: string[] = [];
  const highestAnchor = highestVersion(anchoredIosVersions);
  // The smallest patch above `version` and everything released; free by definition.
  const nextFreePatchAbove = (version: string) => {
    const released = highestVersion(
      [version, lastMergedBackVersion, highestAnchor].filter(
        (candidate): candidate is string => candidate !== undefined,
      ),
    );
    return nextPatch(released ?? version);
  };

  let candidate = baseVersion;
  if (isVersionTaken(baseVersion, inputs)) {
    const takenBecause = [
      lastMergedBackVersion !== undefined && compareSemver(baseVersion, lastMergedBackVersion) <= 0
        ? `the last merge-back shipped ${lastMergedBackVersion}`
        : null,
      anchored.has(baseVersion)
        ? `Apple accepted it: release/ios-v${baseVersion}-* exists`
        : highestAnchor !== undefined && compareSemver(baseVersion, highestAnchor) < 0
          ? `Apple already accepted ${highestAnchor}, and App Store Connect only takes higher versions`
          : null,
    ].filter((because): because is string => because !== null);
    candidate = nextFreePatchAbove(baseVersion);
    reasons.push(`${baseVersion} is taken (${takenBecause.join('; ')}); next free patch is ${candidate}`);
  } else {
    reasons.push(`${baseVersion} has not been released`);
  }

  if (currentTrainVersion !== undefined) {
    parseSemver(currentTrainVersion);
    if (compareSemver(currentTrainVersion, candidate) > 0) {
      if (isVersionTaken(currentTrainVersion, inputs)) {
        candidate = nextFreePatchAbove(currentTrainVersion);
        reasons.push(
          `${RELEASE_BRANCH} carried ${currentTrainVersion}, which is now taken, so it moves on to ${candidate}`,
        );
      } else {
        candidate = currentTrainVersion;
        reasons.push(`${RELEASE_BRANCH} already carries ${currentTrainVersion}, which is free, so it keeps it`);
      }
    }
  }

  if (floorVersion !== undefined) {
    parseSemver(floorVersion);
    if (isVersionTaken(floorVersion, inputs)) {
      reasons.push(`floor ${floorVersion} is already taken, so it is ignored`);
    } else if (compareSemver(floorVersion, candidate) > 0) {
      reasons.push(`floor ${floorVersion} is higher, so the train opens at ${floorVersion}`);
      candidate = floorVersion;
    }
  }

  return { baseVersion, targetVersion: candidate, bump: candidate !== baseVersion, reason: reasons.join('; ') };
}

// The `version:` line in packages/mobile/app.config.ts: indented, single-quoted,
// trailing comma. Three readers parse it (ios-testflight-rn.yml, fastlane/Fastfile,
// scripts/mobile-auto-version-bump.ts); the tests run all three on our output.
const VERSION_LINE = /^([ \t]*version:\s*')(\d+\.\d+\.\d+)(',?[ \t]*)$/;

function versionLineIndexes(lines: readonly string[]): number[] {
  return lines.flatMap((line, index) => (VERSION_LINE.test(line) ? [index] : []));
}

/** PURE: the marketing version in app.config.ts. Throws unless exactly one line matches. */
export function readMarketingVersion(appConfigText: string): string {
  const lines = appConfigText.split('\n');
  const indexes = versionLineIndexes(lines);
  if (indexes.length !== 1) {
    throw new Error(`Expected exactly one \`version: 'x.y.z',\` line in ${APP_CONFIG_PATH}, found ${indexes.length}.`);
  }
  const match = VERSION_LINE.exec(lines[indexes[0]]);
  if (!match) throw new Error(`Could not read the version line in ${APP_CONFIG_PATH}.`);
  return match[2];
}

/** PURE: rewrite only the single `version: 'x.y.z',` line. */
export function bumpVersionSource(appConfigText: string, version: string): string {
  parseSemver(version);
  const lines = appConfigText.split('\n');
  const indexes = versionLineIndexes(lines);
  if (indexes.length !== 1) {
    throw new Error(`Expected exactly one \`version: 'x.y.z',\` line in ${APP_CONFIG_PATH}, found ${indexes.length}.`);
  }
  const [lineIndex] = indexes;
  lines[lineIndex] = lines[lineIndex].replace(VERSION_LINE, (_line, prefix: string, _old: string, suffix: string) => {
    return `${prefix}${version}${suffix}`;
  });
  return lines.join('\n');
}

/**
 * PURE: resolve a merge whose only conflict is the version line, to the higher
 * version. Returns null for anything else: more than one conflict block, or a block
 * where either side is more than that one line. Accepts merge and diff3 styles.
 */
export function resolveVersionOnlyConflict(textWithMarkers: string): string | null {
  const lines = textWithMarkers.split('\n');
  const isMarker = (line: string) =>
    line.startsWith('<<<<<<<') || line.startsWith('|||||||') || line === '=======' || line.startsWith('>>>>>>>');
  const starts = lines.flatMap((line, index) => (line.startsWith('<<<<<<<') ? [index] : []));
  if (starts.length !== 1) return null;
  const [start] = starts;
  if (lines.slice(0, start).some(isMarker)) return null;

  const ours: string[] = [];
  const theirs: string[] = [];
  let base: string[] | null = null;
  let section: 'ours' | 'base' | 'theirs' = 'ours';
  let end = -1;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('|||||||')) {
      if (section !== 'ours') return null;
      section = 'base';
      base = [];
    } else if (line === '=======') {
      if (section === 'theirs') return null;
      section = 'theirs';
    } else if (line.startsWith('>>>>>>>')) {
      if (section !== 'theirs') return null;
      end = index;
      break;
    } else if (line.startsWith('<<<<<<<')) {
      return null;
    } else if (section === 'ours') {
      ours.push(line);
    } else if (section === 'base') {
      base?.push(line);
    } else {
      theirs.push(line);
    }
  }
  if (end === -1) return null;
  if (lines.slice(end + 1).some(isMarker)) return null;
  if (ours.length !== 1 || theirs.length !== 1) return null;
  const oursMatch = VERSION_LINE.exec(ours[0]);
  const theirsMatch = VERSION_LINE.exec(theirs[0]);
  if (!oursMatch || !theirsMatch) return null;
  if (base !== null && !(base.length === 0 || (base.length === 1 && VERSION_LINE.test(base[0])))) return null;

  const winner = compareSemver(oursMatch[2], theirsMatch[2]) >= 0 ? ours[0] : theirs[0];
  return [...lines.slice(0, start), winner, ...lines.slice(end + 1)].join('\n');
}

// ─── Commit messages ────────────────────────────────────────────────────────────

export type Trailer = { key: string; value: string };

/** PURE: `Key: value` lines of the message's last paragraph (never the subject). */
export function parseTrailers(message: string): Trailer[] {
  const paragraphs = message
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n[ \t]*\n/);
  if (paragraphs.length < 2) return [];
  const lastParagraph = paragraphs[paragraphs.length - 1];
  return lastParagraph.split('\n').flatMap((line) => {
    const match = /^([A-Za-z0-9][A-Za-z0-9-]*):\s*(.*?)\s*$/.exec(line);
    return match ? [{ key: match[1], value: match[2] }] : [];
  });
}

export function hasReleaseTrainTrailer(message: string, value: string): boolean {
  return parseTrailers(message).some(
    (trailer) =>
      trailer.key.toLowerCase() === RELEASE_TRAIN_TRAILER.toLowerCase() &&
      trailer.value.toLowerCase() === value.toLowerCase(),
  );
}

const SKIP_CI_MARKERS = ['[skip ci]', '[ci skip]', '[no ci]', '[skip actions]', '[actions skip]'] as const;

/**
 * PURE: would GitHub suppress push-triggered workflows for a push whose head commit
 * has this message? Deliberately generous (a `skip-checks: true` line anywhere
 * counts): a false positive only dispatches builds whose gates then skip.
 */
export function hasSkipCiMarker(message: string): boolean {
  const lowered = message.toLowerCase();
  if (SKIP_CI_MARKERS.some((marker) => lowered.includes(marker))) return true;
  return /^[ \t]*skip-checks:\s*true[ \t]*$/im.test(message);
}

// ─── Classification ─────────────────────────────────────────────────────────────

export type TrainCommit = {
  sha: string;
  message: string;
  /**
   * True when the commit has one parent and changes nothing but the `version:` line
   * of app.config.ts. Only such commits are safe to drop and recreate: a hand-made
   * commit that carries the bump trailer AND release notes must never lose the notes.
   */
  versionOnly?: boolean;
};

/** PURE: does `after` differ from `before` only in the marketing version line? */
export function isVersionOnlyChange(before: string, after: string): boolean {
  try {
    return bumpVersionSource(before, readMarketingVersion(after)) === after;
  } catch {
    return false;
  }
}

/** PURE: a bump commit this script may drop and recreate on top of main. */
export function isDroppableBump(commit: TrainCommit): boolean {
  return commit.versionOnly === true && hasReleaseTrainTrailer(commit.message, VERSION_BUMP_TRAILER_VALUE);
}

export type TrainMode = 'create' | 'fast-forward' | 'reset-after-merge-back' | 'recreate-bump' | 'merge' | 'ahead';

export type ClassifyTrainInput = {
  trainTip: string | null;
  mainTip: string;
  trainTipIsAncestorOfMain: boolean;
  mainTipIsAncestorOfTrain: boolean;
  /** headRefOid of the most recent merged PR from release/next into main. */
  lastMergedBackHeadOid: string | null;
  /** `main..release/next`, newest first. */
  trainOnlyCommits: readonly TrainCommit[];
};

export type TrainClassification = { mode: TrainMode; reason: string };

function subjectOf(message: string): string {
  return message.split('\n', 1)[0].trim();
}

function describeCommits(commits: readonly TrainCommit[]): string {
  const shown = commits.slice(0, 5).map((commit) => `${commit.sha.slice(0, 10)} ${subjectOf(commit.message)}`);
  const more = commits.length > shown.length ? `; and ${commits.length - shown.length} more` : '';
  return `${shown.join('; ')}${more}`;
}

/** PURE: decide how release/next follows main. */
export function classifyTrain(input: ClassifyTrainInput): TrainClassification {
  const { trainTip, trainOnlyCommits } = input;
  if (trainTip === null) {
    return { mode: 'create', reason: `${RELEASE_BRANCH} does not exist on origin, so it starts at ${MAIN_BRANCH}.` };
  }
  if (input.trainTipIsAncestorOfMain || trainOnlyCommits.length === 0) {
    return {
      mode: 'fast-forward',
      reason: `${RELEASE_BRANCH} has no commits of its own, so it moves to ${MAIN_BRANCH}.`,
    };
  }
  if (input.lastMergedBackHeadOid !== null && input.lastMergedBackHeadOid === trainTip) {
    return {
      mode: 'reset-after-merge-back',
      reason: `${RELEASE_BRANCH} is still at the head of the last merged-back PR (a squash merge), so it restarts from ${MAIN_BRANCH}.`,
    };
  }
  if (trainOnlyCommits.every(isDroppableBump)) {
    return {
      mode: 'recreate-bump',
      reason: `${RELEASE_BRANCH} only carries ${trainOnlyCommits.length} version bump(s), so the bump is recreated on ${MAIN_BRANCH}.`,
    };
  }
  if (input.mainTipIsAncestorOfTrain) {
    return {
      mode: 'ahead',
      reason: `${RELEASE_BRANCH} already contains ${MAIN_BRANCH} and carries ${trainOnlyCommits.length} commit(s) of its own: ${describeCommits(trainOnlyCommits)}.`,
    };
  }
  return {
    mode: 'merge',
    reason: `${RELEASE_BRANCH} carries ${trainOnlyCommits.length} commit(s) of its own, so ${MAIN_BRANCH} is merged in: ${describeCommits(trainOnlyCommits)}.`,
  };
}

// ─── Parsing git and gh output ──────────────────────────────────────────────────

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type RemoteRef = { sha: string; ref: string };

/** PURE: `git ls-remote` output. Throws on any line it does not understand. */
export function parseLsRemote(output: string): RemoteRef[] {
  return output
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [sha, ref, ...rest] = line.split('\t');
      if (!sha || !ref || rest.length > 0 || !OBJECT_ID.test(sha)) {
        throw new Error(`Unexpected git ls-remote line: ${JSON.stringify(line)}`);
      }
      return { sha, ref };
    });
}

const IOS_ANCHOR_REF = /^refs\/tags\/release\/ios-v(\d+\.\d+\.\d+)-[0-9a-f]+(?:\^\{\})?$/;

/** PURE: the versions Apple accepted, from `release/ios-v<version>-<shortfp>` anchors. */
export function parseAnchoredIosVersions(refs: readonly RemoteRef[]): string[] {
  const versions = new Set<string>();
  for (const { ref } of refs) {
    const match = IOS_ANCHOR_REF.exec(ref);
    if (!match) throw new Error(`Unexpected iOS release anchor ${ref}; expected release/ios-v<x.y.z>-<shortfp>.`);
    versions.add(match[1]);
  }
  return [...versions].sort(compareSemver);
}

/** PURE: does a `build-<platform>-v<version>-*` tag exist? */
export function hasVersionBuildTag(refs: readonly RemoteRef[], platform: Platform, version: string): boolean {
  const prefix = `refs/tags/build-${platform}-v${version}-`;
  return refs.some(({ ref }) => ref.startsWith(prefix));
}

export type MergedBackPullRequest = {
  number: number;
  mergedAt: string;
  mergeCommitOid: string;
  headRefOid: string;
};

/** PURE: the most recently merged PR from this repository's release/next into main. */
export function selectLastMergedBack(pullRequests: readonly unknown[]): MergedBackPullRequest | null {
  let latest: MergedBackPullRequest | null = null;
  for (const raw of pullRequests) {
    if (typeof raw !== 'object' || raw === null) throw new Error('Unexpected gh pr list entry.');
    const record = raw as Record<string, unknown>;
    if (record.isCrossRepository === true) continue;
    const mergeCommit = record.mergeCommit as Record<string, unknown> | null | undefined;
    const mergeCommitOid = typeof mergeCommit?.oid === 'string' ? mergeCommit.oid : null;
    const { number, mergedAt, headRefOid } = record;
    if (typeof number !== 'number' || typeof mergedAt !== 'string' || typeof headRefOid !== 'string') {
      throw new Error(`Unexpected gh pr list entry: ${JSON.stringify(record)}`);
    }
    if (mergeCommitOid === null) continue;
    const candidate = { number, mergedAt, mergeCommitOid, headRefOid };
    if (latest === null || Date.parse(candidate.mergedAt) > Date.parse(latest.mergedAt)) latest = candidate;
  }
  return latest;
}

export type MergeTreeEntry = { mode: string; oid: string; stage: number; path: string };
export type MergeTreeResult = {
  clean: boolean;
  tree: string;
  conflicts: MergeTreeEntry[];
  messages: string[];
};

/** PURE: `git merge-tree --write-tree --messages` stdout. */
export function parseMergeTreeOutput(stdout: string, clean: boolean): MergeTreeResult {
  const lines = stdout.split('\n');
  const tree = lines[0]?.trim() ?? '';
  if (!OBJECT_ID.test(tree))
    throw new Error(`Unexpected git merge-tree output: ${JSON.stringify(stdout.slice(0, 200))}`);
  const conflicts: MergeTreeEntry[] = [];
  let index = 1;
  for (; index < lines.length && lines[index] !== ''; index += 1) {
    const match = /^(\d{6}) ([0-9a-f]+) (\d)\t(.+)$/.exec(lines[index]);
    if (!match) throw new Error(`Unexpected git merge-tree conflict line: ${JSON.stringify(lines[index])}`);
    conflicts.push({ mode: match[1], oid: match[2], stage: Number(match[3]), path: match[4] });
  }
  const messages = lines.slice(index + 1).filter((line) => line.trim() !== '');
  return { clean, tree, conflicts, messages };
}

export function conflictedPaths(result: MergeTreeResult): string[] {
  return [...new Set(result.conflicts.map((entry) => entry.path))].sort();
}

/** PURE: is the only conflict a content conflict in app.config.ts? */
export function isAppConfigOnlyConflict(result: MergeTreeResult): boolean {
  if (result.clean) return false;
  const paths = conflictedPaths(result);
  if (paths.length !== 1 || paths[0] !== APP_CONFIG_PATH) return false;
  const stages = new Set(result.conflicts.map((entry) => entry.stage));
  if (!stages.has(2) || !stages.has(3)) return false;
  const conflictMessages = result.messages.filter((message) => message.startsWith('CONFLICT'));
  return conflictMessages.every((message) => message === `CONFLICT (content): Merge conflict in ${APP_CONFIG_PATH}`);
}

export type WorkflowRun = {
  databaseId: number;
  status: string;
  conclusion: string;
  headSha: string;
  headBranch: string;
  event: string;
  displayTitle: string;
  createdAt: string;
  url: string;
};

export const WORKFLOW_RUN_FIELDS = [
  'databaseId',
  'status',
  'conclusion',
  'headSha',
  'headBranch',
  'event',
  'displayTitle',
  'createdAt',
  'url',
] as const;

export function parseWorkflowRuns(json: string): WorkflowRun[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('Unexpected gh run list output: not an array.');
  return parsed.map((raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) throw new Error('Unexpected gh run list entry.');
    const record = raw as Record<string, unknown>;
    const text = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : '');
    if (typeof record.databaseId !== 'number' || text('status') === '') {
      throw new Error(`Unexpected gh run list entry: ${JSON.stringify(record)}`);
    }
    return {
      databaseId: record.databaseId,
      status: text('status'),
      conclusion: text('conclusion'),
      headSha: text('headSha'),
      headBranch: text('headBranch'),
      event: text('event'),
      displayTitle: text('displayTitle'),
      createdAt: text('createdAt'),
      url: text('url'),
    };
  });
}

/** PURE: `gh run view --json jobs`. */
export function parseRunJobs(json: string): RunJob[] {
  const parsed: unknown = JSON.parse(json);
  const jobs = typeof parsed === 'object' && parsed !== null ? (parsed as { jobs?: unknown }).jobs : undefined;
  if (!Array.isArray(jobs)) throw new Error('Unexpected gh run view output: no jobs array.');
  return jobs.map((raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) throw new Error('Unexpected gh run view job.');
    const record = raw as Record<string, unknown>;
    if (typeof record.name !== 'string') throw new Error(`Unexpected gh run view job: ${JSON.stringify(record)}`);
    return {
      name: record.name,
      status: typeof record.status === 'string' ? record.status : '',
      conclusion: typeof record.conclusion === 'string' ? record.conclusion : '',
    };
  });
}

/** PURE: store-draft runs that pinned release/next and would abort if it moved. */
export function activeTrainDraftRuns(runs: readonly WorkflowRun[]): WorkflowRun[] {
  // mobile-store-draft.yml's run-name is `Mobile Store Draft (<branch>)`, so the branch
  // is always the title's last token; endsWith keeps other titles from matching.
  return runs.filter((run) => run.status === 'in_progress' && run.displayTitle.endsWith(`(${RELEASE_BRANCH})`));
}

export type BuildRetryDecision = { action: 'skip' | 'dispatch'; reason: string };

/** PURE: the newest run of a workflow at this exact commit. */
export function latestRunAtTip(runs: readonly WorkflowRun[], tipSha: string): WorkflowRun | undefined {
  return [...runs]
    .filter((run) => run.headSha === tipSha)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
}

export type RunJob = { name: string; status: string; conclusion: string };

/** android-apk-rn.yml job ids; gh reports them as job names (neither job sets `name:`). */
export const ANDROID_REVIEW_JOB = 'play-review';
export const ANDROID_BUILD_JOB = 'build-and-release';

/**
 * PURE: did this Android run defer its build because Play was reviewing another
 * release? Then the review pre-check succeeded and the build job was skipped.
 */
export function isDeferredAndroidRun(jobs: readonly RunJob[]): boolean {
  const review = jobs.find((job) => job.name === ANDROID_REVIEW_JOB);
  const build = jobs.find((job) => job.name === ANDROID_BUILD_JOB);
  return review?.conclusion === 'success' && build?.conclusion === 'skipped';
}

/**
 * PURE: should this platform's build for the train version be dispatched again?
 *
 * Only two cases retry: nothing ever ran at this tip (the push never became a run),
 * and an Android run that deferred while Play reviewed another release. Everything
 * else stands down, because an hourly 60-minute macOS rebuild and re-upload is the
 * expensive failure: a run that succeeded without a tag (a gate that built "to be
 * safe" without a fingerprint cannot tag), a failure, and a cancel (someone meant it)
 * all wait for a human.
 */
export function decideBuildRetry(input: {
  hasBuildTag: boolean;
  runs: readonly WorkflowRun[];
  tipSha: string;
  version: string;
  /** The latest run at the tip is an Android run whose build was deferred. */
  latestAtTipDeferred: boolean;
}): BuildRetryDecision {
  if (input.hasBuildTag) return { action: 'skip', reason: `a build tag for v${input.version} exists` };
  const active = input.runs.find((run) => run.status !== 'completed');
  if (active) return { action: 'skip', reason: `run ${active.databaseId} is ${active.status} (${active.url})` };
  const latest = latestRunAtTip(input.runs, input.tipSha);
  if (!latest) {
    return { action: 'dispatch', reason: `no build tag for v${input.version} and no run at this tip` };
  }
  const run = `run ${latest.databaseId} (${latest.url})`;
  if (latest.conclusion === 'success' && input.latestAtTipDeferred) {
    return { action: 'dispatch', reason: `${run} deferred the build while Play reviewed another release` };
  }
  if (latest.conclusion === 'success') {
    return {
      action: 'skip',
      reason: `${run} succeeded at this tip without a v${input.version} build tag; not rebuilding automatically, check why it did not tag`,
    };
  }
  if (latest.conclusion === 'cancelled') {
    return { action: 'skip', reason: `${run} was cancelled at this tip; standing down` };
  }
  return {
    action: 'skip',
    reason: `${run} ended ${latest.conclusion || 'without a conclusion'} at this tip; re-run it once the cause is fixed`,
  };
}

/**
 * PURE: turn a refused push into the fix. The push still fails the run; this only
 * says which credential or rule to change.
 */
export function explainPushFailure(output: string): string {
  const hints: string[] = [];
  if (/without [`']?workflows[`']? permission|create or update workflow/i.test(output)) {
    hints.push(
      'The App token lacks `workflows: write`. GitHub refuses an App push that adds or changes ' +
        'files under .github/workflows/ without it: mint the token with `permission-workflows: write` ' +
        'and make sure the App (vars.OTA_PUSH_APP_ID) has the Workflows permission.',
    );
  }
  if (/repository rule violations|GH013|push declined due to repository rule/i.test(output)) {
    hints.push(
      `A ruleset refused the push. The ${RELEASE_BRANCH} ruleset must list the repository App ` +
        '(vars.OTA_PUSH_APP_ID) as a bypass actor: recreating the bump and resetting after a ' +
        'merge-back are non-fast-forward pushes.',
    );
  }
  if (hints.length === 0 && output.includes('[remote rejected]')) {
    hints.push('GitHub rejected the push; its reason is in the output below.');
  }
  if (hints.length === 0) hints.push('See the git output below.');
  return hints.join(' ');
}

/** PURE: owner/name from an origin URL (https or ssh). */
export function parseGitHubRepository(remoteUrl: string): string {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  if (!match) throw new Error(`Cannot tell the GitHub repository from ${remoteUrl}; set GITHUB_REPOSITORY.`);
  return `${match[1]}/${match[2]}`;
}

// ─── Reports ────────────────────────────────────────────────────────────────────

/**
 * Identifies one conflict: the train commit and the files it conflicts on. main's
 * SHA is left out on purpose, so main moving on does not re-comment the same conflict.
 */
export function conflictMarker(trainTip: string, paths: readonly string[]): string {
  const files = encodeURIComponent([...paths].sort().join(','));
  return `<!-- release-train-sync train=${trainTip} files=${files} -->`;
}

/** PURE: the issue body and step summary for a conflict that needs a human. */
export function renderConflictReport(input: {
  paths: readonly string[];
  mainTip: string;
  trainTip: string;
  runUrl: string | null;
}): string {
  const files = input.paths.map((path) => `- \`${path}\``).join('\n');
  return [
    `The automatic sync of \`${MAIN_BRANCH}\` into \`${RELEASE_BRANCH}\` stopped at a merge conflict.`,
    '',
    `- \`${MAIN_BRANCH}\`: ${input.mainTip}`,
    `- \`${RELEASE_BRANCH}\`: ${input.trainTip}`,
    ...(input.runUrl ? [`- Run: ${input.runUrl}`] : []),
    '',
    'Conflicting files:',
    '',
    files,
    '',
    'Merge it by hand:',
    '',
    '```sh',
    'git fetch origin',
    `git switch ${RELEASE_BRANCH} && git pull`,
    `git merge origin/${MAIN_BRANCH}`,
    '# resolve the conflicts, then',
    'git add <files> && git commit',
    `git push origin ${RELEASE_BRANCH}`,
    '```',
    '',
    'The next sync run after that push closes this issue.',
    '',
    conflictMarker(input.trainTip, input.paths),
  ].join('\n');
}

// ─── I/O ────────────────────────────────────────────────────────────────────────

export type PushOutcome = { ok: true } | { ok: false; leaseRejected: boolean; output: string };

export type GitClient = {
  lsRemote(patterns: readonly string[], options?: { tags?: boolean }): RemoteRef[];
  fetchBranches(branches: readonly string[]): void;
  remoteTrackingSha(branch: string): string;
  ensureCommit(sha: string): void;
  isAncestor(ancestor: string, descendant: string): boolean;
  /** `exclude..include`, newest first. */
  listCommits(exclude: string, include: string): TrainCommit[];
  commitTime(sha: string): number;
  commitMessage(sha: string): string;
  parentsOf(sha: string): string[];
  /** Paths that differ between two commits. */
  changedPaths(from: string, to: string): string[];
  readFile(revision: string, path: string): string;
  mergeTree(ours: string, theirs: string): MergeTreeResult;
  writeTreeWithFile(baseTree: string, path: string, content: string): string;
  treeOf(commit: string): string;
  commitTree(input: { tree: string; parents: readonly string[]; message: string; unixTime: number }): string;
  push(input: {
    destination: string;
    targetSha: string;
    expectedTrainSha: string | null;
    secret?: string;
  }): PushOutcome;
};

export type GitHubClient = {
  listMergedBackPullRequests(): unknown[];
  listWorkflowRuns(workflowFile: string, filter: { branch?: string; status?: string; limit: number }): WorkflowRun[];
  listRunJobs(runId: number): RunJob[];
  dispatchWorkflow(workflowFile: string, ref: string, inputs: Record<string, string>): void;
  findOpenConflictIssue(): number | null;
  issueMentions(issueNumber: number, text: string): boolean;
  ensureConflictLabel(): void;
  createConflictIssue(body: string): void;
  commentOnIssue(issueNumber: number, body: string): void;
  closeIssue(issueNumber: number, comment: string): void;
};

export type SyncRuntime = {
  git: GitClient;
  github: GitHubClient;
  dryRun: boolean;
  floorVersion?: string;
  /** Where the push goes: the App-token URL in CI. */
  pushDestination: string;
  pushSecret?: string;
  runUrl: string | null;
  log(line: string): void;
  warn(line: string): void;
  summary(markdown: string): void;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
};

type Environment = Record<string, string | undefined>;

type CommandOptions = {
  cwd: string;
  env?: Environment;
  input?: string;
  okStatuses?: readonly number[];
  /** Scrubbed from any error this command throws (the App token in the push URL). */
  secret?: string;
};

type CommandResult = { status: number; stdout: string; stderr: string };

function readProcessText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Buffer) return value.toString('utf8');
  return '';
}

/** execFileSync without a shell; non-zero exits listed in okStatuses are returned, not thrown. */
function runCommand(command: string, args: readonly string[], options: CommandOptions): CommandResult {
  try {
    const stdout = execFileSync(command, [...args], {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv | undefined,
      input: options.input,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: unknown; stdout?: unknown; stderr?: unknown };
    const status = typeof failure.status === 'number' ? failure.status : -1;
    const result = { status, stdout: readProcessText(failure.stdout), stderr: readProcessText(failure.stderr) };
    if ((options.okStatuses ?? []).includes(status)) return result;
    const message = `${command} ${args.join(' ')} exited ${status}: ${result.stderr.trim() || result.stdout.trim() || String(error)}`;
    throw new Error(options.secret ? message.split(options.secret).join('***') : message);
  }
}

function expectObjectId(value: string, what: string): string {
  const trimmed = value.trim();
  if (!OBJECT_ID.test(trimmed)) throw new Error(`Expected an object id for ${what}, got ${JSON.stringify(trimmed)}.`);
  return trimmed;
}

export function createGitClient(options: { cwd: string; remote: string; env?: Environment }): GitClient {
  const baseEnv: Environment = { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: '0' };
  const git = (args: readonly string[], extra: Omit<CommandOptions, 'cwd'> = {}) =>
    runCommand('git', args, { cwd: options.cwd, ...extra, env: { ...baseEnv, ...extra.env } });

  return {
    lsRemote(patterns, lsOptions = {}) {
      const args = ['ls-remote', ...(lsOptions.tags ? ['--tags'] : []), options.remote, ...patterns];
      const refs = parseLsRemote(git(args).stdout);
      // ls-remote patterns match a ref's tail; keep exact head names only.
      return lsOptions.tags ? refs : refs.filter((remoteRef) => patterns.includes(remoteRef.ref));
    },
    fetchBranches(branches) {
      if (branches.length === 0) return;
      const refspecs = branches.map((branch) => `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
      git(['fetch', '--no-tags', '--quiet', options.remote, ...refspecs]);
    },
    remoteTrackingSha(branch) {
      return expectObjectId(git(['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]).stdout, branch);
    },
    ensureCommit(sha) {
      const present = git(['cat-file', '-e', `${sha}^{commit}`], { okStatuses: [1, 128] }).status === 0;
      if (!present) git(['fetch', '--no-tags', '--quiet', options.remote, sha]);
    },
    isAncestor(ancestor, descendant) {
      const { status } = git(['merge-base', '--is-ancestor', ancestor, descendant], { okStatuses: [1] });
      return status === 0;
    },
    listCommits(exclude, include) {
      const output = git(['log', '--format=%H%x00%B%x1e', `${exclude}..${include}`]).stdout;
      return output
        .split('\x1e')
        .map((record) => record.replace(/^\n/, ''))
        .filter((record) => record.trim() !== '')
        .map((record) => {
          const separator = record.indexOf('\x00');
          if (separator === -1) throw new Error(`Unexpected git log record: ${JSON.stringify(record.slice(0, 80))}`);
          return { sha: expectObjectId(record.slice(0, separator), 'git log'), message: record.slice(separator + 1) };
        });
    },
    commitTime(sha) {
      const raw = git(['show', '-s', '--format=%ct', sha]).stdout.trim();
      if (!/^\d+$/.test(raw)) throw new Error(`Unexpected committer time for ${sha}: ${JSON.stringify(raw)}`);
      return Number(raw);
    },
    commitMessage(sha) {
      return git(['show', '-s', '--format=%B', sha]).stdout;
    },
    parentsOf(sha) {
      const raw = git(['show', '-s', '--format=%P', sha]).stdout.trim();
      return raw === '' ? [] : raw.split(' ').map((parent) => expectObjectId(parent, `parent of ${sha}`));
    },
    changedPaths(from, to) {
      const output = git(['diff-tree', '-r', '--name-only', '--no-renames', from, to]).stdout;
      return output.split('\n').filter((line) => line !== '');
    },
    readFile(revision, path) {
      return git(['cat-file', 'blob', `${revision}:${path}`]).stdout;
    },
    mergeTree(ours, theirs) {
      // In memory: no worktree or index is touched, so a conflict needs no
      // `git merge --abort`, and a dry run can compute the exact merge commit.
      const result = git(
        ['-c', 'merge.conflictStyle=merge', 'merge-tree', '--write-tree', '--messages', ours, theirs],
        { okStatuses: [1] },
      );
      return parseMergeTreeOutput(result.stdout, result.status === 0);
    },
    writeTreeWithFile(baseTree, path, content) {
      const listing = git(['ls-tree', baseTree, '--', path]).stdout.trim();
      const match = /^(\d{6}) blob [0-9a-f]+\t(.+)$/.exec(listing);
      if (!match || match[2] !== path) throw new Error(`Expected ${path} to be a file in ${baseTree}.`);
      const blob = expectObjectId(git(['hash-object', '-w', '--stdin'], { input: content }).stdout, path);
      const scratch = mkdtempSync(join(tmpdir(), 'release-train-index-'));
      try {
        const env = { GIT_INDEX_FILE: join(scratch, 'index') };
        git(['read-tree', baseTree], { env });
        git(['update-index', '--cacheinfo', `${match[1]},${blob},${path}`], { env });
        return expectObjectId(git(['write-tree'], { env }).stdout, 'write-tree');
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    treeOf(commit) {
      return expectObjectId(git(['rev-parse', `${commit}^{tree}`]).stdout, `${commit}^{tree}`);
    },
    commitTree({ tree, parents, message, unixTime }) {
      const date = `${unixTime} +0000`;
      const args = ['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '--no-gpg-sign', '-F', '-'];
      const env = {
        GIT_AUTHOR_NAME: BOT_NAME,
        GIT_AUTHOR_EMAIL: BOT_EMAIL,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: BOT_NAME,
        GIT_COMMITTER_EMAIL: BOT_EMAIL,
        GIT_COMMITTER_DATE: date,
      };
      return expectObjectId(git(args, { input: message, env }).stdout, 'commit-tree');
    },
    push({ destination, targetSha, expectedTrainSha, secret }) {
      const lease = `--force-with-lease=refs/heads/${RELEASE_BRANCH}:${expectedTrainSha ?? ''}`;
      const result = git(['push', '--porcelain', lease, destination, `${targetSha}:refs/heads/${RELEASE_BRANCH}`], {
        okStatuses: [1, 128],
        secret,
      });
      if (result.status === 0) return { ok: true };
      const raw = `${result.stdout}\n${result.stderr}`;
      const output = secret ? raw.split(secret).join('***') : raw;
      return { ok: false, leaseRejected: output.includes('[rejected]'), output };
    },
  };
}

export function createGhGitHubClient(options: { repository: string; cwd: string }): GitHubClient {
  const gh = (args: readonly string[], input?: string) =>
    runCommand('gh', [...args, '--repo', options.repository], { cwd: options.cwd, input }).stdout;

  return {
    listMergedBackPullRequests() {
      const output = gh([
        'pr',
        'list',
        '--base',
        MAIN_BRANCH,
        '--head',
        RELEASE_BRANCH,
        '--state',
        'merged',
        '--limit',
        '20',
        '--json',
        'number,mergedAt,mergeCommit,headRefOid,isCrossRepository',
      ]);
      const parsed: unknown = JSON.parse(output);
      if (!Array.isArray(parsed)) throw new Error('Unexpected gh pr list output: not an array.');
      return parsed;
    },
    listWorkflowRuns(workflowFile, filter) {
      const args = ['run', 'list', '--workflow', workflowFile, '--limit', String(filter.limit)];
      if (filter.branch) args.push('--branch', filter.branch);
      if (filter.status) args.push('--status', filter.status);
      args.push('--json', WORKFLOW_RUN_FIELDS.join(','));
      return parseWorkflowRuns(gh(args));
    },
    listRunJobs(runId) {
      return parseRunJobs(gh(['run', 'view', String(runId), '--json', 'jobs']));
    },
    dispatchWorkflow(workflowFile, ref, inputs) {
      const fields = Object.entries(inputs).flatMap(([key, value]) => ['-f', `${key}=${value}`]);
      gh(['workflow', 'run', workflowFile, '--ref', ref, ...fields]);
    },
    findOpenConflictIssue() {
      const output = gh([
        'issue',
        'list',
        '--state',
        'open',
        '--label',
        CONFLICT_ISSUE_LABEL,
        '--limit',
        '50',
        '--json',
        'number,title',
      ]);
      const parsed: unknown = JSON.parse(output);
      if (!Array.isArray(parsed)) throw new Error('Unexpected gh issue list output: not an array.');
      const match = parsed.find(
        (issue: unknown) =>
          typeof issue === 'object' && issue !== null && (issue as { title?: unknown }).title === CONFLICT_ISSUE_TITLE,
      ) as { number?: unknown } | undefined;
      return typeof match?.number === 'number' ? match.number : null;
    },
    issueMentions(issueNumber, text) {
      const output = gh(['issue', 'view', String(issueNumber), '--json', 'body,comments']);
      const parsed = JSON.parse(output) as { body?: unknown; comments?: { body?: unknown }[] };
      const bodies = [parsed.body, ...(parsed.comments ?? []).map((comment) => comment.body)];
      return bodies.some((body) => typeof body === 'string' && body.includes(text));
    },
    ensureConflictLabel() {
      gh([
        'label',
        'create',
        CONFLICT_ISSUE_LABEL,
        '--color',
        'B60205',
        '--description',
        'release/next sync automation needs a human',
        '--force',
      ]);
    },
    createConflictIssue(body) {
      gh(
        ['issue', 'create', '--title', CONFLICT_ISSUE_TITLE, '--label', CONFLICT_ISSUE_LABEL, '--body-file', '-'],
        body,
      );
    },
    commentOnIssue(issueNumber, body) {
      gh(['issue', 'comment', String(issueNumber), '--body-file', '-'], body);
    },
    closeIssue(issueNumber, comment) {
      gh(['issue', 'close', String(issueNumber), '--comment', comment]);
    },
  };
}

// ─── Planning ───────────────────────────────────────────────────────────────────

export type ReadyPlan = {
  kind: 'ready';
  classification: TrainClassification;
  mainTip: string;
  trainTip: string | null;
  baseSha: string;
  baseDescription: string;
  versionDecision: VersionDecision;
  targetSha: string;
  targetMessage: string;
  needsPush: boolean;
};

export type ConflictPlan = {
  kind: 'conflict';
  classification: TrainClassification;
  mainTip: string;
  trainTip: string;
  paths: string[];
};

export type SyncPlan = ReadyPlan | ConflictPlan;

type MergeOutcome = { kind: 'merged'; sha: string; description: string } | { kind: 'conflict'; paths: string[] };

function mergeMainIntoTrain(git: GitClient, trainTip: string, mainTip: string): MergeOutcome {
  const merge = git.mergeTree(trainTip, mainTip);
  let tree = merge.tree;
  let description = `merge of ${MAIN_BRANCH} into ${RELEASE_BRANCH}`;
  if (!merge.clean) {
    const resolved = isAppConfigOnlyConflict(merge)
      ? resolveVersionOnlyConflict(git.readFile(merge.tree, APP_CONFIG_PATH))
      : null;
    if (resolved === null) return { kind: 'conflict', paths: conflictedPaths(merge) };
    readMarketingVersion(resolved);
    tree = git.writeTreeWithFile(merge.tree, APP_CONFIG_PATH, resolved);
    description += ', version-line conflict resolved to the higher version';
  }
  // Dated from the parents, so identical inputs give an identical SHA.
  const unixTime = Math.max(git.commitTime(trainTip), git.commitTime(mainTip));
  const sha = git.commitTree({ tree, parents: [trainTip, mainTip], message: SYNC_MERGE_MESSAGE, unixTime });
  return { kind: 'merged', sha, description };
}

/** `main..release/next`, with `versionOnly` filled in for commits carrying the bump trailer. */
function listTrainOnlyCommits(git: GitClient, mainTip: string, trainTip: string): TrainCommit[] {
  return git.listCommits(mainTip, trainTip).map((commit) => {
    if (!hasReleaseTrainTrailer(commit.message, VERSION_BUMP_TRAILER_VALUE)) return commit;
    const parents = git.parentsOf(commit.sha);
    if (parents.length !== 1) return { ...commit, versionOnly: false };
    const [parent] = parents;
    const paths = git.changedPaths(parent, commit.sha);
    const versionOnly =
      paths.length === 1 &&
      paths[0] === APP_CONFIG_PATH &&
      isVersionOnlyChange(git.readFile(parent, APP_CONFIG_PATH), git.readFile(commit.sha, APP_CONFIG_PATH));
    return { ...commit, versionOnly };
  });
}

export function computeSyncPlan(runtime: Pick<SyncRuntime, 'git' | 'github' | 'floorVersion'>): SyncPlan {
  const { git, github } = runtime;
  const heads = git.lsRemote([`refs/heads/${MAIN_BRANCH}`, `refs/heads/${RELEASE_BRANCH}`]);
  if (!heads.some((head) => head.ref === `refs/heads/${MAIN_BRANCH}`)) {
    throw new Error(`origin has no ${MAIN_BRANCH} branch.`);
  }
  const trainExists = heads.some((head) => head.ref === `refs/heads/${RELEASE_BRANCH}`);
  git.fetchBranches(trainExists ? [MAIN_BRANCH, RELEASE_BRANCH] : [MAIN_BRANCH]);
  // The SHAs this plan is computed against; the push leases on trainTip.
  const mainTip = git.remoteTrackingSha(MAIN_BRANCH);
  const trainTip = trainExists ? git.remoteTrackingSha(RELEASE_BRANCH) : null;

  const lastMergedBack = selectLastMergedBack(github.listMergedBackPullRequests());
  let lastMergedBackVersion: string | undefined;
  if (lastMergedBack) {
    git.ensureCommit(lastMergedBack.mergeCommitOid);
    lastMergedBackVersion = readMarketingVersion(git.readFile(lastMergedBack.mergeCommitOid, APP_CONFIG_PATH));
  }
  const anchoredIosVersions = parseAnchoredIosVersions(git.lsRemote(['refs/tags/release/ios-v*'], { tags: true }));
  // Read before anything is reclassified: the train never moves to an older version.
  const currentTrainVersion =
    trainTip === null ? undefined : readMarketingVersion(git.readFile(trainTip, APP_CONFIG_PATH));

  const mainTipIsAncestorOfTrain = trainTip !== null && git.isAncestor(mainTip, trainTip);
  const classification = classifyTrain({
    trainTip,
    mainTip,
    trainTipIsAncestorOfMain: trainTip !== null && git.isAncestor(trainTip, mainTip),
    mainTipIsAncestorOfTrain,
    lastMergedBackHeadOid: lastMergedBack?.headRefOid ?? null,
    trainOnlyCommits: trainTip === null ? [] : listTrainOnlyCommits(git, mainTip, trainTip),
  });

  let baseSha = mainTip;
  let baseDescription = `${MAIN_BRANCH} tip`;
  if (classification.mode === 'ahead' && trainTip !== null) {
    baseSha = trainTip;
    baseDescription = `${RELEASE_BRANCH} tip (already contains ${MAIN_BRANCH})`;
  } else if (classification.mode === 'merge' && trainTip !== null) {
    const merge = mergeMainIntoTrain(git, trainTip, mainTip);
    if (merge.kind === 'conflict') return { kind: 'conflict', classification, mainTip, trainTip, paths: merge.paths };
    baseSha = merge.sha;
    baseDescription = merge.description;
  }

  const baseConfig = git.readFile(baseSha, APP_CONFIG_PATH);
  const versionDecision = nextVersion({
    baseVersion: readMarketingVersion(baseConfig),
    currentTrainVersion,
    lastMergedBackVersion,
    anchoredIosVersions,
    floorVersion: runtime.floorVersion,
  });

  let targetSha = baseSha;
  if (versionDecision.bump) {
    const bumpedConfig = bumpVersionSource(baseConfig, versionDecision.targetVersion);
    const tree = git.writeTreeWithFile(git.treeOf(baseSha), APP_CONFIG_PATH, bumpedConfig);
    // Dated from the base, so the same base and version always give the same SHA.
    targetSha = git.commitTree({
      tree,
      parents: [baseSha],
      message: versionBumpMessage(versionDecision.targetVersion),
      unixTime: git.commitTime(baseSha),
    });
  }
  // A bump someone else made (Marco by hand, say) that already gives the same tree
  // on top of this main stays as it is: replacing it would only churn the branch
  // and restart its builds. The next main push recreates it as the bot's commit.
  if (
    classification.mode === 'recreate-bump' &&
    trainTip !== null &&
    targetSha !== trainTip &&
    mainTipIsAncestorOfTrain &&
    git.treeOf(trainTip) === git.treeOf(targetSha)
  ) {
    targetSha = trainTip;
    baseDescription += `; ${RELEASE_BRANCH} already has this exact content, so its bump commit stays`;
  }

  return {
    kind: 'ready',
    classification,
    mainTip,
    trainTip,
    baseSha,
    baseDescription,
    versionDecision,
    targetSha,
    targetMessage: git.commitMessage(targetSha),
    needsPush: targetSha !== trainTip,
  };
}

export function renderPlan(plan: SyncPlan): string[] {
  const lines = [
    `${MAIN_BRANCH}:         ${plan.mainTip}`,
    `${RELEASE_BRANCH}: ${plan.trainTip ?? '(missing)'}`,
    `mode:         ${plan.classification.mode}`,
    `why:          ${plan.classification.reason}`,
  ];
  if (plan.kind === 'conflict') {
    lines.push(`result:       merge conflict in ${plan.paths.join(', ')}`);
    return lines;
  }
  const { versionDecision } = plan;
  lines.push(
    `base:         ${plan.baseSha} (${plan.baseDescription})`,
    `version:      ${versionDecision.bump ? `${versionDecision.baseVersion} -> ${versionDecision.targetVersion}` : `${versionDecision.targetVersion} (kept)`}`,
    `version why:  ${versionDecision.reason}`,
    `target:       ${plan.targetSha}`,
    `push:         ${plan.needsPush ? `yes, leased on ${plan.trainTip ?? 'branch absent'}` : `no, ${RELEASE_BRANCH} is already at the target`}`,
  );
  return lines;
}

// ─── Running ────────────────────────────────────────────────────────────────────

export type SyncOutcome = { exitCode: number; plan: SyncPlan; pushedSha: string | null };

const FORCE_NATIVE_OFF = { force_native: 'false' } as const;

function reportConflict(runtime: SyncRuntime, plan: ConflictPlan): void {
  const report = renderConflictReport({
    paths: plan.paths,
    mainTip: plan.mainTip,
    trainTip: plan.trainTip,
    runUrl: runtime.runUrl,
  });
  runtime.summary(`## ${CONFLICT_ISSUE_TITLE}\n\n${report}\n`);
  runtime.warn(`Merge conflict in ${plan.paths.join(', ')}; ${RELEASE_BRANCH} needs a manual merge.`);
  if (runtime.dryRun) {
    runtime.log(`dry run: would open or update the "${CONFLICT_ISSUE_TITLE}" issue.`);
    return;
  }
  runtime.github.ensureConflictLabel();
  const existing = runtime.github.findOpenConflictIssue();
  if (existing === null) {
    runtime.github.createConflictIssue(report);
    runtime.log(`Opened the "${CONFLICT_ISSUE_TITLE}" issue.`);
  } else if (runtime.github.issueMentions(existing, conflictMarker(plan.trainTip, plan.paths))) {
    runtime.log(`Issue #${existing} already describes this conflict.`);
  } else {
    runtime.github.commentOnIssue(existing, report);
    runtime.log(`Updated issue #${existing}.`);
  }
}

function closeConflictIssue(runtime: SyncRuntime, comment: string): void {
  const existing = runtime.github.findOpenConflictIssue();
  if (existing === null) return;
  if (runtime.dryRun) {
    runtime.log(`dry run: would close issue #${existing}: ${comment}`);
    return;
  }
  runtime.github.closeIssue(existing, comment);
  runtime.log(`Closed issue #${existing}.`);
}

/** Wait (bounded) while a store draft that pinned release/next is running. */
async function storeDraftsBlockingPush(
  runtime: SyncRuntime,
  deadline: number,
): Promise<'clear' | 'waited' | 'timeout'> {
  let waited = false;
  for (;;) {
    const active = activeTrainDraftRuns(
      runtime.github.listWorkflowRuns(STORE_DRAFT_WORKFLOW, { status: 'in_progress', limit: 50 }),
    );
    if (active.length === 0) return waited ? 'waited' : 'clear';
    if (runtime.now() >= deadline) {
      runtime.warn(
        `A store draft for ${RELEASE_BRANCH} is still running after ${DRAFT_WAIT_MAX_MS / 60_000} min ` +
          `(${active.map((run) => run.url).join(', ')}); pushing anyway. It refuses to draft once the branch moves.`,
      );
      return 'timeout';
    }
    runtime.log(`Waiting for store draft run(s) ${active.map((run) => run.databaseId).join(', ')} to finish...`);
    waited = true;
    await runtime.sleep(DRAFT_WAIT_POLL_MS);
  }
}

async function waitForRunsAtTip(runtime: SyncRuntime, workflowFiles: readonly string[], tipSha: string): Promise<void> {
  const deadline = runtime.now() + RUN_REGISTRATION_WAIT_MS;
  for (;;) {
    const registered = workflowFiles.every((file) =>
      runtime.github
        .listWorkflowRuns(file, { branch: RELEASE_BRANCH, limit: 20 })
        .some((run) => run.headSha === tipSha),
    );
    if (registered) return;
    if (runtime.now() >= deadline) {
      runtime.warn(
        `No run registered at ${tipSha} within ${RUN_REGISTRATION_WAIT_MS / 1000} s for ${workflowFiles.join(', ')}; ` +
          'deciding retries from the runs that exist now.',
      );
      return;
    }
    await runtime.sleep(RUN_REGISTRATION_POLL_MS);
  }
}

/**
 * Dispatch the native build for the train version wherever no build tag exists and
 * nothing is queued or running. Covers Android builds the gate deferred while a Play
 * review was pending, and pushes GitHub never turned into runs.
 */
async function retryMissingVersionBuilds(
  runtime: SyncRuntime,
  input: { version: string; tipSha: string; justStartedRuns: boolean },
): Promise<void> {
  const missing = NATIVE_WORKFLOWS.filter((workflow) => {
    const tags = runtime.git.lsRemote([`refs/tags/build-${workflow.platform}-v${input.version}-*`], { tags: true });
    const built = hasVersionBuildTag(tags, workflow.platform, input.version);
    if (built) runtime.log(`${workflow.platform}: v${input.version} is built.`);
    return !built;
  });
  if (missing.length === 0) return;
  // A push or dispatch from this run only becomes a run after a few seconds.
  if (input.justStartedRuns && !runtime.dryRun) {
    await waitForRunsAtTip(
      runtime,
      missing.map((workflow) => workflow.file),
      input.tipSha,
    );
  }
  for (const workflow of missing) {
    const runs = runtime.github.listWorkflowRuns(workflow.file, { branch: RELEASE_BRANCH, limit: 20 });
    const latest = latestRunAtTip(runs, input.tipSha);
    const latestAtTipDeferred =
      workflow.platform === 'android' &&
      latest?.status === 'completed' &&
      latest.conclusion === 'success' &&
      isDeferredAndroidRun(runtime.github.listRunJobs(latest.databaseId));
    const decision = decideBuildRetry({
      hasBuildTag: false,
      runs,
      tipSha: input.tipSha,
      version: input.version,
      latestAtTipDeferred,
    });
    if (decision.action === 'skip') {
      runtime.log(`${workflow.platform}: not dispatching ${workflow.file}: ${decision.reason}.`);
    } else if (runtime.dryRun) {
      const unless = input.justStartedRuns ? ' unless the push starts a run' : '';
      runtime.log(
        `dry run: would dispatch ${workflow.file} on ${RELEASE_BRANCH} with force_native=false${unless}: ${decision.reason}.`,
      );
    } else {
      runtime.github.dispatchWorkflow(workflow.file, RELEASE_BRANCH, FORCE_NATIVE_OFF);
      runtime.log(`${workflow.platform}: dispatched ${workflow.file} on ${RELEASE_BRANCH}: ${decision.reason}.`);
    }
  }
}

export async function runReleaseTrainSync(runtime: SyncRuntime): Promise<SyncOutcome> {
  const draftDeadline = runtime.now() + DRAFT_WAIT_MAX_MS;
  let pushAttempts = 0;
  let draftWaitExpired = false;

  for (;;) {
    const plan = computeSyncPlan(runtime);
    const planLines = renderPlan(plan);
    for (const line of planLines) runtime.log(line);
    const writePlanSummary = () =>
      runtime.summary(
        `## Release train sync${runtime.dryRun ? ' (dry run)' : ''}\n\n\`\`\`\n${planLines.join('\n')}\n\`\`\`\n`,
      );

    if (plan.kind === 'conflict') {
      writePlanSummary();
      reportConflict(runtime, plan);
      return { exitCode: 1, plan, pushedSha: null };
    }

    const version = plan.versionDecision.targetVersion;
    if (!plan.needsPush) {
      writePlanSummary();
      await retryMissingVersionBuilds(runtime, { version, tipSha: plan.targetSha, justStartedRuns: false });
      closeConflictIssue(runtime, `${RELEASE_BRANCH} is in sync with ${MAIN_BRANCH} at ${plan.targetSha}.`);
      return { exitCode: 0, plan, pushedSha: null };
    }

    const skipCi = hasSkipCiMarker(plan.targetMessage);
    if (runtime.dryRun) {
      writePlanSummary();
      const drafts = activeTrainDraftRuns(
        runtime.github.listWorkflowRuns(STORE_DRAFT_WORKFLOW, { status: 'in_progress', limit: 50 }),
      );
      if (drafts.length > 0) {
        runtime.log(`dry run: a store draft for ${RELEASE_BRANCH} is running; a live run would wait for it first.`);
      }
      runtime.log(`dry run: would push ${plan.targetSha} to ${RELEASE_BRANCH}.`);
      if (skipCi) runtime.log('dry run: the new tip carries a skip-ci marker; would dispatch both native workflows.');
      await retryMissingVersionBuilds(runtime, { version, tipSha: plan.targetSha, justStartedRuns: true });
      closeConflictIssue(runtime, `${RELEASE_BRANCH} synced to ${plan.targetSha}.`);
      return { exitCode: 0, plan, pushedSha: null };
    }

    // The loop is bounded twice over: MAX_PUSH_ATTEMPTS caps lease-rejected pushes, and
    // a 'waited' recompute only happens while the fixed draftDeadline has not passed
    // (each one sleeps at least one poll). A 'timeout' recomputes once and switches the
    // draft check off, and after the deadline the check returns 'timeout' or 'clear'
    // at once, so every later iteration reaches a push.
    if (!draftWaitExpired) {
      const draftState = await storeDraftsBlockingPush(runtime, draftDeadline);
      if (draftState !== 'clear') {
        // We slept, so the plan is stale either way: fetch and plan again. After a
        // timeout the next pass pushes without waiting any further.
        draftWaitExpired = draftState === 'timeout';
        continue;
      }
    }

    pushAttempts += 1;
    const pushed = runtime.git.push({
      destination: runtime.pushDestination,
      targetSha: plan.targetSha,
      expectedTrainSha: plan.trainTip,
      secret: runtime.pushSecret,
    });
    if (!pushed.ok) {
      if (pushed.leaseRejected && pushAttempts < MAX_PUSH_ATTEMPTS) {
        runtime.warn(`${RELEASE_BRANCH} moved while this run planned; recomputing.\n${pushed.output.trim()}`);
        continue;
      }
      if (pushed.leaseRejected) {
        const gaveUp =
          `${RELEASE_BRANCH} moved between planning and pushing on all ${MAX_PUSH_ATTEMPTS} attempts, ` +
          'so this run stops without pushing. Nothing was overwritten; the next run (the next main push ' +
          'or the hourly schedule) plans again from scratch.';
        runtime.summary(`## Pushing ${RELEASE_BRANCH} gave up\n\n${gaveUp}\n`);
        throw new Error(`${gaveUp}\n${pushed.output.trim()}`);
      }
      const explanation = explainPushFailure(pushed.output);
      runtime.summary(
        `## Pushing ${RELEASE_BRANCH} failed\n\n${explanation}\n\n\`\`\`\n${pushed.output.trim()}\n\`\`\`\n`,
      );
      throw new Error(`Pushing ${RELEASE_BRANCH} failed. ${explanation}\n${pushed.output.trim()}`);
    }
    writePlanSummary();
    runtime.log(`Pushed ${plan.targetSha} to ${RELEASE_BRANCH}.`);

    if (skipCi) {
      // GitHub drops push-triggered workflows for this head commit, so start the
      // builds by hand; their gates decide whether anything needs building.
      for (const workflow of NATIVE_WORKFLOWS) {
        runtime.github.dispatchWorkflow(workflow.file, RELEASE_BRANCH, FORCE_NATIVE_OFF);
        runtime.log(`Dispatched ${workflow.file}: the pushed tip carries a skip-ci marker.`);
      }
    }
    await retryMissingVersionBuilds(runtime, { version, tipSha: plan.targetSha, justStartedRuns: true });
    closeConflictIssue(runtime, `${RELEASE_BRANCH} synced: pushed ${plan.targetSha}.`);
    return { exitCode: 0, plan, pushedSha: plan.targetSha };
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== '--dry-run');
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(' ')}. Usage: [--dry-run]`);
  const dryRun = args.includes('--dry-run');

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const git = createGitClient({ cwd: repoRoot, remote: 'origin' });
  const repository =
    process.env.GITHUB_REPOSITORY ||
    parseGitHubRepository(runCommand('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot }).stdout);
  const pushToken = process.env.PUSH_TOKEN ?? '';
  if (!dryRun && pushToken === '') throw new Error('PUSH_TOKEN (the repository App token) is required to push.');
  const floorVersion = process.env.RELEASE_TRAIN_MIN_VERSION?.trim() || undefined;
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;

  const outcome = await runReleaseTrainSync({
    git,
    github: createGhGitHubClient({ repository, cwd: repoRoot }),
    dryRun,
    floorVersion,
    pushDestination: `https://x-access-token:${pushToken}@github.com/${repository}.git`,
    pushSecret: pushToken || undefined,
    runUrl,
    log: (line) => console.log(line),
    warn: (line) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${line}` : `warning: ${line}`),
    summary: (markdown) => {
      if (summaryPath) appendFileSync(summaryPath, `${markdown}\n`);
    },
    sleep: (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
    now: () => Date.now(),
  });
  return outcome.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (exitCode) => process.exit(exitCode),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // The first line becomes the run's error annotation; the rest stays in the log.
      console.error(process.env.GITHUB_ACTIONS ? `::error::${message}` : `[release-train-sync] ${message}`);
      process.exit(1);
    },
  );
}
