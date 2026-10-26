/// <reference types="node" />

/**
 * Decides which open PR previews a push to `main` or `release/next` makes stale.
 *
 * A published preview variant exists only where the replayed PR resolved the
 * same runtimeVersion as its pinned base (`mobile-ota-preview-candidates.ts`
 * publishes with OTA_EXPECT_RUNTIME_VERSION set to that baseline). So the
 * runtime a preview serves for a target and platform is the runtime of that
 * target at the SHA its deployment payload records (`otaPreviewBases`). A base
 * push makes the preview stale for testers only when it changes that runtime,
 * or flips whether the release train is a second target. An unrelated base
 * commit leaves every preview offered to the same installed binaries, and the
 * PR's next push picks the commit up.
 *
 * Runtime identity is read from git objects, not by resolving the fingerprint:
 * the object ids of every native input at both SHAs are compared. Equal ids mean
 * equal bytes, so an unchanged input set cannot move runtimeVersion. A changed
 * input set refreshes even if the fingerprint would have survived it, so this
 * errs toward refreshing. Metadata only: no checkout of either base, no install,
 * no PR code. See docs/mobile-ota-updates.md, "When an open preview is
 * republished".
 */

import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readMarketingVersion } from './lib/mobile-release-policy.ts';

export type PreviewPlatform = 'ios' | 'android';
export type PreviewTarget = 'main' | 'release/next';

const PLATFORMS: readonly PreviewPlatform[] = ['ios', 'android'];
const BOTH: readonly PreviewPlatform[] = PLATFORMS;
const FULL_SHA = /^[0-9a-f]{40}$/;
const APP_CONFIG = 'packages/mobile/app.config.ts';

export interface RuntimeInput {
  path: string;
  platforms: readonly PreviewPlatform[];
  /** The dispatched publisher always runs main's copy, so only main's copy counts. */
  mainOnly?: boolean;
}

/**
 * Every repository path that can move a preview's runtimeVersion, or stop a
 * candidate from publishing. It covers `affectsNativeFingerprint` in
 * mobile-ota-preview.yml (the gate's proof that a diff cannot move the
 * fingerprint; the test keeps the two aligned), the publisher workflow, whose
 * env is part of the resolved app config, and the eoas pin, whose mismatch with
 * main makes every candidate a `server-upgrade`.
 *
 * The repo-local fingerprint sources come from
 *   cd packages/mobile && vp exec expo-updates fingerprint:generate --platform <ios|android> --debug
 * (every `file`/`dir` source outside node_modules). The test pins that list;
 * re-run the command after adding a plugin input, an icon or a native target.
 */
export const RUNTIME_INPUTS: readonly RuntimeInput[] = [
  { path: 'package.json', platforms: BOTH },
  { path: 'pnpm-lock.yaml', platforms: BOTH },
  { path: 'pnpm-workspace.yaml', platforms: BOTH },
  { path: 'patches', platforms: BOTH },
  { path: APP_CONFIG, platforms: BOTH },
  { path: 'packages/mobile/package.json', platforms: BOTH },
  { path: 'packages/mobile/fingerprint.config.js', platforms: BOTH },
  { path: 'packages/mobile/react-native.config.js', platforms: BOTH },
  { path: 'packages/mobile/eas.json', platforms: BOTH },
  { path: 'packages/mobile/assets/icon.png', platforms: BOTH },
  { path: 'packages/mobile/assets/splash-icon.png', platforms: BOTH },
  { path: 'packages/mobile/assets/adaptive-icon.png', platforms: ['android'] },
  { path: 'packages/mobile/plugins', platforms: BOTH },
  { path: 'packages/mobile/modules', platforms: BOTH },
  { path: 'packages/mobile/locales', platforms: BOTH },
  // expo-target.config.js is a config-plugin source on both platforms.
  { path: 'packages/mobile/targets', platforms: BOTH },
  { path: 'packages/mobile/ios', platforms: ['ios'] },
  { path: 'packages/mobile/android', platforms: ['android'] },
  { path: '.github/workflows/mobile-ota-preview.yml', platforms: BOTH, mainOnly: true },
  // A candidate whose eoas pin differs from main's is skipped as `server-upgrade`
  // (mobile-ota-preview-candidates.ts), on either target.
  { path: 'scripts/lib/eoas.ts', platforms: BOTH },
];

