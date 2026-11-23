import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { refreshSetterSitemapSummary } from '../../../services/setter-sitemap-summary';
import { logger } from '../../../utils/logger';

export const setterSitemapMutations = {
  refreshSetterSitemapSummary: async (
    _: unknown,
    { force = false }: { force?: boolean | null },
    context: ConnectionContext,
  ) => {
    if (context.transport !== 'http' || !context.isCronAuthenticated) {
      throw new GraphQLError('Cron authentication required', {
        extensions: { code: 'UNAUTHENTICATED', http: { status: 401 } },
      });
    }

    try {
      const result = await refreshSetterSitemapSummary({ force: force === true });
      logger.info('Setters sitemap summary refresh finished', result);
      return result;
    } catch (error) {
      logger.error('Setters sitemap summary refresh failed', error);
      throw new GraphQLError('Setters sitemap summary refresh failed', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', http: { status: 500 } },
      });
    }
  },
};
