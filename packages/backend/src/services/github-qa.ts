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
import type { QaLabel, QaOtaBuildState, QaPreview, QaVerdict, QaVerdictKind } from '@boardsesh/shared-schema';
import { redactSensitiveText } from '@boardsesh/text-redaction';
import { ensureLabels, githubRequest, resolveGithubToken, resolveGithubRepo } from '../lib/github-client';
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
// Cold-cache fan-out bound for the per-SHA commit lookups (see getHeadCommitDates).
const COMMIT_DATE_CONCURRENCY = 5;
// A display name is user-typed and lands in the comment's heading line, so it
// gets the same treatment as any other free text plus a hard length cap.
const DISPLAY_NAME_MAX = 60;
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
  /** Every label on the PR, in GitHub's order. */
  labels: QaLabel[];
};

// The subset of GitHub's pull-request payload this module reads.
type GitHubPullRequestPayload = {
  number?: number;
  /** 'open' | 'closed'. Only the single-PR endpoint is read for this. */
  state?: string;
  title?: string;
  body?: string | null;
  html_url?: string;
  draft?: boolean;
  updated_at?: string;
  user?: { login?: string } | null;
  head?: { sha?: string } | null;
  labels?: ({ name?: string; color?: string } | null)[] | null;
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
  /** The author's Boardsesh display name; null falls back to ANONYMOUS_REPORTER. */
  displayName: string | null;
  /** The author's free text, unredacted — this function redacts it. */
  comment: string | null;
  platform: string;
  /** Marketing name of the handset the author ran, e.g. `iPhone 17 Pro`. */
  deviceModel: string | null;
  /** OS release the author ran, e.g. `26.1`. */
  osVersion: string | null;
  appVersion: string | null;
  updateId: string | null;
  runtimeVersion: string | null;
  /** ISO 8601 publish time of the bundle the author ran. */
  bundleCreatedAt: string | null;
  headSha: string | null;
  /** ISO 8601 committer date of `headSha`. */
  headCommittedAt: string | null;
  /** Verdicts other people filed on this same head SHA. */
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
    labels: normalizeLabels(payload.labels),
  };
}

/**
 * GitHub's labels, reduced to name + colour. A label with no name is dropped
 * rather than rendered as an empty chip; a missing colour falls back to
 * GitHub's own default grey.
 */
function normalizeLabels(payload: GitHubPullRequestPayload['labels']): QaLabel[] {
  const labels: QaLabel[] = [];
  for (const label of payload ?? []) {
    if (typeof label?.name !== 'string' || label.name.length === 0) continue;
    labels.push({ name: label.name, color: typeof label.color === 'string' ? label.color : 'ededed' });
  }
  return labels;
}

type PullRequestCache = { at: number; pullRequests: QaPullRequest[]; isError: boolean };
let pullRequestCache: PullRequestCache | null = null;
// De-dupes concurrent refills (cold start / just-expired) onto a single fetch,
// so a burst of testers opening the app can't fan out into parallel GitHub calls.
let inFlightPullRequests: Promise<QaPullRequest[]> | null = null;
const commitDateCache = new Map<string, string>();
let hasWarnedMissingToken = false;

