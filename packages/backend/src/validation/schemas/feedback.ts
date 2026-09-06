import { FEEDBACK_SCREENSHOT_KEY_PATTERN, FEEDBACK_SCREENSHOT_MAX_COUNT } from '@boardsesh/shared-schema';
import { z } from 'zod';

const RATING_SOURCES = ['prompt', 'drawer-feedback'] as const;
const BUG_SOURCES = ['shake-bug', 'drawer-bug'] as const;

const COMMENT_MAX = 2000;
// An abuse bound, not a domain bound. Real boards carry a handful of sets; the
// old bound of 16 was sized to the domain and a board that exceeded it cost us
// the whole report (see `bestEffort`).
const SET_IDS_MAX = 64;

/**
 * Diagnostic enrichment is never fatal.
 *
 * The report itself — `source`, `comment`, `platform` — is the payload. The board
 * context wrapped around it (which board, which layout, what angle) is a
 * nice-to-have that helps triage. Rejecting the mutation because one of those
 * optional fields failed validation throws away the thing we actually wanted.
 *
 * That is not hypothetical: `setIds` was capped at 16 entries, and on 2026-08-03 a
 * user on a board with more sets than that hit the cap four times in a row while
 * trying to report a crash (Sentry BOARDSESH-84). Every one of those reports was
 * discarded, and the user got a generic failure.
 *
 * So each enrichment field degrades to `null` instead of failing the parse. Widen
 * the bounds too where they were domain-sized, but the `catch` is the real
 * guarantee: a newer client that sends a field shape this server has never seen
 * still gets its bug report filed.
 */
function bestEffort<T extends z.ZodType>(schema: T) {
  return schema.optional().nullable().catch(null);
}

const FeedbackContextInputSchema = z.object({
  climbUuid: bestEffort(z.string().max(64)),
  climbName: bestEffort(z.string().max(200)),
  difficulty: bestEffort(z.string().max(32)),
  sessionId: bestEffort(z.string().max(64)),
  sessionName: bestEffort(z.string().max(200)),
  url: bestEffort(z.string().max(1000)),
  userAgent: bestEffort(z.string().max(512)),
});
// Deliberately NOT `.strict()`: an unknown key is a newer client talking to an
// older server, and that must not cost the report. Zod strips unknown keys, and
// `normalizeContext` in the resolver only reads keys it knows about.

export const SubmitAppFeedbackInputSchema = z
  .object({
    rating: bestEffort(z.number().int().min(1).max(5)),
    // Clipped, not rejected — an over-long comment is still a bug report, and the
    // `.refine` below reads the clipped value.
    comment: z
      .string()
      .trim()
      .transform((value) => (value.length > COMMENT_MAX ? value.slice(0, COMMENT_MAX) : value))
      .optional()
      .nullable(),
    platform: z.enum(['ios', 'android', 'web']),
    source: z.enum([...RATING_SOURCES, ...BUG_SOURCES]),
    appVersion: bestEffort(z.string().max(64)),
    boardName: bestEffort(z.string().min(1).max(100)),
    layoutId: bestEffort(z.number().int()),
    sizeId: bestEffort(z.number().int()),
    setIds: bestEffort(
      z
        .array(z.number().int())
        .transform((setIds) => (setIds.length > SET_IDS_MAX ? setIds.slice(0, SET_IDS_MAX) : setIds)),
    ),
    angle: bestEffort(z.number().int().min(-5).max(180)),
    context: bestEffort(FeedbackContextInputSchema),
    contactConsent: bestEffort(z.boolean()),
    // Screenshots are an attachment on the report, not the report — so they
    // degrade like every other non-payload field here rather than costing the
    // whole thing. Over-cap is clipped (the `setIds` lesson: a bound that
    // rejects is a bound that eats bug reports), and a key that doesn't match
    // the minted pattern drops the list to null. Nothing unsafe survives either
    // way: `screenshotPublicUrls` re-checks every key before it becomes a URL.
    screenshotKeys: bestEffort(
      z
        .array(z.string().regex(FEEDBACK_SCREENSHOT_KEY_PATTERN))
        .transform((keys) =>
          keys.length > FEEDBACK_SCREENSHOT_MAX_COUNT ? keys.slice(0, FEEDBACK_SCREENSHOT_MAX_COUNT) : keys,
        ),
    ),
  })
  .refine((data) => !(RATING_SOURCES as readonly string[]).includes(data.source) || (data.rating ?? null) !== null, {
    message: 'rating is required for rating-source feedback',
    path: ['rating'],
  })
  .refine(
    (data) => !(BUG_SOURCES as readonly string[]).includes(data.source) || (data.comment?.trim().length ?? 0) >= 10,
    { message: 'comment of at least 10 characters is required for bug reports', path: ['comment'] },
  );

export type SubmitAppFeedbackInput = z.infer<typeof SubmitAppFeedbackInputSchema>;
export type FeedbackContextInput = z.infer<typeof FeedbackContextInputSchema>;

// --- Admin feedback dashboard ---------------------------------------------

const FEEDBACK_STATUSES = ['new', 'in_progress', 'resolved', 'wont_fix'] as const;
const FEEDBACK_TYPE_FILTERS = ['bugs', 'ratings', 'all'] as const;

export const AdminAppFeedbackInputSchema = z
  .object({
    type: z.enum(FEEDBACK_TYPE_FILTERS).optional().nullable(),
    status: z.enum(FEEDBACK_STATUSES).optional().nullable(),
    platform: z.string().trim().max(32).optional().nullable(),
    search: z.string().trim().max(200).optional().nullable(),
    limit: z.number().int().min(1).max(100).optional().nullable(),
    offset: z.number().int().min(0).optional().nullable(),
  })
  .strict();

export const UpdateAppFeedbackStatusInputSchema = z
  .object({
    // GraphQL ID of the app_feedback row (bigserial serialized as a string).
    id: z.string().regex(/^\d+$/, 'id must be a numeric feedback row id').max(20),
    status: z.enum(FEEDBACK_STATUSES),
  })
  .strict();

export type AdminAppFeedbackInput = z.infer<typeof AdminAppFeedbackInputSchema>;
export type UpdateAppFeedbackStatusInput = z.infer<typeof UpdateAppFeedbackStatusInputSchema>;
