import type {
  ConnectionContext,
  ProjectNewsEmailConsent,
  SetProjectNewsEmailConsentInput,
} from '@boardsesh/shared-schema';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import { SetProjectNewsEmailConsentInputSchema } from '../../../validation/schemas';
import { readProjectNewsEmailConsent, setProjectNewsEmailConsent } from '../../../services/project-news-email';

/**
 * A climber flips this switch a few times at most. A handful a minute is
 * already generous, and the table only grows when the answer changes.
 */
const SET_PROJECT_NEWS_EMAIL_CONSENT_RATE_LIMIT = 20;

export const projectNewsEmailQueries = {
  myProjectNewsEmailConsent: async (
    _: unknown,
    _args: unknown,
    ctx: ConnectionContext,
  ): Promise<ProjectNewsEmailConsent> => {
    requireAuthenticated(ctx);
    return readProjectNewsEmailConsent(ctx.userId!);
  },
};

export const projectNewsEmailMutations = {
  setProjectNewsEmailConsent: async (
    _: unknown,
    { input }: { input: SetProjectNewsEmailConsentInput },
    ctx: ConnectionContext,
  ): Promise<ProjectNewsEmailConsent> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, SET_PROJECT_NEWS_EMAIL_CONSENT_RATE_LIMIT, 'setProjectNewsEmailConsent');
    const validatedInput = validateInput(SetProjectNewsEmailConsentInputSchema, input, 'input');
    const { consent } = await setProjectNewsEmailConsent(ctx.userId!, validatedInput.subscribed, validatedInput.source);
    return consent;
  },
};
