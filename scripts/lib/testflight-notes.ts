/// <reference types="node" />

/** Native-only TestFlight notes. Store writes belong to the Fastlane lane. */
import { findDeveloperVoice, parseRisk, parseTestPlan } from '@boardsesh/pr-body';
import { extractReleaseNotes } from './changelog-transform';
import type { TestflightBuildReceipt } from './testflight-build';

export const TESTFLIGHT_NOTES_MAX_BYTES = 4000;
const MAX_SCENARIOS = 5;
const NATIVE_LABEL = 'native-fingerprint';
const OTA_COMMENT_MARKER = '<!-- mobile-ota-check -->';
const RELEASE_BRANCHES = ['main', 'release/next'];

export type NotesCommandRunner = (command: string, arguments_: string[]) => string;

export interface NativeNotesPullRequest {
  number: number;
  title: string;
  body: string | null;
  mergedAt: string;
  mergeCommitOid: string | null;
  headRefOid: string;
  headRefName: string;
  headOwner: string;
  labels: string[];
}

export interface OtaComment {
  body: string;
  updatedAt: string;
  authorLogin: string;
  authorType: string;
}

export interface NativeTestScenario {
  prNumber: number;
  title: string;
  steps: string[];
  risk: number;
  mergedAt: string;
}

/** Only merged native PRs whose actual merge commit entered this binary. */
export function selectNativeNotesPullRequests(
  pullRequests: readonly NativeNotesPullRequest[],
  changedCommits: ReadonlySet<string>,
  repositoryOwner: string,
): NativeNotesPullRequest[] {
  const selected = new Map<number, NativeNotesPullRequest>();
  for (const pullRequest of pullRequests) {
    if (!pullRequest.labels.includes(NATIVE_LABEL)) continue;
    if (pullRequest.headOwner === repositoryOwner && RELEASE_BRANCHES.includes(pullRequest.headRefName)) continue;
    if (!pullRequest.mergeCommitOid) throw new Error(`PR #${pullRequest.number} has no readable merge commit.`);
    if (!changedCommits.has(pullRequest.mergeCommitOid)) continue;
    selected.set(pullRequest.number, pullRequest);
  }
  return [...selected.values()];
}

/** The label is cross-platform; only the bot's final-head iOS row proves relevance. */
export function hasIosNativeChange(pullRequest: NativeNotesPullRequest, comments: readonly OtaComment[]): boolean {
  const comment = comments
    .filter(
      (candidate) =>
        candidate.authorLogin === 'github-actions[bot]' &&
        candidate.authorType === 'Bot' &&
        candidate.body.startsWith(OTA_COMMENT_MARKER),
    )
    .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt))[0];
  const reportedHead = comment?.body.match(/^Branch `[^`]+` → `[^`]+` · commit `([0-9a-f]{7,40})`\.$/m)?.[1];
  if (!reportedHead || !pullRequest.headRefOid.startsWith(reportedHead)) {
    throw new Error(`PR #${pullRequest.number} needs an OTA compatibility comment for its final head.`);
  }
  const iosRows = comment.body.split('\n').filter((line) => line.startsWith('| iOS |'));
  if (iosRows.length === 1 && iosRows[0].startsWith('| iOS | ⚠️ Native change |')) return true;
  if (iosRows.length === 1 && iosRows[0].startsWith('| iOS | ✅ Compatible |')) return false;
  throw new Error(`PR #${pullRequest.number} has an unknown or unreadable iOS native verdict.`);
}

function plainText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Reuse complete ordered plans: prerequisites stay attached to their checks. */
export function nativeTestScenario(pullRequest: NativeNotesPullRequest): NativeTestScenario | null {
  const steps = (parseTestPlan(pullRequest.body)?.steps ?? [])
    .filter((step) => !/^CI\s+green[.!]?$/i.test(plainText(step)) && !findDeveloperVoice(step))
    .map(plainText)
    .filter(Boolean);
  if (steps.length === 0) return null;
  const releaseTitle = extractReleaseNotes(pullRequest.body)?.title;
  const title = plainText(releaseTitle ?? pullRequest.title.replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, ''));
  return {
    prNumber: pullRequest.number,
    title,
    steps,
    risk: parseRisk(pullRequest.body)?.level ?? 3,
    mergedAt: pullRequest.mergedAt,
  };
}

