/**
 * What a failed GitHub REST call is allowed to remember.
 *
 * Every GitHub write in this backend is best effort: the `qa_verdicts` /
 * `app_feedback` row is the record, and a rejected mirror must never fail the
 * mutation that wrote it. The cost of that design was that a rejection carried
 * nothing but an HTTP status, so a 403 that ate three QA verdicts (Sentry
 * BOARDSESH-GV / GT) could not be explained afterwards — GitHub's own
 * `message` / `documentation_url`, which name the missing scope or the
 * secondary rate limit, were read off the wire and thrown away.
 *
 * Both call sites that dropped the body did so for one stated reason: GitHub
 * echoes parts of the request back in some error shapes, and a request carries
 * an installation token in its `Authorization` header. So the body is kept —
 * redacted and truncated — rather than discarded. `redactGithubErrorBody` is
 * the whole of that mitigation; it runs before the text reaches a log line or a
 * Sentry event.
 *
 * Lives in its own module (not `github-client.ts`) because `github-app-auth.ts`
 * needs it too, and `github-client.ts` already imports from that file.
 */

/**
 * How much of an error body to keep. GitHub's error JSON is a `message`, a
 * `documentation_url` and sometimes an `errors` array — comfortably under this.
 * The cap exists so a proxy's HTML error page or a pathological body cannot
 * flood a log line or a Sentry event.
 */
const ERROR_BODY_LIMIT = 600;

const REDACTED = '[redacted credential]';

/**
 * Credential shapes that could ride back out in an echoed request, and what
 * replaces them.
 *
 * Order matters. `Bearer <x>` / `token <x>` runs FIRST and swallows the whole
 * value, because a scheme pattern applied after a prefix pattern would match
 * the placeholder the prefix pattern just wrote and redact half of it again.
 *
 * `ghs_` is the installation token this backend actually carries; the other
 * `gh*_` prefixes and `github_pat_` cover the PAT era and anything a
 * misconfigured deploy might still hold. `v1.<40 hex>` is the legacy
 * installation-token format. The JWT pattern catches the App JWT that
 * `github-app-auth.ts` signs, which is what the mint calls authenticate with.
 *
 * String replacements, not callbacks: `String.replace` passes the match OFFSET
 * as the second callback argument when a pattern has no capture group, so a
 * shared `(match, group) => ...` callback silently renders a number for the
 * group-less patterns.
 */
const CREDENTIAL_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\b(Bearer|token)\s+[^\s"',}]+/gi, `$1 ${REDACTED}`],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, REDACTED],
  [/\bv1\.[0-9a-f]{40}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, REDACTED],
];

/**
 * Strip anything token-shaped out of a GitHub error body and squeeze it down to
 * one bounded line.
 *
 * Best effort, like every redactor: it is a net over the shapes GitHub can
 * plausibly echo, not a proof. It is paired with the rule that the body only
 * ever reaches our own logs and Sentry — never a public issue comment.
 */
export function redactGithubErrorBody(body: string): string {
  let redacted = body;
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  const collapsed = redacted.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '<empty body>';
  return collapsed.length > ERROR_BODY_LIMIT ? `${collapsed.slice(0, ERROR_BODY_LIMIT)}...` : collapsed;
}

/**
 * Everything worth keeping about a non-2xx GitHub response.
 *
 * `requestId` is the one field GitHub Support asks for, and it is the only way
 * to distinguish "our token is wrong" from "GitHub had a bad minute" after the
 * fact. The rate-limit pair separates a primary 403 (budget exhausted, resets
 * at a known time) from a permissions 403 (resets never).
 */
export type GithubErrorDetail = {
  status: number;
  /** Redacted, collapsed, length-capped response body. Never raw. */
  body: string;
  /** `x-github-request-id`, or null when the response carried none. */
  requestId: string | null;
  /** `x-ratelimit-remaining`, or null. */
  rateLimitRemaining: string | null;
  /** `x-ratelimit-reset` (epoch seconds), or null. */
  rateLimitReset: string | null;
};

/**
 * One header off a response that may not have any.
 *
 * A real `fetch` always hands back a `Response` with `headers`. This runs on the
 * failure path, though, where the whole point is that things are already going
 * wrong — a stub, a polyfill, or a mocked module boundary can hand over
 * something thinner. Reading a header must never be the thing that turns one
 * failure into two.
 */
function headerOf(response: Partial<Response> | null | undefined, name: string): string | null {
  return response?.headers?.get?.(name) ?? null;
}

/**
 * Read a failed response into a {@link GithubErrorDetail}.
 *
 * Consumes the body, so call it once per response and only on a non-2xx. Total
 * on purpose: a body that cannot be read (already consumed, socket gone, no
 * `text` at all) degrades to a marker, and a response with no `status` reports
 * `0` rather than throwing over the original failure.
 */
export async function readGithubErrorDetail(
  response: Partial<Response> | null | undefined,
): Promise<GithubErrorDetail> {
  let raw = '';
  try {
    raw = (await response?.text?.()) ?? '';
  } catch {
    raw = '';
  }
  return {
    status: typeof response?.status === 'number' ? response.status : 0,
    body: redactGithubErrorBody(raw),
    requestId: headerOf(response, 'x-github-request-id'),
    rateLimitRemaining: headerOf(response, 'x-ratelimit-remaining'),
    rateLimitReset: headerOf(response, 'x-ratelimit-reset'),
  };
}

/** One-line rendering of a detail, for a log message or an Error message. */
export function formatGithubErrorDetail(detail: GithubErrorDetail): string {
  const parts = [`status=${detail.status}`];
  if (detail.requestId) parts.push(`request_id=${detail.requestId}`);
  if (detail.rateLimitRemaining) parts.push(`rate_limit_remaining=${detail.rateLimitRemaining}`);
  parts.push(`body=${detail.body}`);
  return parts.join(' ');
}

/**
 * A non-2xx from the GitHub REST API, carrying why.
 *
 * Thrown instead of a bare `Error` so a caller three frames up can still reach
 * the status and the body — `githubErrorDetailOf` is how, and it is what turns
 * a dropped mirror into a diagnosable Sentry event rather than "mirror failed".
 */
export class GithubRequestError extends Error {
  readonly method: string;
  readonly path: string;
  readonly detail: GithubErrorDetail;

  constructor(method: string, path: string, detail: GithubErrorDetail) {
    super(`GitHub ${method} ${path} responded ${detail.status}: ${detail.body}`);
    this.name = 'GithubRequestError';
    this.method = method;
    this.path = path;
    this.detail = detail;
  }

  /** Status alone, for a caller that only wants to negative-cache on it. */
  get status(): number {
    return this.detail.status;
  }
}

/**
 * The detail behind an unknown caught value, or null when it did not come from
 * a GitHub call. Walks the `cause` chain, so wrapping stays allowed.
 */
export function githubErrorDetailOf(error: unknown): GithubErrorDetail | null {
  let current: unknown = error;
  // Bounded: a malformed cause chain must not spin here.
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (current instanceof GithubRequestError) return current.detail;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