const MOBILE_PREVIEW_PREFIXES = [
  'packages/mobile/',
  'packages/shared/',
  'packages/board-constants/',
  'packages/shared-schema/',
  'patches/',
];
const MOBILE_PREVIEW_FILES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/mobile-publish.ts',
  'scripts/lib/mobile-publish-retry.ts',
  'scripts/lib/ota-branch-probe.ts',
  'scripts/lib/eoas.ts',
  'scripts/mobile-ota-boot-check.ts',
  'scripts/mobile-ota-boot-fixture.gradle',
  'scripts/mobile-ota-boot-preview.ts',
  'scripts/mobile-ota-preview-candidates.ts',
  'scripts/mobile-ota-preview-source.ts',
  'scripts/lib/mobile-release-policy.ts',
  'scripts/lib/ota-boot-check.ts',
  'scripts/lib/ota-preview-boot-receipt.ts',
  'scripts/lib/ota-publish-protocol.ts',
  '.github/workflows/mobile-ota-boot-check.yml',
  '.github/workflows/mobile-ota-preview.yml',
]);

/**
 * PR files that make the publisher gate publish rather than clean up. Exactly
 * the gate's `affectsMobilePreview` (the test compares them): a broader list
 * would dispatch PRs the gate only cleans up, on every base push.
 */
export function affectsMobilePreview(path: string): boolean {
  return MOBILE_PREVIEW_PREFIXES.some((prefix) => path.startsWith(prefix)) || MOBILE_PREVIEW_FILES.has(path);
}

export interface BaseSnapshot {
  sha: string;
  /** False when GitHub could not resolve the commit. Any comparison against it refreshes. */
  readable: boolean;
  /** Object id per runtime input path, '' when absent. app.config.ts holds a version-free digest. */
  inputs: Readonly<Record<string, string>>;
  marketingVersion: string | null;
}

export const unreadableSnapshot = (sha: string): BaseSnapshot => ({
  sha,
  readable: false,
  inputs: {},
  marketingVersion: null,
});

