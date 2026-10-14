import { z } from 'zod';

// Diagnostics never cost the report when an optional field is malformed.
export const ReleaseContextInputSchema = z.object({
  channel: z.string().trim().min(1).max(128).nullish().catch(null),
  branch: z.string().trim().min(1).max(128).nullish().catch(null),
  updateId: z.string().trim().min(1).max(128).nullish().catch(null),
  runtimeVersion: z.string().trim().min(1).max(128).nullish().catch(null),
  isEmbeddedLaunch: z.boolean().nullish().catch(null),
});

export const OptionalReleaseContextInputSchema = ReleaseContextInputSchema.nullish().catch(null);

export const MobileReleaseStatusInputSchema = ReleaseContextInputSchema.extend({
  platform: z.enum(['ios', 'android', 'web']),
});

export const ProposalReportReleaseContextsArgsSchema = z.object({
  proposalUuid: z.string().trim().min(1).max(128),
});
