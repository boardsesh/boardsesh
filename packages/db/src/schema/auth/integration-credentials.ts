import { pgTable, bigserial, text, timestamp, boolean, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users';

// Per-user credentials for external platform integrations (Strava today;
// Garmin, Health Connect, … later). One row per (user, provider). Token
// columns are encrypted with @boardsesh/crypto and nullable so device-local
// providers that only need a server-side flag can reuse the table.
export const integrationCredentials = pgTable(
  'integration_credentials',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(), // 'strava' | future providers
    encryptedAccessToken: text('encrypted_access_token'),
    encryptedRefreshToken: text('encrypted_refresh_token'),
    tokenExpiresAt: timestamp('token_expires_at'),
    externalAccountId: text('external_account_id'),
    externalAccountName: text('external_account_name'),
    scopes: text('scopes'),
    autoSyncEnabled: boolean('auto_sync_enabled').default(true).notNull(),
    status: text('status').default('active').notNull(), // 'active' | 'expired' | 'error' | 'revoked'
    lastError: text('last_error'),
    lastSyncAt: timestamp('last_sync_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    // Also serves single-column user_id lookups via its leading column — no
    // separate user index needed.
    uniqueUserProvider: uniqueIndex('unique_user_integration').on(table.userId, table.provider),
  }),
);
