/**
 * Screenshot keys → public URLs → GitHub markdown.
 *
 * A QA verdict and a bug report both carry up to
 * {@link FEEDBACK_SCREENSHOT_MAX_COUNT} object keys the client got back from
 * `POST /api/feedback-screenshots`. This module is the only place those keys
 * turn into something a reader can click, and it is the trust boundary: the
 * client hands them back as opaque strings, and the result lands in a
 * world-readable GitHub comment on a PUBLIC repo, so anything that does not
 * match a key we minted is dropped rather than rendered.
 *
 * Nothing here throws. A screenshot is an attachment on a verdict, never the
 * verdict — a misconfigured bucket degrades to a text-only comment.
 */

import { FEEDBACK_SCREENSHOT_MAX_COUNT, isFeedbackScreenshotKey } from '@boardsesh/shared-schema';
import { getPublicUrl } from '../storage/s3';
import { logger } from '../utils/logger';

/** Rendered width of each screenshot in the comment, in CSS pixels. */
const SCREENSHOT_WIDTH = 300;

let hasWarnedMissingPublicBase = false;

/**
 * Logged once per process. `getPublicUrl` throws for the same reason on every
 * submit, and a deploy that forgot `MEDIA_PUBLIC_BASE_URL` would otherwise put
 * a line in the log for every verdict and every bug report filed.
 */
function warnMissingPublicBaseOnce(error: unknown): void {
  if (hasWarnedMissingPublicBase) return;
  hasWarnedMissingPublicBase = true;
  logger.warn(
    '[feedback-screenshots] no public URL for the media bucket; screenshots are stored but not linked:',
    error,
  );
}

/**
 * Browser-reachable URLs for the screenshots on one submission.
 *
 * Keys that this system could not have minted are dropped (see
 * `isFeedbackScreenshotKey`), and the list is capped at
 * {@link FEEDBACK_SCREENSHOT_MAX_COUNT} — the zod schemas enforce the same cap
 * on the way in, but a row written before that cap existed, or by a future
 * writer, must not widen the comment either.
 *
 * Returns `[]` rather than throwing when the media bucket has no public base
 * URL: losing the verdict over a missing environment variable would be a far
 * worse failure than a comment with no pictures in it.
 */
export function screenshotPublicUrls(keys: readonly string[] | null | undefined): string[] {
  if (!keys || keys.length === 0) return [];

  const minted = keys.filter((key) => isFeedbackScreenshotKey(key)).slice(0, FEEDBACK_SCREENSHOT_MAX_COUNT);
  if (minted.length === 0) return [];

  try {
    return minted.map((key) => getPublicUrl('media', key));
  } catch (error) {
    warnMissingPublicBaseOnce(error);
    return [];
  }
}

/**
 * The `## Screenshots` block for a PR comment or an issue body, as lines to
 * splice into the surrounding builder. Empty when there is nothing to show, so
 * a submission with no screenshots renders no heading.
 *
 * `<img width>` rather than `![](…)`: a phone screenshot is around 2796px tall,
 * and GitHub renders a bare image at full width — one report would dominate the
 * whole PR timeline. GitHub allows the tag and proxies the src through camo.
 *
 * No escaping: every URL here came out of `getPublicUrl` for a key that matched
 * our own minted pattern, so there is no user-controlled text in the string.
 */
export function screenshotMarkdownSection(urls: readonly string[]): string[] {
  if (urls.length === 0) return [];
  return ['', '## Screenshots', '', ...urls.map((url) => `<img src="${url}" width="${SCREENSHOT_WIDTH}">`)];
}

/** Test-only: re-arm the one-shot missing-public-base warning. */
export function resetScreenshotUrlWarning(): void {
  hasWarnedMissingPublicBase = false;
}