async function fetchOpenPullRequests(): Promise<QaPullRequest[]> {
  const repo = resolveGithubRepo();
  const token = await resolveGithubToken();
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
 * decide how to degrade — resolvers go through {@link readOpenPullRequests},
 * which turns both the throw and the negative-cached `[]` into one flag.
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

/** The open-PR list plus whether it is standing in for a GitHub failure. */
export type OpenPullRequestsRead = {
  pullRequests: QaPullRequest[];
  /**
   * True when GitHub could not be read — either this call failed or a recent
   * one did and the negative cache is still serving its empty list. It is the
   * only way to tell "GitHub is down" from "this repo genuinely has no open
   * pull requests", which are the same `[]` to a caller.
   */
  failed: boolean;
};

/**
 * {@link getOpenPullRequests} for resolvers: never throws, and says whether the
 * list it returns is real. A raw throw would otherwise reach the client as
 * `GitHub GET /repos/... responded 403` on the first failure and as a bare `[]`
 * for the next 30 seconds — two different behaviours for one outage.
 */
export async function readOpenPullRequests(now: number = Date.now()): Promise<OpenPullRequestsRead> {
  try {
    const pullRequests = await getOpenPullRequests(now);
    return { pullRequests, failed: pullRequestCache?.isError === true };
  } catch (error) {
    logger.warn('[qa] open pull request lookup failed; serving no previews:', error);
    return { pullRequests: [], failed: true };
  }
}

/** One pull request, read fresh — see {@link getPullRequest}. */
export type FreshPullRequestLookup =
  | { status: 'open'; pullRequest: QaPullRequest }
  | { status: 'closed' }
  | { status: 'unavailable' };

/**
 * One pull request, read straight from GitHub with no cache in the way.
 *
 * The three-minute list cache is right for `qaPreviews` — a slightly stale
 * browse screen costs nothing. It is wrong for filing a verdict: inside that
 * window a PR can pick up a new head commit (so the verdict would be recorded
 * against a revision the tester never ran, and skip the "older revision"
 * warning) or be closed outright (so a verdict would be accepted, and
 * `qa-approved` stamped, on a PR nobody can act on).
 *
 * Never throws. `unavailable` means GitHub could not be reached — including a
 * 404, which is indistinguishable here from a permissions blip — and the caller
 * decides how to degrade; `submitQaVerdict` falls back to the cached list.
 */
export async function getPullRequest(prNumber: number): Promise<FreshPullRequestLookup> {
  try {
    const payload = await githubRequest<GitHubPullRequestPayload>(
      `/repos/${resolveGithubRepo()}/pulls/${prNumber}`,
      undefined,
      await resolveGithubToken(),
    );
    if (payload.state !== 'open') return { status: 'closed' };
    const pullRequest = normalizePullRequest(payload);
    return pullRequest ? { status: 'open', pullRequest } : { status: 'unavailable' };
  } catch (error) {
    logger.warn(`[qa] fresh lookup of #${prNumber} failed; falling back to the cached list:`, error);
    return { status: 'unavailable' };
  }
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
      `/repos/${resolveGithubRepo()}/commits/${sha}`,
      undefined,
      await resolveGithubToken(),
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
 * Committer dates for a batch of SHAs, `sha -> date | null`.
 *
 * One `qaPreviews` call may carry 50 pull requests, and on a cold cache each
 * distinct head is its own GitHub call. Firing all 50 at once would open 50
 * sockets and, on a deploy with no token, spend most of the anonymous 60/hr
 * budget in a single request — so they run {@link COMMIT_DATE_CONCURRENCY} at a
 * time. Steady state is still zero calls: every SHA is cached.
 */
export async function getHeadCommitDates(shas: readonly string[]): Promise<Map<string, string | null>> {
  const distinctShas = [...new Set(shas)];
  const committedAtBySha = new Map<string, string | null>();
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const sha = distinctShas[nextIndex];
      nextIndex += 1;
      if (sha === undefined) return;
      committedAtBySha.set(sha, await getHeadCommitDate(sha));
    }
  };

  await Promise.all(Array.from({ length: Math.min(COMMIT_DATE_CONCURRENCY, distinctShas.length) }, () => worker()));
  return committedAtBySha;
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
  otaBuild: QaOtaBuildState = 'unknown',
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
    labels: pullRequest.labels,
    otaBuild,
  };
}

