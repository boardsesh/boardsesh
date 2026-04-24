import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { applyRateLimit, validateInput } from '../shared/helpers';
import { SubmitAppFeedbackInputSchema } from '../../../validation/schemas';
import { postFeedbackToDiscord } from '../../../services/discord';

export const feedbackMutations = {
  submitAppFeedback: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    // 10 submissions per 60-second window (see applyRateLimit default window).
    await applyRateLimit(ctx, 10, 'submitAppFeedback');

    const validated = validateInput(SubmitAppFeedbackInputSchema, input, 'input');
    const comment = validated.comment?.trim() ? validated.comment.trim() : null;
    const appVersion = validated.appVersion ?? null;
    const rating = validated.rating ?? null;

    const rows = await db
      .insert(dbSchema.appFeedback)
      .values({
        userId: ctx.userId ?? null,
        rating,
        comment,
        platform: validated.platform,
        appVersion,
        source: validated.source,
      })
      .returning();
    const row = rows[0];

    // Fire-and-forget. postFeedbackToDiscord swallows all errors internally.
    // Guard on row existence — an insert that doesn't return a row means
    // something's wrong at the DB layer (not our contract), so skip the
    // side-effect rather than crash the mutation.
    if (row) {
      void postFeedbackToDiscord({
        feedbackId: row.id,
        rating,
        comment,
        platform: validated.platform,
        appVersion,
        source: validated.source,
      });
    }

    return true;
  },
};
