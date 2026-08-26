/**
 * Crowdsourced QA's GitHub half (docs/crowdsourced-qa.md).
 *
 * Reads: the open pull requests, so a tester who loaded a `pr-<n>` OTA preview
 * can see what the PR is and what to test. Writes: the tester's verdict, as a
 * comment on the PR plus a `qa-approved` / `qa-declined` label.
 *
 * Everything here is best effort. The `qa_verdicts` row is the record — a slow,
 * rate-limited, or unconfigured GitHub must never fail the mutation that wrote
 * it, so no exported function throws.
 *
 * Privacy: the repo is PUBLIC. The comment names the tester by their Boardsesh
 * display name (that is the point — a verdict with no author is worthless to
 * the PR author) and carries no email and no user id. Free text goes through
 * `redactSensitiveText` first.
 */

import { parseRisk, parseTestPlan } from '@boardsesh/pr-body';
import type { QaPreview, QaVerdict, QaVerdictKind } from '@boardsesh/shared-schema';
import { redactSensitiveText } from '@boardsesh/text-redaction';
import { ensureLabels, githubRequest, resolveQaGithubRepo, resolveQaGithubToken } from '../lib/github-client';
import { logger } from '../utils/logger';

const PAGE_SIZE = 100;
const CACHE_TTL_MS = 3 * 60 * 1000;
// Brief negative cache so a GitHub error (a 403 rate-limit, most likely) can't
// amplify into a request storm: callers serve [] until this elapses, then one
// refill retries. Mirrors the OTA preview-channel reader.
const ERROR_CACHE_TTL_MS = 30 * 1000;
// Head-commit dates are immutable per SHA, so the cache only ever grows with
// new commits. Bound it anyway — a long-lived process watching a busy repo
// would otherwise keep every SHA it ever saw.
const COMMIT_DATE_CACHE_MAX = 200;
const QA_LABELS = { approved: 'qa-approved', declined: 'qa-declined' } as const;

/** An open pull request, reduced to what a tester needs to see. */
export type QaPullRequest = {
  number: number;
  title: string;
  body: string | null;
  htmlUrl: string;
  isDraft: boolean;
  updatedAt: string;
  /** GitHub login of the author. */
  author: string;
  headSha: string;
};

// The subset of GitHub's pull-request payload this module reads.
type GitHubPullRequestPayload = {
  number?: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  draft?: boolean;
  updated_at?: string;
  user?: { login?: string } | null;
  head?: { sha?: string } | null;
};

type GitHubCommitPayload = {
  commit?: { committer?: { date?: string } | null } | null;
};

type GitHubCommentPayload = { id?: number; html_url?: string };

/** The comment written for one verdict. All of it is public. */
export type VerdictCommentPayload = {
  /** `qa_verdicts.id` — the row this comment mirrors. */
  verdictId: number | string;
  verdict: QaVerdictKind;
  /** The tester's Boardsesh display name; null falls back to "a Boardsesh tester". */
  displayName: string | null;
  /** The tester's free text, unredacted — this function redacts it. */
  comment: string | null;
  platform: string;
  appVersion: string | null;
  updateId: string | null;
  runtimeVersion: string | null;
  /** ISO 8601 publish time of the bundle the tester ran. */
  bundleCreatedAt: string | null;
  headSha: string | null;
  /** ISO 8601 committer date of `headSha`. */
  headCommittedAt: string | null;
  /** Verdicts other testers filed on this same head SHA. */
  otherApproved: number;
  otherDeclined: number;
};

export type PostedComment = { id: number; htmlUrl: string };

function normalizePullRequest(payload: GitHubPullRequestPayload): QaPullRequest | null {
  const { number, title, html_url: htmlUrl, updated_at: updatedAt } = payload;
  const headSha = payload.head?.sha;
  if (typeof number !== 'number' || typeof title !== 'string' || typeof htmlUrl !== 'string') return null;
  if (typeof updatedAt !== 'string' || typeof headSha !== 'string') return null;
  return {
    number,
    title,
    body: typeof payload.body === 'string' ? payload.body : null,
    htmlUrl,
    isDraft: payload.draft === true,
    updatedAt,
    author: payload.user?.login ?? 'unknown',
    headSha,
  };
}

type PullRequestCache = { at: number; pullRequests: QaPullRequest[]; isError: boolean };
let pullRequestCache: PullRequestCache | null = null;
// De-dupes concurrent refills (cold start / just-expired) onto a single fetch,
// so a burst of testers opening the app can't fan out into parallel GitHub calls.
let inFlightPullRequests: Promise<QaPullRequest[]> | null = null;
const commitDateCache = new Map<string, string>();
let hasWarnedMissingToken = false;

