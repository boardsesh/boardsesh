/**
 * One place to announce that a GitHub mirror never landed.
 *
 * Both mirrors — a QA verdict's comment + label (`docs/crowdsourced-qa.md`) and
 * an in-app bug report's issue — are fire-and-forget by design: the
 * `qa_verdicts` / `app_feedback` row is the record, and a GitHub outage must
 * cost the copy, never the mutation. What it must NOT cost is knowing that a
 * copy went missing.
 *
 * Two real incidents made that concrete. A 403 on the verdict mirror ate three
 * comments across #4872 and #5107, neither PR ever got its verdict label, and
 * both merged anyway — nobody ran the `github_comment_id IS NULL` query the
 * runbook names, because nothing told them to. Separately, the App shipped to
 * production before it was installed on the repo, and for 3h23m every in-app
 * bug report stored its row and filed no issue.
 *
 * So a drop now produces two artifacts:
 *
 * 1. A structured `[github-mirror]` line on the backend logger — greppable, and
 *    it names the row that still holds the truth.
 * 2. A Sentry event with the row id, the operation, the failing status and
 *    GitHub's own (redacted) response body, scoped to the user whose write was
 *    lost. That is the alert; there is no polling job to write.
 *
 * Deliberately NOT a retry queue: that is a standing decision for this feature,
 * and the mirror is reconstructible from the row it names, so the event carries
 * the replay hint instead.
 */

import * as Sentry from '@sentry/node';
import { githubErrorDetailOf } from '../lib/github-error';
import { logger } from '../utils/logger';

/** Which mirror was lost. Doubles as the Sentry grouping key. */
export type GithubMirrorOperation = 'qa-verdict-comment' | 'qa-verdict-label' | 'feedback-issue';

/**
 * Why it was lost.
 *
 * `unconfigured` is the App having no usable token — the shape of the 3h23m
 * outage, and the one an operator fixes in the deploy dashboard rather than in
 * code. `rejected` is GitHub answering with a status. `unexpected-response` is
 * a 2xx whose payload was not the shape we asked for.
 */
export type GithubMirrorDropReason = 'unconfigured' | 'rejected' | 'unexpected-response';

export type GithubMirrorDrop = {
  operation: GithubMirrorOperation;
  /** The row that still holds what GitHub never got. */
  record: { table: 'qa_verdicts' | 'app_feedback'; id: string };
  repo: string;
  /** PR the mirror targeted, for the QA operations. */
  prNumber?: number | null;
  /** Whose write was lost. Sizes the blast radius; never rendered publicly. */
  userId?: string | null;
  /**
   * Whatever the mirror function returned. Deliberately `unknown`: the caller
   * hands it over without inspecting it, and every dereference happens here,
   * once, defensively — see {@link dropReasonOf}.
   */
  outcome?: unknown;
  /** Reason override, for a drop with no outcome object behind it. */
  reason?: GithubMirrorDropReason;
};

const DROP_REASONS: ReadonlySet<string> = new Set<GithubMirrorDropReason>([
  'unconfigured',
  'rejected',
  'unexpected-response',
]);

/**
 * The reason behind a non-success outcome.
 *
 * Reads `.status` off a value that may be `undefined`, `null`, or a shape
 * nobody planned for, and never throws doing it. That tolerance is the whole
 * point rather than defensive noise: this runs inside a fire-and-forget block
 * whose other job is writing the GitHub id back onto the row, so a TypeError
 * here does not just lose the report — it takes the write-back down with it and
 * leaves exactly the silent drop this module exists to end.
 *
 * An unrecognised shape is `unexpected-response`, which is honest: we asked for
 * a mirror and got back something we cannot read as success.
 */
