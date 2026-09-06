/**
 * Turns a submitted bug report into a GitHub issue in the public tracker.
 *
 * Fire-and-forget from the resolver's side-effect: a slow or broken GitHub API
 * must never fail the originating mutation, so `createFeedbackGithubIssue`
 * never throws and no-ops when unconfigured.
 *
 * Privacy: the repo is PUBLIC, so the issue body carries NO user identity
 * (no userId/email/UUID) — only the `app_feedback` row id, which an admin
 * resolves to the reporter privately. Free-text comments are run through
 * `redactSensitiveText` before they land in a world-readable issue.
 */

import type { AppFeedbackPlatform, AppFeedbackSource, FeedbackContextInput } from '@boardsesh/shared-schema';
import { redactSensitiveText } from '@boardsesh/text-redaction';
import { GITHUB_API, ensureLabels, githubHeaders, resolveGithubToken, resolveGithubRepo } from '../lib/github-client';
import { screenshotMarkdownSection } from './feedback-screenshot-urls';
import { logger } from '../utils/logger';

const TITLE_LIMIT = 120;

/**
 * The sources that become a GitHub issue. Exported so the resolver gates on the
 * same set this builder does — a report the builder would skip must not collect
 * screenshots the issue will never show.
 */
export const BUG_SOURCES: ReadonlySet<AppFeedbackSource> = new Set(['shake-bug', 'drawer-bug']);

export type FeedbackIssuePayload = {
  feedbackId: string | number | bigint;
  rating: number | null;
  comment: string | null;
  platform: AppFeedbackPlatform;
  appVersion: string | null;
  source: AppFeedbackSource;
  boardName?: string | null;
  layoutId?: number | null;
  sizeId?: number | null;
  setIds?: number[] | null;
  angle?: number | null;
  context?: FeedbackContextInput | null;
  contactConsent?: boolean | null;
  /**
   * Public URLs of the reporter's screenshots, already resolved from their
   * object keys. URLs, never keys, so this builder stays pure — the key→URL
   * trust check lives in `services/feedback-screenshot-urls.ts`.
   */
  screenshotUrls?: string[] | null;
};

export type FeedbackIssueDraft = {
  title: string;
  body: string;
  labels: string[];
};

export type CreatedIssue = {
  number: number;
  htmlUrl: string;
};

// Re-exported so this module's public surface (and its test) is unchanged by the
// move to the shared package.
export { redactSensitiveText };

function formatBoard(payload: FeedbackIssuePayload): string | null {
  if (!payload.boardName) return null;
  const parts: string[] = [payload.boardName];
  if (payload.layoutId != null) parts.push(`layout ${payload.layoutId}`);
  if (payload.sizeId != null) parts.push(`size ${payload.sizeId}`);
  if (payload.setIds && payload.setIds.length > 0) parts.push(`sets [${payload.setIds.join(',')}]`);
  const base = parts.join(' / ');
  return payload.angle != null ? `${base} @ ${payload.angle}°` : base;
}

function formatClimb(context: FeedbackContextInput | null | undefined): string | null {
  if (!context?.climbName && !context?.climbUuid) return null;
  if (context.climbName) {
    return context.difficulty ? `${context.climbName} (${context.difficulty})` : context.climbName;
  }
  return context.climbUuid ?? null;
}

function formatSession(context: FeedbackContextInput | null | undefined): string | null {
  if (!context?.sessionId) return null;
  return context.sessionName ? `${context.sessionName} (${context.sessionId})` : context.sessionId;
}

function escapeTableCell(value: string): string {
  return value.replaceAll('|', '\\|').replace(/\r?\n/g, '<br>');
}

function buildTitle(redactedComment: string): string {
  const snippet = redactedComment.replace(/\s+/g, ' ').trim();
  const base = snippet ? `🐞 Bug report: ${snippet}` : '🐞 Bug report';
  return base.length <= TITLE_LIMIT ? base : `${base.slice(0, TITLE_LIMIT - 3).trimEnd()}...`;
}