/** Stay within Apple's byte limit without cutting a prerequisite or expected result. */
export function renderTestflightNotes(
  receipt: TestflightBuildReceipt,
  scenarios: readonly NativeTestScenario[],
  repository: string,
): { notes: string; includedPrNumbers: number[]; omittedCount: number } {
  const header = `What to test in ${receipt.version} (${receipt.buildNumber})`;
  const compareUrl = `https://github.com/${repository}/compare/${receipt.previousBuildSha}...${receipt.sourceSha}`;
  const sorted = [...scenarios].sort(
    (first, second) =>
      second.risk - first.risk || second.mergedAt.localeCompare(first.mergedAt) || second.prNumber - first.prNumber,
  );
  const signatures = new Set<string>();
  const unique = sorted.filter((scenario) => {
    const signature = scenario.steps.join('\n').toLocaleLowerCase('en-US');
    if (signatures.has(signature)) return false;
    signatures.add(signature);
    return true;
  });
  const included: NativeTestScenario[] = [];
  const blocks: string[] = [];
  for (const scenario of unique) {
    if (included.length === MAX_SCENARIOS) break;
    const block = `${included.length + 1}. ${scenario.title} (#${scenario.prNumber})\n${scenario.steps.join('\n')}`;
    // Reserve a footer even before we know whether later scenarios fit.
    const footer = `\n\nMore native test plans: ${compareUrl}`;
    const proposed = `${[header, ...blocks, block].join('\n\n')}${footer}\n`;
    if (Buffer.byteLength(proposed, 'utf8') > TESTFLIGHT_NOTES_MAX_BYTES) continue;
    included.push(scenario);
    blocks.push(block);
  }
  const omittedCount = unique.length - included.length;
  const empty =
    unique.length === 0
      ? 'No new native test steps were supplied for this build.'
      : 'Native test plans are linked below.';
  const footer = omittedCount > 0 ? `\n\nMore native test plans: ${compareUrl}` : '';
  const notes = `${[header, ...(blocks.length ? blocks : [empty])].join('\n\n')}${footer}\n`;
  if (Buffer.byteLength(notes, 'utf8') > TESTFLIGHT_NOTES_MAX_BYTES)
    throw new Error('TestFlight notes exceed 4000 bytes.');
  return { notes, includedPrNumbers: included.map((scenario) => scenario.prNumber), omittedCount };
}

const MERGED_PRS_QUERY = `query($owner: String!, $name: String!, $base: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, baseRefName: $base, first: 100, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title body mergedAt headRefOid headRefName
        headRepositoryOwner { login }
        mergeCommit { oid }
        labels(first: 100) { nodes { name } pageInfo { hasNextPage } }
      }
    }
  }
}`;

interface PullRequestConnection {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: Array<{
    number: number;
    title: string;
    body: string | null;
    mergedAt: string;
    headRefOid: string;
    headRefName: string;
    headRepositoryOwner: { login: string } | null;
    mergeCommit: { oid: string } | null;
    labels: { nodes: Array<{ name: string }>; pageInfo: { hasNextPage: boolean } };
  }>;
}

