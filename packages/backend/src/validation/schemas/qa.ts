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
// A tester loads a handful of previews at a time; the cap is an abuse bound on
// how many PRs one call can ask GitHub about.
const MAX_PREVIEW_PR_NUMBERS = 50;
// A decline is a request for work. It has to say what broke.
const DECLINE_COMMENT_MIN = 10;

export const QaPreviewsArgsSchema = z.object({
  prNumbers: z
    .array(z.number().int().positive())
    .min(1)
    .max(MAX_PREVIEW_PR_NUMBERS)
    // Duplicates would fan out into duplicate previews for one PR; collapse
    // them rather than reject a client that de-duped badly.
    .transform((prNumbers) => [...new Set(prNumbers)]),
});

export const SubmitQaVerdictInputSchema = z
  .object({
    prNumber: z.number().int().positive(),
    branch: z.string().trim().min(1).max(64),
    verdict: z.enum(['approved', 'declined']),
    comment: z.string().trim().max(COMMENT_MAX).optional().nullable(),
    platform: z.enum(['ios', 'android', 'web']),
    appVersion: z.string().trim().max(64).optional().nullable(),
    updateId: z.string().trim().max(64).optional().nullable(),
    runtimeVersion: z.string().trim().max(128).optional().nullable(),
    bundleCreatedAt: z.iso.datetime({ offset: true }).optional().nullable(),
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