function buildMetadataTable(payload: FeedbackIssuePayload): string {
  const rows: Array<[string, string | null]> = [
    ['Platform', payload.platform],
    ['App version', payload.appVersion ?? null],
    ['Source', payload.source],
    ['Board', formatBoard(payload)],
    ['Climb', formatClimb(payload.context)],
    ['Session', formatSession(payload.context)],
    ['URL', payload.context?.url ?? null],
    ['User agent', payload.context?.userAgent ?? null],
    ['Feedback row', `app_feedback #${payload.feedbackId}`],
  ];
  return [
    '## Metadata',
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...rows.map(([field, value]) => `| ${field} | ${escapeTableCell(value ?? 'unknown')} |`),
  ].join('\n');
}

function buildContactLine(payload: FeedbackIssuePayload): string {
  if (payload.contactConsent) {
    return `## Contact\n\n✅ Reporter agreed to follow-up — resolve **app_feedback #${payload.feedbackId}** in the DB to reach them.`;
  }
  return '## Contact\n\n🚫 No contact consent — do not reach out.';
}

/**
 * Build the GitHub issue draft for a bug report. Returns null for non-bug
 * (rating) sources, which don't become issues.
 *
 * @internal exported for testing; resolver code should call createFeedbackGithubIssue.
 */
export function buildFeedbackIssue(payload: FeedbackIssuePayload): FeedbackIssueDraft | null {
  if (!BUG_SOURCES.has(payload.source)) return null;

  const rawComment = payload.comment?.trim() ?? '';
  const redactedComment = rawComment ? redactSensitiveText(rawComment) : '';

  const body = [
    `<!-- app-feedback:${payload.feedbackId} -->`,
    'Reported from the Boardsesh mobile app.',
    '',
    '## Comment',
    '',
    redactedComment || '_No comment provided._',
    '',
    buildMetadataTable(payload),
    ...screenshotMarkdownSection(payload.screenshotUrls ?? []),
    '',
    buildContactLine(payload),
  ].join('\n');

  return {
    title: buildTitle(redactedComment),
    body,
    labels: ['bug', 'user-feedback', payload.platform],
  };
}

/**
 * Create a GitHub issue from a bug report. Never throws. Returns the created
 * issue's number + html_url, or null when it no-ops or fails:
 *  - non-bug (rating) source → null,
 *  - the GitHub App unconfigured (local dev) → null,
 *  - any API error → logged and null.
 */
export async function createFeedbackGithubIssue(payload: FeedbackIssuePayload): Promise<CreatedIssue | null> {
  const draft = buildFeedbackIssue(payload);
  if (!draft) return null;

  const token = await resolveGithubToken();
  if (!token) return null;

  // Via the shared resolver, not `process.env.X ?? default`: a dashboard hands
  // back '' for a variable someone cleared, which `??` would honour and turn
  // into a POST to /repos//issues.
  const repo = resolveGithubRepo();
  const [owner, name] = repo.split('/');
  if (!owner || !name) {
    logger.error(`[GitHub feedback] Invalid feedback repo "${repo}" (expected owner/name)`);
    return null;
  }

  try {
    await ensureLabels(owner, name, token, draft.labels);

    const response = await fetch(`${GITHUB_API}/repos/${owner}/${name}/issues`, {
      method: 'POST',
      headers: githubHeaders(token),
      body: JSON.stringify({ title: draft.title, body: draft.body, labels: draft.labels }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '<unreadable>');
      logger.error(`[GitHub feedback] Create issue failed: ${response.status} ${errorText}`);
      return null;
    }

    const created = (await response.json()) as { number?: number; html_url?: string };
    if (typeof created.number !== 'number' || typeof created.html_url !== 'string') {
      logger.error('[GitHub feedback] Create issue returned an unexpected response shape');
      return null;
    }
    return { number: created.number, htmlUrl: created.html_url };
  } catch (error) {
    logger.error('[GitHub feedback] Create issue error:', error);
    return null;
  }
}