/** No stale-file fallback: publishing misleading notes must fail this follow-up job. */
export function fetchNativeNotesPullRequests(
  runner: NotesCommandRunner,
  repository: string,
  changedCommits: ReadonlySet<string>,
): NativeNotesPullRequest[] {
  const [owner, name] = repository.split('/');
  const collected: NativeNotesPullRequest[] = [];
  for (const base of RELEASE_BRANCHES) {
    let cursor: string | null = null;
    const cursors = new Set<string>();
    for (let page = 0; page < 200; page += 1) {
      const arguments_ = [
        'api',
        'graphql',
        '-f',
        `query=${MERGED_PRS_QUERY}`,
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
        '-f',
        `base=${base}`,
      ];
      if (cursor) arguments_.push('-f', `cursor=${cursor}`);
      const response = JSON.parse(runner('gh', arguments_)) as {
        errors?: unknown[];
        data?: { repository?: { pullRequests?: PullRequestConnection } };
      };
      const connection = response.data?.repository?.pullRequests;
      if (
        response.errors?.length ||
        !connection ||
        !Array.isArray(connection.nodes) ||
        typeof connection.pageInfo?.hasNextPage !== 'boolean'
      ) {
        throw new Error(`Could not read merged PRs on ${base}.`);
      }
      for (const node of connection.nodes) {
        if (node.labels.pageInfo.hasNextPage) throw new Error(`PR #${node.number} has an incomplete label list.`);
        collected.push({
          number: node.number,
          title: node.title,
          body: node.body,
          mergedAt: node.mergedAt,
          mergeCommitOid: node.mergeCommit?.oid ?? null,
          headRefOid: node.headRefOid,
          headRefName: node.headRefName,
          headOwner: node.headRepositoryOwner?.login ?? '',
          labels: node.labels.nodes.map((label) => label.name),
        });
      }
      if (!connection.pageInfo.hasNextPage) break;
      const nextCursor = connection.pageInfo.endCursor;
      if (!nextCursor || cursors.has(nextCursor) || page === 199)
        throw new Error(`Incomplete PR pagination on ${base}.`);
      cursors.add(nextCursor);
      cursor = nextCursor;
    }
  }
  return selectNativeNotesPullRequests(collected, changedCommits, owner);
}

export function fetchOtaComments(runner: NotesCommandRunner, repository: string, prNumber: number): OtaComment[] {
  const pages = JSON.parse(
    runner('gh', ['api', '--paginate', '--slurp', `repos/${repository}/issues/${prNumber}/comments?per_page=100`]),
  ) as unknown;
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
    throw new Error(`Could not read comments for PR #${prNumber}.`);
  return (pages as unknown[][]).flat().map((comment: unknown) => {
    if (!comment || typeof comment !== 'object') throw new Error(`Unreadable comment on PR #${prNumber}.`);
    const fields = comment as { body?: unknown; updated_at?: unknown; user?: { login?: unknown; type?: unknown } };
    if (
      typeof fields.body !== 'string' ||
      typeof fields.updated_at !== 'string' ||
      typeof fields.user?.login !== 'string' ||
      typeof fields.user.type !== 'string'
    ) {
      throw new Error(`Unreadable comment on PR #${prNumber}.`);
    }
    return {
      body: fields.body,
      updatedAt: fields.updated_at,
      authorLogin: fields.user.login,
      authorType: fields.user.type,
    };
  });
}

export function generateTestflightNotes(
  receipt: TestflightBuildReceipt,
  runner: NotesCommandRunner,
  repository: string,
) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid GitHub repository.');
  if (!receipt.previousBuildSha || !receipt.previousBuildTag)
    throw new Error(
      'No previous native iOS build baseline was recorded. Supply a build receipt with an explicit baseline.',
    );
  runner('git', ['merge-base', '--is-ancestor', receipt.previousBuildSha, receipt.sourceSha]);
  const changedCommits = new Set(
    runner('git', ['rev-list', receipt.sourceSha, '--not', receipt.previousBuildSha])
      .trim()
      .split('\n')
      .filter(Boolean),
  );
  if (changedCommits.size === 0) {
    return { ...renderTestflightNotes(receipt, [], repository), scenarios: [], nativePrNumbers: [] };
  }
  const candidates = fetchNativeNotesPullRequests(runner, repository, changedCommits);
  const nativePullRequests = candidates.filter((pullRequest) =>
    hasIosNativeChange(pullRequest, fetchOtaComments(runner, repository, pullRequest.number)),
  );
  const scenarios = nativePullRequests
    .map(nativeTestScenario)
    .filter((scenario): scenario is NativeTestScenario => scenario !== null);
  return {
    ...renderTestflightNotes(receipt, scenarios, repository),
    scenarios,
    nativePrNumbers: nativePullRequests.map((pullRequest) => pullRequest.number),
  };
}
