import { eq } from 'drizzle-orm';
import type { ConnectionContext, IntegrationStatus } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import { integrationCredentials } from '@boardsesh/db/schema';
import { requireAuthenticated } from '../shared/helpers';
import { SUPPORTED_PROVIDERS, providerDbToEnum } from '../../../integrations/registry';

export const integrationQueries = {
  /**
   * One IntegrationStatus per supported provider for the authenticated user.
   * Providers with no credential row report connected=false, autoSyncEnabled
   * defaulting to true (the value applied on first connect), and a null status.
   */
  integrations: async (_: unknown, __: unknown, ctx: ConnectionContext): Promise<IntegrationStatus[]> => {
    requireAuthenticated(ctx);
    const userId = ctx.userId!;

    const rows = await db.select().from(integrationCredentials).where(eq(integrationCredentials.userId, userId));

    const rowsByProvider = new Map(rows.map((row) => [row.provider, row]));

    return SUPPORTED_PROVIDERS.map((providerName) => {
      const row = rowsByProvider.get(providerName);
      if (!row) {
        return {
          provider: providerDbToEnum(providerName),
          connected: false,
          externalAccountName: null,
          autoSyncEnabled: true,
          status: null,
          lastSyncAt: null,
          lastError: null,
        };
      }
      return {
        provider: providerDbToEnum(providerName),
        connected: true,
        externalAccountName: row.externalAccountName,
        autoSyncEnabled: row.autoSyncEnabled,
        status: row.status as IntegrationStatus['status'],
        lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
        lastError: row.lastError,
      };
    });
  },
};