const MARKETING_VERSION_LINE = /^\s*version\s*:\s*(['"])(\d+\.\d+\.\d+)\1\s*,?\s*$/gm;

/**
 * The fingerprint skips the marketing version (`ExpoConfigVersions` in
 * fingerprint.config.js), so a train version bump must not count as a runtime
 * change. Anything other than exactly one literal version line is hashed as-is.
 */
export function appConfigDigest(source: string): string {
  const versionLines = source.match(MARKETING_VERSION_LINE) ?? [];
  const normalized = versionLines.length === 1 ? source.replace(MARKETING_VERSION_LINE, '') : source;
  return `sha256:${createHash('sha256').update(normalized).digest('hex')}`;
}

export function marketingVersionOf(source: string): string | null {
  try {
    return readMarketingVersion(source);
  } catch {
    return null;
  }
}

/** Platforms whose runtime inputs differ between two snapshots of one target. */
export function runtimeInputChanges(
  before: BaseSnapshot,
  after: BaseSnapshot,
  target: PreviewTarget,
): PreviewPlatform[] {
  if (!before.readable || !after.readable) return [...PLATFORMS];
  const changed = new Set<PreviewPlatform>();
  for (const input of RUNTIME_INPUTS) {
    if (input.mainOnly && target !== 'main') continue;
    if ((before.inputs[input.path] ?? '') !== (after.inputs[input.path] ?? ''))
      for (const platform of input.platforms) changed.add(platform);
  }
  return PLATFORMS.filter((platform) => changed.has(platform));
}

/** Same rule as isReleaseTrainActive; null when a version cannot be read. */
export function isTrainActive(main: BaseSnapshot, train: BaseSnapshot | null): boolean | null {
  if (!train) return false;
  if (!main.marketingVersion || !train.marketingVersion) return null;
  return main.marketingVersion !== train.marketingVersion;
}

export interface PreviewBases {
  version: 1;
  mainSha: string;
  trainSha: string;
  sourceBaseRef: string;
  sourceBaseSha: string;
}

/** Keep in sync with the gate's `baseKeys` in mobile-ota-preview.yml (the test checks). */
export const PREVIEW_BASE_KEYS = ['version', 'mainSha', 'trainSha', 'sourceBaseRef', 'sourceBaseSha'] as const;

/** The same validation the publisher's pin step applies before it trusts a record. */
export function parsePreviewBases(payload: unknown): PreviewBases | null {
  let parsed: unknown = payload;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const bases = (parsed as Record<string, unknown>).otaPreviewBases;
  if (typeof bases !== 'object' || bases === null || Array.isArray(bases)) return null;
  const record = bases as Record<string, unknown>;
  const { version, mainSha, trainSha, sourceBaseRef, sourceBaseSha } = record;
  if (
    Object.keys(record).length !== PREVIEW_BASE_KEYS.length ||
    !PREVIEW_BASE_KEYS.every((key) => Object.hasOwn(record, key)) ||
    version !== 1 ||
    typeof mainSha !== 'string' ||
    !FULL_SHA.test(mainSha) ||
    typeof trainSha !== 'string' ||
    !/^(?:[0-9a-f]{40})?$/.test(trainSha) ||
    typeof sourceBaseRef !== 'string' ||
    sourceBaseRef.length === 0 ||
    typeof sourceBaseSha !== 'string' ||
    !FULL_SHA.test(sourceBaseSha)
  )
    return null;
  return { version, mainSha, trainSha, sourceBaseRef, sourceBaseSha };
}

export interface PreviewAttempt {
  /** The PR head the deployment was created for. */
  sha: string;
  status: string;
}

/** The latest status of the latest deployment for the task. */
export interface PreviewStatus {
  /** '' when the deployment has no status yet. */
  status: string;
  statusDescription: string;
  /** When that status (or, without one, the deployment) was created. */
  statusAt: string;
}

export type PreviewRecord =
  | { kind: 'missing' }
  /** A deployment exists but cannot be trusted. Its status is present when its identity was valid. */
  | ({ kind: 'unreadable'; detail: string } & Partial<PreviewStatus>)
  | ({
      kind: 'found';
      bases: PreviewBases;
      /** The latest deployments for the task, newest first, this one included (at most 2). */
      recent: PreviewAttempt[];
    } & PreviewStatus);

export interface BaseHeads {
  main: BaseSnapshot;
  /** null when release/next does not exist (or did not, for a recorded context). */
  train: BaseSnapshot | null;
}

export interface RefreshDecision {
  dispatch: boolean;
  reason: string;
  /**
   * Dispatched because the record is missing, unreadable, failed or stuck, not
   * because a runtime moved. Many of these in one run means previews are not
   * landing at all, which the workflow reports to Discord.
   */
  conservative?: boolean;
}

const NON_TERMINAL_STATUSES = new Set(['in_progress', 'queued', 'pending', '']);
const HOUR_MS = 60 * 60 * 1_000;
/** Longer than the publish job's 330-minute timeout, so a live attempt is never called stuck. */
export const STUCK_ATTEMPT_MS = 6 * HOUR_MS;
/** A reset this recent still has its publish running (or queued behind the PR lane). */
export const REPUBLISH_IN_FLIGHT_MS = 2 * HOUR_MS;
/** A capped PR (failed twice, or a reset that never republished) is retried once per this window. */
export const CAPPED_RETRY_MS = 12 * HOUR_MS;
/** The description the publisher's reset job writes before it deletes pr-N. */
export const RESET_MARKER = 'Reset, republish pending';

const conservative = (reason: string): RefreshDecision => ({ dispatch: true, reason, conservative: true });

/**
 * A reset-marked record means a dispatched run already deleted pr-N. Leave it
 * alone while its publish may still be running, and afterwards retry at most
 * once per CAPPED_RETRY_MS: each retry's reset re-marks the record, restarting
 * the clock, so a reset that keeps failing (for example bad admin credentials)
 * costs one run per PR per 12 hours instead of one per base push.
 */
function resetHold(record: Partial<PreviewStatus>, now: number): RefreshDecision | null {
  if (record.status !== 'error' || record.statusDescription !== RESET_MARKER || !record.statusAt) return null;
  const age = now - Date.parse(record.statusAt);
  if (!Number.isFinite(age)) return null;
  if (age < REPUBLISH_IN_FLIGHT_MS)
    return { dispatch: false, reason: 'reset less than 2 hours ago, republish in flight' };
  if (age < CAPPED_RETRY_MS) return { dispatch: false, reason: 'reset did not republish; retrying 12 hours after it' };
  return conservative('reset did not republish within 12 hours, refreshing');
}

/**
 * Decide one mobile PR. `recorded` holds the snapshots at the SHAs the latest
 * preview deployment pinned; it is only read for a found record. A runtime
 * change or train flip always dispatches. Otherwise a failed, errored or stuck
 * attempt dispatches, with two caps so a PR cannot be re-dispatched on every
 * base push: after two failures in a row at the current head, and after a
 * reset that did not republish, it is retried at most once per 12 hours. A
 * failure caused by the base or an outage therefore heals within 12 hours
 * without the PR being pushed.
 */
export function decidePreviewRefresh(
  record: PreviewRecord,
  current: BaseHeads,
  recorded?: BaseHeads,
  context: { headSha?: string; now?: number } = {},
): RefreshDecision {
  const now = context.now ?? Date.now();
  if (record.kind === 'missing') return conservative('no preview record, refreshing');
  if (record.kind === 'unreadable')
    return resetHold(record, now) ?? conservative(`unreadable preview record (${record.detail}), refreshing`);
  if (!recorded) return conservative('recorded bases unavailable, refreshing');
  const runtime = runtimeDecision(current, recorded);
  if (runtime.dispatch) return runtime;
  if (record.status === 'error')
    return resetHold(record, now) ?? conservative('last preview ended in error, refreshing');
  if (record.status === 'failure') {
    const lastTwo = record.recent.slice(0, 2);
    const failedTwiceAtHead =
      lastTwo.length === 2 &&
      Boolean(context.headSha) &&
      lastTwo.every((attempt) => attempt.status === 'failure' && attempt.sha === context.headSha);
    if (!failedTwiceAtHead) return conservative('last preview ended in failure, refreshing');
    const age = now - Date.parse(record.statusAt);
    if (Number.isFinite(age) && age < CAPPED_RETRY_MS)
      return { dispatch: false, reason: 'failed twice at this head; next PR push retries' };
    return conservative('failed twice at this head over 12 hours ago, retrying once');
  }
  if (NON_TERMINAL_STATUSES.has(record.status)) {
    const age = now - Date.parse(record.statusAt);
    if (!Number.isFinite(age) || age > STUCK_ATTEMPT_MS)
      return conservative(
        `last preview stuck ${record.status ? `in ${record.status}` : 'without a status'} for over 6 hours, refreshing`,
      );
  }
  return runtime;
}

function runtimeDecision(current: BaseHeads, recorded: BaseHeads): RefreshDecision {
  const wasActive = isTrainActive(recorded.main, recorded.train);
  const isActive = isTrainActive(current.main, current.train);
  if (wasActive === null || isActive === null)
    return { dispatch: true, reason: 'release train version unreadable, refreshing' };
  if (wasActive !== isActive)
    return { dispatch: true, reason: isActive ? 'release train activated' : 'release train deactivated' };
  const changes: string[] = [];
  const mainChanges = runtimeInputChanges(recorded.main, current.main, 'main');
  if (mainChanges.length > 0) changes.push(`main ${mainChanges.join('+')}`);
  if (isActive && recorded.train && current.train) {
    const trainChanges = runtimeInputChanges(recorded.train, current.train, 'release/next');
    if (trainChanges.length > 0) changes.push(`release/next ${trainChanges.join('+')}`);
  }
  if (changes.length > 0) return { dispatch: true, reason: `runtime inputs changed on ${changes.join(', ')}` };
  return { dispatch: false, reason: 'unchanged runtime, skipped' };
}

export interface RefreshPull {
  number: number;
  headRef: string;
  headSha: string;
  headRepository: string | null;
  baseRef: string;
}

export interface RefreshApi {
  openPulls(): Promise<RefreshPull[]>;
  pullFiles(pull: number): Promise<string[]>;
  /** null when the branch does not exist. */
  branchHead(branch: string): Promise<string | null>;
  latestPreview(pull: number): Promise<PreviewRecord>;
  /** Whether any pr-preview deployment for this PR, including legacy ones, is not yet inactive. */
  hasLivePreview(pull: number): Promise<boolean>;
  snapshots(shas: readonly string[]): Promise<Map<string, BaseSnapshot>>;
}

export interface RefreshPlan {
  dispatch: number[];
  lines: string[];
  /** Dispatches for a missing, unreadable, failed or stuck record rather than a runtime change. */
  conservativeDispatches: number;
}

/** More conservative dispatches than this in one run means previews are not landing; say so. */
export const CONSERVATIVE_ALERT_THRESHOLD = 10;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function planPreviewRefresh(api: RefreshApi, repository: string, now = Date.now()): Promise<RefreshPlan> {
  const pulls = (await api.openPulls()).filter(
    (pull) =>
      pull.headRepository === repository &&
      ['main', 'release/next'].includes(pull.baseRef) &&
      // The train's own merge-back PR is a version/native branch, not a feature
      // preview. It already receives train OTAs directly.
      pull.headRef !== 'release/next',
  );
  if (pulls.length === 0)
    return {
      dispatch: [],
      lines: ['No open same-repository PRs target main or release/next.'],
      conservativeDispatches: 0,
    };

  const mainHead = await api.branchHead('main');
  if (!mainHead) throw new Error('main has no readable head.');
  const trainHead = await api.branchHead('release/next');

  const decided: Array<{ pull: number; decision: RefreshDecision }> = [];
  const pending: Array<{ pull: number; headSha: string; record: PreviewRecord }> = [];
  for (const pull of pulls) {
    try {
      const files = await api.pullFiles(pull.number);
      if (files.some(affectsMobilePreview)) {
        pending.push({ pull: pull.number, headSha: pull.headSha, record: await api.latestPreview(pull.number) });
        continue;
      }
      // A base can absorb a PR's last mobile change without moving its head.
      // The gate then selects cleanup; once cleanup marks the deployments
      // inactive, later base pushes leave the PR alone.
      decided.push({
        pull: pull.number,
        decision: (await api.hasLivePreview(pull.number))
          ? { dispatch: true, reason: 'no mobile changes left and a preview is still live, reconciling cleanup' }
          : { dispatch: false, reason: 'no mobile changes and no live preview, skipped' },
      });
    } catch (error) {
      decided.push({
        pull: pull.number,
        decision: conservative(`preview state unreadable (${message(error)}), refreshing`),
      });
    }
  }

  const shas = new Set<string>([mainHead, ...(trainHead ? [trainHead] : [])]);
  for (const { record } of pending) {
    if (record.kind !== 'found') continue;
    shas.add(record.bases.mainSha);
    if (record.bases.trainSha) shas.add(record.bases.trainSha);
  }
  const snapshots = await api.snapshots([...shas]);
  const snapshot = (sha: string) => snapshots.get(sha) ?? unreadableSnapshot(sha);
  const current: BaseHeads = { main: snapshot(mainHead), train: trainHead ? snapshot(trainHead) : null };
  // Without the current inputs every PR would look changed; fail visibly
  // instead of fanning out a dispatch per PR.
  if (!current.main.readable || (current.train && !current.train.readable))
    throw new Error('Could not read the runtime inputs of the current bases.');

  for (const { pull, headSha, record } of pending) {
    const recorded =
      record.kind === 'found'
        ? {
            main: snapshot(record.bases.mainSha),
            train: record.bases.trainSha ? snapshot(record.bases.trainSha) : null,
          }
        : undefined;
    decided.push({ pull, decision: decidePreviewRefresh(record, current, recorded, { headSha, now }) });
  }
  decided.sort((left, right) => left.pull - right.pull);
  const conservativeDispatches = decided.filter(({ decision }) => decision.dispatch && decision.conservative).length;
  const lines = decided.map(({ pull, decision }) => `PR #${pull}: ${decision.reason}`);
  if (conservativeDispatches > CONSERVATIVE_ALERT_THRESHOLD)
    lines.push(
      `${conservativeDispatches} PRs were dispatched for a missing, unreadable, failed or stuck record; previews may not be landing.`,
    );
  return {
    dispatch: decided.filter(({ decision }) => decision.dispatch).map(({ pull }) => pull),
    lines,
    conservativeDispatches,
  };
}

function objectRecord(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new Error(`${label} must be an object.`);
  return input as Record<string, unknown>;
}

function arrayOf(input: unknown, label: string): unknown[] {
  if (!Array.isArray(input)) throw new Error(`${label} must be an array.`);
  return input;
}

/** SHAs per GraphQL request. Each carries one alias per runtime input plus the commit. */
const SNAPSHOT_BATCH = 20;
const MAX_PAGES = 30;

export function snapshotQuery(shas: readonly string[]): string {
  const fields = shas.flatMap((sha, shaIndex) => {
    if (!FULL_SHA.test(sha)) throw new Error('Snapshot SHAs must be full commit SHAs.');
    return [
      `c${shaIndex}: object(oid: "${sha}") { oid }`,
      ...RUNTIME_INPUTS.map(({ path }, inputIndex) =>
        path === APP_CONFIG
          ? `c${shaIndex}_${inputIndex}: object(expression: "${sha}:${path}") { oid ... on Blob { text isTruncated } }`
          : `c${shaIndex}_${inputIndex}: object(expression: "${sha}:${path}") { oid }`,
      ),
    ];
  });
  return `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { ${fields.join(' ')} } }`;
}

export function parseSnapshots(shas: readonly string[], repositoryData: unknown): Map<string, BaseSnapshot> {
  const repositoryObjects = objectRecord(repositoryData, 'Snapshot repository');
  const result = new Map<string, BaseSnapshot>();
  shas.forEach((sha, shaIndex) => {
    const commit = repositoryObjects[`c${shaIndex}`];
    if (!commit || objectRecord(commit, 'Snapshot commit').oid !== sha) {
      result.set(sha, unreadableSnapshot(sha));
      return;
    }
    const inputs: Record<string, string> = {};
    let marketingVersion: string | null = null;
    RUNTIME_INPUTS.forEach(({ path }, inputIndex) => {
      const entry = repositoryObjects[`c${shaIndex}_${inputIndex}`];
      if (entry === null || entry === undefined) {
        inputs[path] = '';
        return;
      }
      const object = objectRecord(entry, `Snapshot ${path}`);
      if (typeof object.oid !== 'string' || !object.oid) throw new Error(`Snapshot ${path} has no object id.`);
      inputs[path] = object.oid;
      if (path === APP_CONFIG && typeof object.text === 'string' && object.isTruncated === false) {
        inputs[path] = appConfigDigest(object.text);
        marketingVersion = marketingVersionOf(object.text);
      }
    });
    result.set(sha, { sha, readable: true, inputs, marketingVersion });
  });
  return result;
}

export function createGitHubRefreshApi(options: {
  token: string;
  repository: string;
  fetchImpl?: typeof fetch;
}): RefreshApi {
  const { token, repository } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) throw new Error('Expected an owner/repo repository.');
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const rest = async (path: string, allowMissing = false): Promise<unknown> => {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${path} returned HTTP ${response.status}.`);
    return (await response.json()) as unknown;
  };
  const graphql = async (query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const response = await fetchImpl('https://api.github.com/graphql', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { owner, repo, ...variables } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub GraphQL returned HTTP ${response.status}.`);
    const body = objectRecord(await response.json(), 'GraphQL response');
    if (Array.isArray(body.errors) && body.errors.length > 0) throw new Error('GitHub GraphQL returned errors.');
    return objectRecord(body.data, 'GraphQL data');
  };
  const paged = async (path: string): Promise<unknown[]> => {
    const items: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const batch = arrayOf(await rest(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`), path);
      items.push(...batch);
      if (batch.length < 100) return items;
    }
    throw new Error(`${path} exceeded ${MAX_PAGES} pages.`);
  };
  return {
    async openPulls() {
      return (await paged('/pulls?state=open')).map((input) => {
        const pull = objectRecord(input, 'Pull request');
        const head = objectRecord(pull.head, 'Pull request head');
        const headRepository = head.repo ? objectRecord(head.repo, 'Head repository').full_name : null;
        const base = objectRecord(pull.base, 'Pull request base');
        if (
          !Number.isSafeInteger(pull.number) ||
          typeof head.ref !== 'string' ||
          typeof head.sha !== 'string' ||
          typeof base.ref !== 'string'
        )
          throw new Error('Pull request is malformed.');
        return {
          number: pull.number as number,
          headRef: head.ref,
          headSha: head.sha,
          headRepository: typeof headRepository === 'string' ? headRepository : null,
          baseRef: base.ref,
        };
      });
    },
    async pullFiles(pull) {
      return (await paged(`/pulls/${pull}/files`)).map((input) => {
        const filename = objectRecord(input, 'Pull request file').filename;
        if (typeof filename !== 'string') throw new Error('Pull request file has no name.');
        return filename;
      });
    },
    async branchHead(branch) {
      const result = await rest(`/branches/${encodeURIComponent(branch)}`, true);
      if (result === null) return null;
      const sha = objectRecord(objectRecord(result, 'Branch').commit, 'Branch commit').sha;
      if (typeof sha !== 'string' || !FULL_SHA.test(sha)) throw new Error(`${branch} has no full head SHA.`);
      return sha;
    },
    async latestPreview(pull) {
      const task = `ota-preview-pr-${pull}`;
      const deployments = arrayOf(
        await rest(`/deployments?environment=pr-preview&task=${encodeURIComponent(task)}&per_page=3`),
        'Preview deployments',
      ).map((input) => objectRecord(input, 'Preview deployment'));
      if (deployments.length === 0) return { kind: 'missing' };
      const isPreview = (deployment: Record<string, unknown>) =>
        deployment.environment === 'pr-preview' &&
        deployment.task === task &&
        deployment.description === `OTA preview pr-${pull}` &&
        deployment.transient_environment === true &&
        deployment.production_environment === false &&
        Number.isSafeInteger(deployment.id) &&
        (deployment.id as number) > 0 &&
        typeof deployment.sha === 'string' &&
        typeof deployment.created_at === 'string';
      const latestStatus = async (deployment: Record<string, unknown>) => {
        const statuses = arrayOf(
          await rest(`/deployments/${deployment.id as number}/statuses?per_page=1`),
          'Preview deployment statuses',
        );
        if (statuses.length === 0)
          return { status: '', statusDescription: '', statusAt: deployment.created_at as string };
        const latest = objectRecord(statuses[0], 'Preview deployment status');
        if (typeof latest.state !== 'string' || typeof latest.created_at !== 'string') return null;
        return {
          status: latest.state,
          statusDescription: typeof latest.description === 'string' ? latest.description : '',
          statusAt: latest.created_at,
        };
      };
      const [deployment, previous] = deployments;
      if (!isPreview(deployment)) return { kind: 'unreadable', detail: 'unexpected deployment identity' };
      const status = await latestStatus(deployment);
      if (!status) return { kind: 'unreadable', detail: 'malformed deployment status' };
      // The status still matters for an unreadable payload: a reset marks it.
      const bases = parsePreviewBases(deployment.payload);
      if (!bases) return { kind: 'unreadable', detail: 'no valid otaPreviewBases', ...status };
      const recent: PreviewAttempt[] = [{ sha: deployment.sha as string, status: status.status }];
      // The previous attempt only matters for the failed-twice cap.
      if (status.status === 'failure' && previous && isPreview(previous)) {
        const previousStatus = await latestStatus(previous);
        if (previousStatus) recent.push({ sha: previous.sha as string, status: previousStatus.status });
      }
      return { kind: 'found', ...status, bases, recent };
    },
    async hasLivePreview(pull) {
      let before: string | null = null;
      const cursors = new Set<string>();
      for (;;) {
        const data = await graphql(
          `
            query ($owner: String!, $repo: String!, $number: Int!, $before: String) {
              repository(owner: $owner, name: $repo) {
                pullRequest(number: $number) {
                  timelineItems(last: 100, before: $before, itemTypes: [DEPLOYED_EVENT]) {
                    nodes {
                      ... on DeployedEvent {
                        deployment {
                          environment
                          description
                          latestStatus {
                            state
                          }
                        }
                      }
                    }
                    pageInfo {
                      hasPreviousPage
                      startCursor
                    }
                  }
                }
              }
            }
          `,
          { number: pull, before },
        );
        const history = objectRecord(
          objectRecord(objectRecord(data.repository, 'Repository').pullRequest, 'Pull request').timelineItems,
          'Preview deployment history',
        );
        const pageInfo = objectRecord(history.pageInfo, 'Preview deployment history page');
        if (typeof pageInfo.hasPreviousPage !== 'boolean') throw new Error('Unreadable preview deployment history.');
        const live = arrayOf(history.nodes, 'Preview deployment events').some((node) => {
          if (typeof node !== 'object' || node === null) return false;
          const deployment = (node as Record<string, unknown>).deployment;
          if (typeof deployment !== 'object' || deployment === null) return false;
          const { environment, description, latestStatus } = deployment as Record<string, unknown>;
          const state =
            typeof latestStatus === 'object' && latestStatus !== null
              ? (latestStatus as Record<string, unknown>).state
              : undefined;
          return environment === 'pr-preview' && description === `OTA preview pr-${pull}` && state !== 'INACTIVE';
        });
        if (live) return true;
        if (!pageInfo.hasPreviousPage) return false;
        const cursor = pageInfo.startCursor;
        if (typeof cursor !== 'string' || !cursor || cursors.has(cursor))
          throw new Error('Invalid preview deployment history cursor.');
        cursors.add(cursor);
        before = cursor;
      }
    },
    async snapshots(shas) {
      const result = new Map<string, BaseSnapshot>();
      for (let offset = 0; offset < shas.length; offset += SNAPSHOT_BATCH) {
        const batch = shas.slice(offset, offset + SNAPSHOT_BATCH);
        const data = await graphql(snapshotQuery(batch), {});
        for (const [sha, snapshot] of parseSnapshots(batch, data.repository)) result.set(sha, snapshot);
      }
      return result;
    },
  };
}

async function main() {
  const token = process.env.GH_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('GH_TOKEN and GITHUB_REPOSITORY are required.');
  const plan = await planPreviewRefresh(createGitHubRefreshApi({ token, repository }), repository);
  for (const line of plan.lines) console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      ['### Preview refresh', '', ...plan.lines.map((line) => `- ${line}`), ''].join('\n'),
    );
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `dispatch=${JSON.stringify(plan.dispatch)}\nconservative=${plan.conservativeDispatches}\n`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(`::error::${message(error)}`);
    process.exitCode = 1;
  });
}
