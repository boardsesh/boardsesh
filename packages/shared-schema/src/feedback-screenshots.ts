/**
 * Screenshots attached to a QA verdict or a bug report.
 *
 * Both features hand the same opaque object keys to the backend, which turns
 * them into `<img>` tags in a PR comment (`services/github-qa.ts`) or a GitHub
 * issue body (`services/github-feedback.ts`). The constants live here because
 * the cap is enforced in three places that must agree: the picker hides its
 * "add" tile at the cap, the upload handler rejects an oversized file, and the
 * resolver's zod schema rejects an over-long key list.
 */

/** Screenshots one submission may carry. */
export const FEEDBACK_SCREENSHOT_MAX_COUNT = 4;

/** Busboy's hard cap per uploaded file. The client compresses well under it. */
export const FEEDBACK_SCREENSHOT_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Object-key prefix in the public `media` bucket, and the local-dev dir name. */
export const FEEDBACK_SCREENSHOT_PREFIX = 'feedback-screenshots';

/** Extensions the upload handler stores under, one per allowed mime type. */
export const FEEDBACK_SCREENSHOT_EXTENSIONS = ['jpg', 'png', 'gif', 'webp'] as const;

/**
 * The shape of a key this system minted: our prefix, a v4-style uuid, one of
 * our extensions. Clients send keys back as opaque strings, so this is the
 * trust boundary — the backend builds a public URL only from a key that matches,
 * which keeps an arbitrary attacker-supplied string out of a world-readable
 * GitHub comment.
 */
export const FEEDBACK_SCREENSHOT_KEY_PATTERN =
  /^feedback-screenshots\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|gif|webp)$/;

/** True when `key` could have been minted by the screenshot upload handler. */
export function isFeedbackScreenshotKey(key: string): boolean {
  return FEEDBACK_SCREENSHOT_KEY_PATTERN.test(key);
}