async function fetchOpenPullRequests(): Promise<QaPullRequest[]> {
  const repo = resolveQaGithubRepo();
  const token = resolveQaGithubToken();
  const collected: GitHubPullRequestPayload[] = [];

  const firstPage = await githubRequest<GitHubPullRequestPayload[]>(
    `/repos/${repo}/pulls?state=open&per_page=${PAGE_SIZE}&page=1`,
    undefined,
    token,
  );
  collected.push(...firstPage);
  // Two pages covers 200 open PRs. Beyond that a tester's branch may be missing
  // from the list, which reads as "PR is not open" — say so rather than guess.
  if (firstPage.length === PAGE_SIZE) {
    const secondPage = await githubRequest<GitHubPullRequestPayload[]>(
      `/repos/${repo}/pulls?state=open&per_page=${PAGE_SIZE}&page=2`,
      undefined,
      token,
    );
    collected.push(...secondPage);
    if (secondPage.length === PAGE_SIZE) {
      logger.warn(`[qa] ${repo} has more than ${PAGE_SIZE * 2} open pull requests; some previews will be missing`);
    }
  }

  const pullRequests: QaPullRequest[] = [];
  for (const payload of collected) {
    const pullRequest = normalizePullRequest(payload);
    if (pullRequest) pullRequests.push(pullRequest);
  }
  return pullRequests;
}

/**
 * Every open pull request, cached for {@link CACHE_TTL_MS} (or {@link
 * ERROR_CACHE_TTL_MS} after a failure). At most two GitHub calls per refill,
 * however many testers are asking. Throws on a GitHub failure so the caller can
 * decide how to degrade — `qaPreviews` returns an empty list.
 */
export async function getOpenPullRequests(now: number = Date.now()): Promise<QaPullRequest[]> {
  const ttl = pullRequestCache?.isError ? ERROR_CACHE_TTL_MS : CACHE_TTL_MS;
  if (pullRequestCache && now - pullRequestCache.at < ttl) return pullRequestCache.pullRequests;
  if (inFlightPullRequests) return inFlightPullRequests;

  inFlightPullRequests = (async () => {
    try {
      const pullRequests = await fetchOpenPullRequests();
      pullRequestCache = { at: now, pullRequests, isError: false };
      return pullRequests;
    } catch (error) {
      pullRequestCache = { at: now, pullRequests: [], isError: true };
      throw error;
    } finally {
      inFlightPullRequests = null;
    }
  })();

  return inFlightPullRequests;
}

/**
 * Committer date (ISO 8601) of a commit, or null when the lookup fails — the
 * staleness warning is a nicety, never a reason to reject a verdict.
 *
 * Only successful lookups are cached (a SHA's date never changes), so a
 * transient failure retries on the next verdict rather than pinning a null.
 */
export async function getHeadCommitDate(sha: string): Promise<string | null> {
  const cached = commitDateCache.get(sha);
  if (cached !== undefined) return cached;

  try {
    const commit = await githubRequest<GitHubCommitPayload>(
      `/repos/${resolveQaGithubRepo()}/commits/${sha}`,
      undefined,
      resolveQaGithubToken(),
    );
    const committedAt = commit.commit?.committer?.date;
    if (typeof committedAt !== 'string') return null;
    if (commitDateCache.size >= COMMIT_DATE_CACHE_MAX) {
      const oldest = commitDateCache.keys().next();
      if (!oldest.done) commitDateCache.delete(oldest.value);
    }
    commitDateCache.set(sha, committedAt);
    return committedAt;
  } catch (error) {
    logger.warn(`[qa] head commit lookup failed for ${sha}:`, error);
    return null;
  }
}

/**
 * A pull request as the tester's app renders it: the title, the `## Test plan`
 * steps, the `Risk: N/5` score, and whatever verdict this tester already filed.
 * Pure — every input is passed in.
 */
export function buildQaPreview(
  pullRequest: QaPullRequest,
  myLatestVerdict: QaVerdict | null,
  headCommittedAt: string | null = null,
): QaPreview {
  const plan = parseTestPlan(pullRequest.body);
  const risk = parseRisk(pullRequest.body);
  return {
    prNumber: pullRequest.number,
    branch: `pr-${pullRequest.number}`,
    title: pullRequest.title,
    url: pullRequest.htmlUrl,
    author: pullRequest.author,
    isDraft: pullRequest.isDraft,
    headSha: pullRequest.headSha,
    headCommittedAt,
    updatedAt: pullRequest.updatedAt,
    risk: risk?.level ?? null,
    riskReason: risk?.reason ?? null,
    testPlan: plan?.raw ?? null,
    testPlanSteps: plan?.steps ?? [],
    myLatestVerdict,
  };
}

function escapeTableCell(value: string): string {
  return value.replaceAll('|', '\\|').replace(/\r?\n/g, '<br>');
}

function shortSha(sha: string | null): string | null {
  return sha ? sha.slice(0, 7) : null;
}

/**
 * True when the tester's bundle was published before the PR's current head
 * commit — i.e. they tested a revision that has since been superseded.
 */
function testedAnOlderRevision(bundleCreatedAt: string | null, headCommittedAt: string | null): boolean {
  if (!bundleCreatedAt || !headCommittedAt) return false;
  const bundleTime = Date.parse(bundleCreatedAt);
  const headTime = Date.parse(headCommittedAt);
  if (Number.isNaN(bundleTime) || Number.isNaN(headTime)) return false;
  return bundleTime < headTime;
}

