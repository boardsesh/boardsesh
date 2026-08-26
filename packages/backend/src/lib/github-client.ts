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
        const errorText = await response.text().catch(() => '<unreadable>');
        logger.warn(`[github] ensureLabel ${label}: ${response.status} ${errorText}`);
      }
    } catch (error) {
      logger.warn(`[github] ensureLabel ${label} error:`, error);
    }
  }
}

/**
 * A single GitHub REST call, JSON in and out. Throws on a non-2xx status with
 * the status in the message so a caller can negative-cache or log it; the body
 * is not included (it can carry a token echo in some error shapes).
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
    throw new Error(`GitHub ${init?.method ?? 'GET'} ${path} responded ${response.status}`);
  }
  // 204 No Content (label DELETE) has no body to parse.
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * The token the crowdsourced-QA writer uses. `QA_GITHUB_TOKEN` when set, else
 * the bug-report token — they need the same repo and overlapping scopes, so a
 * single-token deploy keeps working. Undefined when neither is configured, in
 * which case the GitHub mirror no-ops (local dev; the verdict row still lands).
 */
export function resolveQaGithubToken(): string | undefined {
  return process.env.QA_GITHUB_TOKEN ?? process.env.FEEDBACK_GITHUB_TOKEN;
}

/** `owner/name` the QA reader/writer targets. Overridable for forks. */
export function resolveQaGithubRepo(): string {
  return process.env.QA_GITHUB_REPO ?? process.env.FEEDBACK_GITHUB_REPO ?? DEFAULT_GITHUB_REPO;
}
