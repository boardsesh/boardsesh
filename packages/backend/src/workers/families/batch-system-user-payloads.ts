import { z } from 'zod';

/** Pure schemas shared by worker dispatch and the backend's locked-family validation. */
export const refreshRecommendationsPayload = z.object({}).strict();

export const refreshHoldFeaturesPayload = z
  .object({
    board: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,31}$/)
      .default('kilter'),
    dryRun: z.boolean().optional(),
    shadow: z.boolean().optional(),
  })
  .strict();
