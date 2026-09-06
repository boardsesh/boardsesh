import {
  FEEDBACK_SCREENSHOT_KEY_PATTERN,
  FEEDBACK_SCREENSHOT_MAX_COUNT,
  QA_PREVIEWS_MAX_PR_NUMBERS,
} from '@boardsesh/shared-schema';
import { z } from 'zod';

/**
 * Crowdsourced QA input bounds (docs/crowdsourced-qa.md).
 *
 * Unlike app feedback — where a malformed enrichment field must never cost us
 * the report — a verdict is an authored judgement on a specific PR, so every
 * field here hard-rejects. A verdict filed against the wrong branch, or a
 * decline with no reason, is worse than no verdict at all.
 */

const COMMENT_MAX = 2000;
// A decline is a request for work. It has to say what broke.
const DECLINE_COMMENT_MIN = 10;

export const QaPreviewsArgsSchema = z.object({
  prNumbers: z
    .array(z.number().int().positive())
    // No minimum: an app that can't load any preview yet asks with `[]` and
    // gets `[]` back. Rejecting that would put a failure banner on an empty
    // screen — and the mobile client is written against the frozen SDL, which
    // says nothing about a minimum.
    // An abuse bound on how many PRs one call can ask GitHub about, not a
    // guess at how many a tester browses: the pick screen asks about every
    // `pr-<n>` branch published for its runtime version, and a repo with a
    // hundred open PRs has a hundred of them. Sized to the open-PR list this
    // resolver answers from (see QA_PREVIEWS_MAX_PR_NUMBERS); the marginal cost
    // per extra number is a per-SHA commit-date lookup, which is cached and
    // fetched a few at a time.
    .max(QA_PREVIEWS_MAX_PR_NUMBERS)
    // Duplicates would fan out into duplicate previews for one PR; collapse
    // them rather than reject a client that de-duped badly.
    .transform((prNumbers) => [...new Set(prNumbers)]),
  // Opt-in, so an older client keeps the exact list it asked for. The PRs this
  // adds come from our own deployment read, not the caller, so the
  // MAX_PREVIEW_PR_NUMBERS cap does not apply to them — the deployment page
  // size bounds it instead.
  includeBuilding: z.boolean().optional().default(false),
});

export const SubmitQaVerdictInputSchema = z
  .object({
    prNumber: z.number().int().positive(),
    branch: z.string().trim().min(1).max(64),
    verdict: z.enum(['approved', 'declined']),
    comment: z.string().trim().max(COMMENT_MAX).optional().nullable(),
    platform: z.enum(['ios', 'android', 'web']),
    // Device context is a nicety on a public comment, not a judgement, so it is
    // capped rather than pattern-matched — `Device.modelName` is whatever the
    // OS hands back, and a future handset must not fail a verdict.
    deviceModel: z.string().trim().max(64).optional().nullable(),
    osVersion: z.string().trim().max(32).optional().nullable(),
    appVersion: z.string().trim().max(64).optional().nullable(),
    updateId: z.string().trim().max(64).optional().nullable(),
    runtimeVersion: z.string().trim().max(128).optional().nullable(),
    bundleCreatedAt: z.iso.datetime({ offset: true }).optional().nullable(),
    // Keys the app got back from POST /api/feedback-screenshots. Pattern-matched
    // rather than taken as free strings: they end up as `<img src>` in a comment
    // on a PUBLIC repo, so a key we did not mint must never get that far. The
    // schema is `.strict()`, so this declaration is also what keeps a client that
    // starts sending the field from 400ing on every verdict.
    screenshotKeys: z
      .array(z.string().regex(FEEDBACK_SCREENSHOT_KEY_PATTERN))
      .max(FEEDBACK_SCREENSHOT_MAX_COUNT)
      .optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    // The branch is what the tester actually ran. If it disagrees with the PR
    // number, one of the two is wrong and we can't tell which — reject.
    if (input.branch !== `pr-${input.prNumber}`) {
      ctx.addIssue({
        code: 'custom',
        message: `branch must be pr-${input.prNumber}`,
        path: ['branch'],
      });
    }
    if (input.verdict === 'declined' && (input.comment?.trim().length ?? 0) < DECLINE_COMMENT_MIN) {
      ctx.addIssue({
        code: 'custom',
        message: `comment of at least ${DECLINE_COMMENT_MIN} characters is required to decline`,
        path: ['comment'],
      });
    }
  });

export type QaPreviewsArgs = z.infer<typeof QaPreviewsArgsSchema>;
export type SubmitQaVerdictValidatedInput = z.infer<typeof SubmitQaVerdictInputSchema>;