/**
 * The public PR comment for one verdict. Pure, so the wording is unit-tested
 * without a network. Leads with an HTML marker carrying the row id, which is
 * how a human (or a future dedupe pass) ties the comment back to the record.
 */
export function buildVerdictComment(payload: VerdictCommentPayload): string {
  const approved = payload.verdict === 'approved';
  const testerName = payload.displayName?.trim() || 'a Boardsesh tester';
  const rawComment = payload.comment?.trim() ?? '';
  const redactedComment = rawComment ? redactSensitiveText(rawComment) : '';

  const rows: Array<[string, string | null]> = [
    ['Platform', payload.platform],
    ['App version', payload.appVersion],
    ['Update id', payload.updateId],
    ['Runtime', payload.runtimeVersion],
    ['Bundle published', payload.bundleCreatedAt],
    ['Head SHA at verdict', shortSha(payload.headSha)],
    ['Verdict id', `qa_verdicts #${payload.verdictId}`],
  ];

  const lines: string[] = [
    `<!-- boardsesh-qa-verdict:${payload.verdictId} -->`,
    `### ${approved ? '✅ QA approved' : '❌ QA declined'} by ${testerName}`,
    '',
    'Filed from the Boardsesh app.',
    '',
    redactedComment
      ? redactedComment
          .split(/\r?\n/)
          .map((line) => `> ${line}`)
          .join('\n')
      : '_No notes._',
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...rows.map(([field, value]) => `| ${field} | ${escapeTableCell(value ?? 'unknown')} |`),
  ];

  if (testedAnOlderRevision(payload.bundleCreatedAt, payload.headCommittedAt)) {
    lines.push('', '⚠️ Tested an older revision — the bundle was published before the current head commit.');
  }

  if (payload.otherApproved > 0 || payload.otherDeclined > 0) {
    lines.push(
      '',
      `Other verdicts on this head: ${payload.otherApproved} approved · ${payload.otherDeclined} declined`,
    );
  }

  return lines.join('\n');
}

function warnMissingTokenOnce(): void {
  if (hasWarnedMissingToken) return;
  hasWarnedMissingToken = true;
  logger.warn('[qa] no QA_GITHUB_TOKEN/FEEDBACK_GITHUB_TOKEN configured; verdicts are stored but not mirrored');
}

/**
 * Post the verdict comment on the PR. Never throws. Returns null when there is
 * no token (local dev) or the call failed — the row already holds the verdict.
 */
export async function postVerdictComment(prNumber: number, body: string): Promise<PostedComment | null> {
  const token = resolveQaGithubToken();
  if (!token) {
    warnMissingTokenOnce();
    return null;
  }

  try {
    const comment = await githubRequest<GitHubCommentPayload>(
      `/repos/${resolveQaGithubRepo()}/issues/${prNumber}/comments`,
      { method: 'POST', body: JSON.stringify({ body }) },
      token,
    );
    if (typeof comment.id !== 'number' || typeof comment.html_url !== 'string') {
      logger.error('[qa] verdict comment returned an unexpected response shape');
      return null;
    }
    return { id: comment.id, htmlUrl: comment.html_url };
  } catch (error) {
    logger.error(`[qa] posting the verdict comment on #${prNumber} failed:`, error);
    return null;
  }
}

/**
 * Move the PR to the verdict's label: add the winner, drop the other. Latest
 * verdict wins, so a decline after an approval leaves only `qa-declined`.
 * Never throws; a 404 on the removal just means the label wasn't there.
 */
export async function applyQaLabel(prNumber: number, verdict: QaVerdictKind): Promise<void> {
  const token = resolveQaGithubToken();
  if (!token) {
    warnMissingTokenOnce();
    return;
  }

  const repo = resolveQaGithubRepo();
  const [owner, name] = repo.split('/');
  if (!owner || !name) {
    logger.error(`[qa] invalid QA repo "${repo}" (expected owner/name)`);
    return;
  }
  const winner = QA_LABELS[verdict];
  const loser = verdict === 'approved' ? QA_LABELS.declined : QA_LABELS.approved;

  try {
    await ensureLabels(owner, name, token, [QA_LABELS.approved, QA_LABELS.declined]);
    await githubRequest(
      `/repos/${repo}/issues/${prNumber}/labels`,
      { method: 'POST', body: JSON.stringify({ labels: [winner] }) },
      token,
    );
  } catch (error) {
    logger.error(`[qa] adding ${winner} to #${prNumber} failed:`, error);
    return;
  }

  try {
    await githubRequest(`/repos/${repo}/issues/${prNumber}/labels/${loser}`, { method: 'DELETE' }, token);
  } catch (error) {
    // 404 is the normal case: the PR never carried the opposite verdict.
    logger.debug(`[qa] removing ${loser} from #${prNumber} was a no-op:`, error);
  }
}

/** Test-only: drop the module caches (and the one-shot missing-token warning). */
export function resetGithubQaCaches(): void {
  pullRequestCache = null;
  inFlightPullRequests = null;
  commitDateCache.clear();
  hasWarnedMissingToken = false;
}
