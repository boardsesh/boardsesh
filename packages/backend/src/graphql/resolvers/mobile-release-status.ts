import type { ConnectionContext } from '@boardsesh/shared-schema';
import { MobileReleaseStatusInputSchema } from '../../validation/schemas/release-context';
import { enrichReleaseContext } from '../../services/mobile-release-status';
import { applyRateLimit, validateInput } from './shared/helpers';

export const mobileReleaseStatusQueries = {
  mobileReleaseStatus: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    await applyRateLimit(ctx, 30, 'mobileReleaseStatus');
    const validated = validateInput(MobileReleaseStatusInputSchema, input, 'input');
    return enrichReleaseContext(validated, validated.platform);
  },
};
