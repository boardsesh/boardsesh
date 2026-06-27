import { z } from 'zod';

const RATING_SOURCES = ['prompt', 'drawer-feedback'] as const;
const BUG_SOURCES = ['shake-bug', 'drawer-bug'] as const;

const FeedbackContextInputSchema = z
  .object({
    climbUuid: z.string().max(64).optional().nullable(),
    climbName: z.string().max(200).optional().nullable(),
    difficulty: z.string().max(32).optional().nullable(),
    sessionId: z.string().max(64).optional().nullable(),
    sessionName: z.string().max(200).optional().nullable(),
    url: z.string().max(1000).optional().nullable(),
    userAgent: z.string().max(512).optional().nullable(),
    bleDiagnostics: z.string().max(2000).optional().nullable(),
  })
  .strict();

export const SubmitAppFeedbackInputSchema = z
  .object({
    rating: z.number().int().min(1).max(5).optional().nullable(),
    comment: z.string().trim().max(2000).optional().nullable(),
    platform: z.enum(['ios', 'android', 'web']),
    appVersion: z.string().max(64).optional().nullable(),
    source: z.enum([...RATING_SOURCES, ...BUG_SOURCES]),
    boardName: z.string().min(1).max(100).optional().nullable(),
    layoutId: z.number().int().optional().nullable(),
    sizeId: z.number().int().optional().nullable(),
    setIds: z.array(z.number().int()).max(16).optional().nullable(),
    angle: z.number().int().min(0).max(180).optional().nullable(),
    context: FeedbackContextInputSchema.optional().nullable(),
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
