/**
 * The one place backend code talks to the GitHub REST API.
 *
 * Two consumers today: `services/github-feedback.ts` (opens an issue per bug
 * report) and `services/github-qa.ts` (reads open PRs, comments a tester's
 * verdict, swaps its label). They shared header-building and label-creation
 * code by copy, so it lives here instead.
 *
 * Nothing in this module throws for a non-2xx response — callers decide. The
 * one exception is `githubRequest`, which surfaces the status so a caching
 * reader can negative-cache it.
 */

import { logger } from '../utils/logger';

export const GITHUB_API = 'https://api.github.com';

export const DEFAULT_GITHUB_REPO = 'boardsesh/boardsesh';

/**
 * Colors mirror the TestFlight→issues sync (scripts/testflight-feedback-to-issues.ts)
 * so labels created by either path look consistent. `qa-approved` / `qa-declined`
 * reuse the green/red the tracker already uses for pass/fail signals.
 */
export const LABEL_COLORS: Record<string, string> = {
  bug: 'd73a4a',
  'user-feedback': 'fbca04',
  ios: '1d76db',
  android: '0e8a16',
  web: '5319e7',
  'qa-approved': '0e8a16',
  'qa-declined': 'd73a4a',
};

export function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'boardsesh-backend',
  };
}

/**
 * Best-effort: create each label if it doesn't exist. 422 = already exists (the
 * common case), which is fine. Failures here never block the caller's write.
 */
export async function ensureLabels(owner: string, repo: string, token: string, labels: string[]): Promise<void> {
  for (const label of labels) {
    try {
      const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/labels`, {
        method: 'POST',
        headers: githubHeaders(token),
        body: JSON.stringify({ name: label, color: LABEL_COLORS[label] ?? 'ededed' }),
      });
      if (!response.ok && response.status !== 422) {
        logger.warn(`[github] ensureLabel ${label}: ${response.status}${await describeFailure(response)}`);
      }
    } catch (error) {
      logger.warn(`[github] ensureLabel ${label} error:`, error);
    }
  }
}

/** Cap on GitHub's own error text. The real ones are a short sentence. */
const ERROR_MESSAGE_MAX = 200;

/**
 * Why GitHub refused a call, reduced to the parts that are safe to log.
 *
 * The body is never logged whole — some error shapes echo the request back,
 * token and all. Two fields earn their place: `message` is a fixed sentence
 * ("Resource not accessible by personal access token"), and on a
 * fine-grained-PAT refusal `x-accepted-github-permissions` names the permission
 * the token lacks (`pull_requests=write`). Without them, a 403 for a missing
 * scope and a 403 for an exhausted rate limit read identically — which is how a
 * QA token that could not comment on a pull request went a week unnoticed,
 * every verdict recorded and none of them mirrored.
 */
async function describeFailure(response: Response): Promise<string> {
  const reasons: string[] = [];
  const message = await readGitHubMessage(response);
  if (message) reasons.push(message);
  const acceptedPermissions = response.headers.get('x-accepted-github-permissions');
  if (acceptedPermissions) reasons.push(`token needs ${acceptedPermissions}`);
  if (response.headers.get('x-ratelimit-remaining') === '0') reasons.push('rate limit exhausted');
  return reasons.length > 0 ? ` (${reasons.join('; ')})` : '';
}

/** GitHub's `message` field, or null when the body is missing or not JSON. */
async function readGitHubMessage(response: Response): Promise<string | null> {
  try {
    const payload = (await response.json()) as { message?: unknown };
    return typeof payload.message === 'string' ? payload.message.slice(0, ERROR_MESSAGE_MAX) : null;
  } catch {
    return null;
  }
}

/**
 * A single GitHub REST call, JSON in and out. Throws on a non-2xx status with
 * the status and GitHub's own reason in the message, so a caller can
 * negative-cache it or log it and know what to fix — see {@link describeFailure}
 * for what is and isn't safe to carry out of the body.
 *
 * `token` is optional: the public repo answers unauthenticated reads at 60/hr
 * per IP, which the caching readers stay under. Writes always need one.
 */
export async function githubRequest<T>(path: string, init?: RequestInit, token?: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'boardsesh-backend',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init?.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: { ...headers, ...((init?.headers as Record<string, string> | undefined) ?? {}) },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub ${init?.method ?? 'GET'} ${path} responded ${response.status}${await describeFailure(response)}`,
    );
  }
  // 204 No Content (label DELETE) has no body to parse.
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * First env var that actually holds something.
 *
 * `??` is the wrong operator for this: `.env.development` ships `QA_GITHUB_TOKEN=`
 * and a deploy dashboard hands back `''` for a variable someone cleared, both of
 * which are "set" to `??` and would shadow the fallback — an empty
 * `QA_GITHUB_REPO` would leave the reader asking GitHub for `/repos//pulls`
 * forever. Trimmed too, because a pasted secret carries a trailing newline more
 * often than anyone would like.
 */
function firstConfiguredValue(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/**
 * The token the crowdsourced-QA writer uses. `QA_GITHUB_TOKEN` when set, else
 * the bug-report token — they need the same repo and overlapping scopes, so a
 * single-token deploy keeps working. Undefined when neither is configured, in
 * which case the GitHub mirror no-ops (local dev; the verdict row still lands).
 */
export function resolveQaGithubToken(): string | undefined {
  return firstConfiguredValue(process.env.QA_GITHUB_TOKEN, process.env.FEEDBACK_GITHUB_TOKEN);
}

/** `owner/name` the QA reader/writer targets. Overridable for forks. */
export function resolveQaGithubRepo(): string {
  return firstConfiguredValue(process.env.QA_GITHUB_REPO, process.env.FEEDBACK_GITHUB_REPO) ?? DEFAULT_GITHUB_REPO;
}
