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
  reason: GithubMirrorDropReason;
  /** The row that still holds what GitHub never got. */
  record: { table: 'qa_verdicts' | 'app_feedback'; id: string };
  repo: string;
  /** PR the mirror targeted, for the QA operations. */
  prNumber?: number | null;
  /** Whose write was lost. Sizes the blast radius; never rendered publicly. */
  userId?: string | null;
  /** What the error actually was, when there was one. */
  cause?: unknown;
};

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
function replayHint(drop: GithubMirrorDrop): string {
  if (drop.record.table === 'qa_verdicts') {
    return `SELECT * FROM qa_verdicts WHERE id = '${drop.record.id}' -- github_comment_id IS NULL`;
  }
  return `SELECT * FROM app_feedback WHERE id = '${drop.record.id}' -- github_issue_number IS NULL`;
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
    const detail = githubErrorDetailOf(drop.cause);
    const target = drop.prNumber != null ? ` for PR #${drop.prNumber}` : '';
    const summary =
      `[github-mirror] ${drop.operation} was dropped (${drop.reason}` +
      `${detail ? `, status ${detail.status}` : ''})${target}; ` +
      `${drop.record.table} ${drop.record.id} still holds it. ` +
      `repo=${drop.repo} replay=${replayHint(drop)}` +
      `${detail ? ` request_id=${detail.requestId ?? 'none'} body=${detail.body}` : ''}`;

    // Message-only on purpose — see the doc comment. The Sentry copy below is
    // the one carrying context.
    logger.error(summary);

    const title = detail
      ? `GitHub mirror dropped ${drop.operation} (${drop.reason}, ${detail.status})`
      : `GitHub mirror dropped ${drop.operation} (${drop.reason})`;

    Sentry.withScope((scope) => {
      // The backend never calls setUser, so a backend issue's "users impacted"
      // is a count of Cloudflare edge IPs. For this event it is the one number
      // that sizes the loss, so set it here rather than nowhere.
      if (drop.userId) scope.setUser({ id: drop.userId });
      scope.setTag('github_mirror.operation', drop.operation);
      scope.setTag('github_mirror.reason', drop.reason);
      scope.setTag('github_mirror.record_table', drop.record.table);
      if (detail) scope.setTag('github_mirror.status', String(detail.status));
      scope.setContext('github_mirror', {
        operation: drop.operation,
        reason: drop.reason,
        repo: drop.repo,
        recordTable: drop.record.table,
        recordId: drop.record.id,
        prNumber: drop.prNumber ?? null,
        replay: replayHint(drop),
        status: detail?.status ?? null,
        requestId: detail?.requestId ?? null,
        rateLimitRemaining: detail?.rateLimitRemaining ?? null,
        rateLimitReset: detail?.rateLimitReset ?? null,
        responseBody: detail?.body ?? null,
      });
      Sentry.captureException(new GithubMirrorDropError(title, { cause: drop.cause }));
    });
  } catch (error) {
    // A failure inside the reporter must not escape into the mirror block that
    // called it, or one lost comment becomes a lost comment plus a lost label.
    logger.warn('[github-mirror] could not report a dropped mirror:', error);
  }
}