export function dropReasonOf(outcome: unknown): GithubMirrorDropReason {
  const status = (outcome as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'string' && DROP_REASONS.has(status)
    ? (status as GithubMirrorDropReason)
    : 'unexpected-response';
}

/** The error an outcome carried, if it carried one. Never throws. */
function dropCauseOf(outcome: unknown): unknown {
  return (outcome as { cause?: unknown } | null | undefined)?.cause;
}

/**
 * The Sentry event's exception.
 *
 * A named class with a message built from operation + reason + status only —
 * ids and bodies live in the event context, not the title — so Sentry groups
 * one issue per failure mode instead of one per dropped row, and a spike in a
 * single mode stays legible.
 */
export class GithubMirrorDropError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GithubMirrorDropError';
  }
}

/** How an operator replays one dropped mirror by hand. */
function replayHint(record: GithubMirrorDrop['record'] | undefined): string {
  const table = record?.table ?? 'qa_verdicts';
  const nullColumn = table === 'qa_verdicts' ? 'github_comment_id' : 'github_issue_number';
  return `SELECT * FROM ${table} WHERE id = '${record?.id ?? 'unknown'}' -- ${nullColumn} IS NULL`;
}

/**
 * Report a mirror that never landed.
 *
 * Never throws: it runs inside the same fire-and-forget block whose whole job is
 * to not take the mutation down with it.
 *
 * The Sentry capture is direct rather than via `logger.error(msg, err)` because
 * the winston transport captures with a fixed scope, and the two facts that make
 * this event worth having — which row was lost, and whose write it was — have to
 * be attached per event. The paired log line is therefore message-only, which is
 * also what keeps the transport from filing a second, poorer copy of the same
 * failure.
 */
export function reportGithubMirrorDrop(drop: GithubMirrorDrop): void {
  try {
    const reason = drop.reason ?? dropReasonOf(drop.outcome);
    const cause = dropCauseOf(drop.outcome);
    const detail = githubErrorDetailOf(cause);
    const recordTable = drop.record?.table ?? 'qa_verdicts';
    const recordId = drop.record?.id ?? 'unknown';
    const replay = replayHint(drop.record);
    const target = drop.prNumber != null ? ` for PR #${drop.prNumber}` : '';
    const summary =
      `[github-mirror] ${drop.operation} was dropped (${reason}` +
      `${detail ? `, status ${detail.status}` : ''})${target}; ` +
      `${recordTable} ${recordId} still holds it. ` +
      `repo=${drop.repo} replay=${replay}` +
      `${detail ? ` request_id=${detail.requestId ?? 'none'} body=${detail.body}` : ''}`;

    // Message-only on purpose — see the doc comment. The Sentry copy below is
    // the one carrying context.
    logger.error(summary);

    const title = detail
      ? `GitHub mirror dropped ${drop.operation} (${reason}, ${detail.status})`
      : `GitHub mirror dropped ${drop.operation} (${reason})`;

    Sentry.withScope((scope) => {
      // The backend never calls setUser, so a backend issue's "users impacted"
      // is a count of Cloudflare edge IPs. For this event it is the one number
      // that sizes the loss, so set it here rather than nowhere.
      if (drop.userId) scope.setUser({ id: drop.userId });
      scope.setTag('github_mirror.operation', drop.operation);
      scope.setTag('github_mirror.reason', reason);
      scope.setTag('github_mirror.record_table', recordTable);
      if (detail) scope.setTag('github_mirror.status', String(detail.status));
      scope.setContext('github_mirror', {
        operation: drop.operation,
        reason,
        repo: drop.repo,
        recordTable,
        recordId,
        prNumber: drop.prNumber ?? null,
        replay,
        status: detail?.status ?? null,
        requestId: detail?.requestId ?? null,
        rateLimitRemaining: detail?.rateLimitRemaining ?? null,
        rateLimitReset: detail?.rateLimitReset ?? null,
        responseBody: detail?.body ?? null,
      });
      Sentry.captureException(new GithubMirrorDropError(title, { cause }));
    });
  } catch (error) {
    // A failure inside the reporter must not escape into the mirror block that
    // called it, or one lost comment becomes a lost comment plus a lost label.
    logger.warn('[github-mirror] could not report a dropped mirror:', error);
  }
}