// Everything a tester can type reaches this comment: their notes, their display
// name, and the version strings the app reports. GitHub renders all of it as
// Markdown with a permissive HTML subset, so unfiltered text can do three things
// we don't want:
//
//   - `<!--` opens an HTML comment that swallows the rest of the body — the
//     device table simply disappears;
//   - `@handle` notifies that person, from an account that isn't theirs;
//   - `#123` back-links an unrelated issue, leaving a cross-reference on it.
//
// `<` is escaped only where it starts an HTML-ish token, so prose like `a < b`
// still reads as typed; `@`/`#` tokens are wrapped in a code span, which GitHub
// does not linkify. (Inside a fenced block a tester pasted, the entity shows
// literally — an acceptable trade for never losing the table.)
const HTML_TOKEN_START = /<(?=[!/?a-zA-Z])/g;
const MENTION_OR_ISSUE_TOKEN = /[@#][A-Za-z0-9][\w-]*/g;
// A token only fires at a boundary, which is what keeps `a@b.com` and the
// `#issuecomment-555` tail of a pasted URL intact.
const TOKEN_BLOCKING_PREFIX = /[\w`/]/;

/**
 * Wrap every `@handle` / `#123` that GitHub would linkify in a code span.
 *
 * Scanning by hand rather than with one `replace`, because a boundary the
 * replacement itself creates still counts: in `@alice@bob` only `@alice` sits at
 * a boundary in the source, but wrapping it leaves `@bob` sitting right after a
 * backtick — where GitHub *would* linkify it. So a token that begins exactly
 * where the previous wrapped one ended joins that same span (`@alice@bob` →
 * one span, not two adjacent ones, whose backtick runs would fight).
 */
function neutralizeMentions(text: string): string {
  const spans: Array<{ start: number; end: number }> = [];

  for (const match of text.matchAll(MENTION_OR_ISSUE_TOKEN)) {
    const start = match.index;
    if (start === undefined) continue;
    const end = start + match[0].length;

    const previousSpan = spans.at(-1);
    if (previousSpan?.end === start) {
      previousSpan.end = end;
      continue;
    }
    const precedingCharacter = start > 0 ? text[start - 1] : undefined;
    if (precedingCharacter === undefined || !TOKEN_BLOCKING_PREFIX.test(precedingCharacter)) {
      spans.push({ start, end });
    }
  }

  if (spans.length === 0) return text;

  let neutralized = '';
  let copiedUpTo = 0;
  for (const span of spans) {
    neutralized += `${text.slice(copiedUpTo, span.start)}\`${text.slice(span.start, span.end)}\``;
    copiedUpTo = span.end;
  }
  return neutralized + text.slice(copiedUpTo);
}

function neutralizeMarkdown(text: string): string {
  return neutralizeMentions(text.replace(HTML_TOKEN_START, '&lt;'));
}

function escapeTableCell(value: string): string {
  return neutralizeMarkdown(value).replaceAll('|', '\\|').replace(/\r?\n/g, '<br>');
}

/**
 * Stands in for anyone who has no usable display name. Deliberately not
 * "tester": any signed-in user can file a verdict now, and only the label is
 * tester-gated.
 */
const ANONYMOUS_REPORTER = 'a Boardsesh user';

/**
 * The author's name as it can safely appear in the comment heading: one line,
 * capped, run through the same redaction as free text (a display name someone
 * set to their email must not reach a public repo), and de-fanged.
 */
function safeDisplayName(displayName: string | null): string {
  const collapsed = (displayName ?? '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return ANONYMOUS_REPORTER;
  // A name that IS an email/phone (accounts imported from Aurora often carry
  // the email as the name) would render as "[redacted email]" on a public
  // PR — ugly, and it still says "this person had no real name set". Use the
  // anonymous fallback instead of the redaction marker.
  const redacted = redactSensitiveText(collapsed);
  if (redacted !== collapsed) return ANONYMOUS_REPORTER;
  const neutralized = neutralizeMarkdown(redacted.slice(0, DISPLAY_NAME_MAX)).trim();
  return neutralized || ANONYMOUS_REPORTER;
}

function shortSha(sha: string | null): string | null {
  return sha ? sha.slice(0, 7) : null;
}

/**
 * Which revision the author actually ran, relative to the PR's head at the time
 * they filed.
 *
 * `unknown` is its own answer rather than a quiet `current`: a verdict nobody
 * can tie to a revision is not a verdict on this PR's code, and a comment that
 * reads clean is worse than one that says it could not tell.
 */
type TestedRevision = 'current' | 'outdated' | 'unknown';

function classifyTestedRevision(bundleCreatedAt: string | null, headCommittedAt: string | null): TestedRevision {
  if (!bundleCreatedAt || !headCommittedAt) return 'unknown';
  const bundleTime = Date.parse(bundleCreatedAt);
  const headTime = Date.parse(headCommittedAt);
  if (Number.isNaN(bundleTime) || Number.isNaN(headTime)) return 'unknown';
  return bundleTime < headTime ? 'outdated' : 'current';
}

const OS_LABELS: Record<string, string> = { ios: 'iOS', android: 'Android', web: 'Web' };

/**
 * The handset, as the PR author reads it: `iPhone 17 Pro (iOS 26.1)`. Either
 * half can be missing — an OS that withholds the model, a browser — so the
 * halves render independently rather than one blocking the other.
 */
function formatDevice(payload: Pick<VerdictCommentPayload, 'deviceModel' | 'osVersion' | 'platform'>): string | null {
  const model = payload.deviceModel?.trim() || null;
  const osRelease = payload.osVersion?.trim() || null;
  const osLabel = OS_LABELS[payload.platform] ?? payload.platform;
  const os = osRelease ? `${osLabel} ${osRelease}` : null;
  if (model && os) return `${model} (${os})`;
  return model ?? os;
}

const REVISION_HEADING_SUFFIX: Record<TestedRevision, string> = {
  current: '',
  outdated: ' (⚠️ outdated build)',
  unknown: ' (❓ build not identified)',
};

/**
 * The block that says which revision this verdict covers, as a GitHub alert so
 * it reads at a glance above the notes. Empty for a verdict on the current
 * head: a comment that shouts on every verdict stops being read on the ones
 * that matter.
 */
function revisionAlert(
  testedRevision: TestedRevision,
  bundleCreatedAt: string | null,
  headCommittedAt: string | null,
  headShortSha: string | null,
): string[] {
  if (testedRevision === 'current') return [];

  const head = headShortSha ?? 'the current head';
  if (testedRevision === 'outdated') {
    return [
      '',
      '> [!WARNING]',
      `> Tested an outdated build. The bundle was published ${bundleCreatedAt}, before ${head}` +
        `${headCommittedAt ? ` (${headCommittedAt})` : ''}. Anything pushed since then is untested. Re-run the plan` +
        ' on the latest preview before counting this verdict.',
    ];
  }
  return [
    '',
    '> [!NOTE]',
    `> Could not tell which revision this ran: ${bundleCreatedAt ? `no commit date for ${head}` : 'the app reported no bundle publish time'}.` +
      ` It may predate ${head}.`,
  ];
}

/**
 * The public PR comment for one verdict. Pure, so the wording is unit-tested
 * without a network. Leads with an HTML marker carrying the row id, which is
 * how a human (or a future dedupe pass) ties the comment back to the record.
 */
export function buildVerdictComment(payload: VerdictCommentPayload): string {
  const approved = payload.verdict === 'approved';
  const testerName = safeDisplayName(payload.displayName);
  const rawComment = payload.comment?.trim() ?? '';
  const redactedComment = rawComment ? neutralizeMarkdown(redactSensitiveText(rawComment)) : '';

  const testedRevision = classifyTestedRevision(payload.bundleCreatedAt, payload.headCommittedAt);
  const headShortSha = shortSha(payload.headSha);

  const rows: Array<[string, string | null]> = [
    ['Device', formatDevice(payload)],
    ['Platform', payload.platform],
    ['App version', payload.appVersion],
    ['Update id', payload.updateId],
    ['Runtime', payload.runtimeVersion],
    ['Bundle published', payload.bundleCreatedAt],
    // Named for what it is: the PR's head when the verdict was filed, which on
    // an outdated verdict is NOT the revision the author ran.
    ['PR head at verdict', headShortSha],
    // Deliberately not `#17`: GitHub would read that as an issue reference and
    // leave a cross-link on whatever issue happens to carry that number.
    ['Verdict id', `qa_verdicts.id ${payload.verdictId}`],
  ];

  const lines: string[] = [
    `<!-- boardsesh-qa-verdict:${payload.verdictId} -->`,
    // The staleness marker rides in the heading, not just in a footnote: the
    // heading is what a PR author sees in the timeline and in the notification
    // email, and a verdict on superseded code has to read as one there.
    `### ${approved ? '✅ QA approved' : '❌ QA declined'} by ${testerName}${REVISION_HEADING_SUFFIX[testedRevision]}`,
    ...revisionAlert(testedRevision, payload.bundleCreatedAt, payload.headCommittedAt, headShortSha),
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
  logger.warn('[qa] no GitHub App token available; verdicts are stored but not mirrored (see [github-app] above)');
}

/**
 * Post the verdict comment on the PR. Never throws. Returns null when there is
 * no token (local dev) or the call failed — the row already holds the verdict.
 */
export async function postVerdictComment(prNumber: number, body: string): Promise<PostedComment | null> {
  const token = await resolveGithubToken();
  if (!token) {
    warnMissingTokenOnce();
    return null;
  }

  try {
    const comment = await githubRequest<GitHubCommentPayload>(
      `/repos/${resolveGithubRepo()}/issues/${prNumber}/comments`,
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
  const token = await resolveGithubToken();
  if (!token) {
    warnMissingTokenOnce();
    return;
  }

  const repo = resolveGithubRepo();
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
