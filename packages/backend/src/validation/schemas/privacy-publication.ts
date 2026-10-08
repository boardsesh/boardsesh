import { z } from 'zod';

export const PrivacyPublicationInputSchema = z.object({
  audience: z.enum(['public', 'followers', 'only_me']),
  privacyRevision: z.number().int().nonnegative(),
});
