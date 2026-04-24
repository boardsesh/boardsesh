import { z } from 'zod';

const RATING_SOURCES = ['prompt', 'drawer_feedback'] as const;
const BUG_SOURCES = ['shake_bug', 'drawer_bug'] as const;

export const SubmitAppFeedbackInputSchema = z
  .object({
    rating: z.number().int().min(1).max(5).optional().nullable(),
    comment: z.string().trim().max(2000).optional().nullable(),
    platform: z.enum(['ios', 'android', 'web']),
    appVersion: z.string().max(64).optional().nullable(),
    source: z.enum([...RATING_SOURCES, ...BUG_SOURCES]),
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
