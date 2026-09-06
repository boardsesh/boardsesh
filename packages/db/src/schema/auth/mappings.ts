import { pgTable, bigserial, text, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

// Links a NextAuth user to a board account. board_user_id holds the Aurora
// numeric ID; board_user_id_text holds a string identity (e.g. Keycloak sub
// UUID for Kilter accounts). Exactly one is populated per row.
export const userBoardMappings = pgTable(
  'user_board_mappings',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    boardType: text('board_type').notNull(),
    boardUserId: integer('board_user_id'),
    boardUserIdText: text('board_user_id_text'),
    boardUsername: text('board_username'),
    linkedAt: timestamp('linked_at').defaultNow().notNull(),
  },
  (table) => ({
    uniqueUserBoard: uniqueIndex('unique_user_board_mapping').on(table.userId, table.boardType),
    boardUserIdx: index('board_user_mapping_idx').on(table.boardType, table.boardUserId),
    boardUserTextIdx: index('board_user_mapping_text_idx').on(table.boardType, table.boardUserIdText),
    // The setters sitemap resolves a setter's rendered identity by
    // `board_username`, once per eligible setter (~31k per refresh) inside the
    // summary scan already closest to `SHARD_DEADLINE_MS`. None of the indexes
    // above leads with this column, so that lateral was a sequential scan each
    // time (#5206).
    boardUsernameIdx: index('board_user_mapping_username_idx').on(table.boardUsername),
  }),
);

// Encrypted credentials for board accounts. Aurora-flavoured boards
// (Tension, originally Kilter) populate encrypted_username/password. Kilter
// (Keycloak OIDC) populates encrypted_refresh_token instead — the other two
// are nullable to accommodate that.
export const auroraCredentials = pgTable(
  'aurora_credentials',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    boardType: text('board_type').notNull(),
    encryptedUsername: text('encrypted_username'),
    encryptedPassword: text('encrypted_password'),
    encryptedRefreshToken: text('encrypted_refresh_token'),
    auroraUserId: integer('aurora_user_id'),
    auroraToken: text('aurora_token'),
    // last_sync_at = last SUCCESSFUL sync (surfaced to users as the card's
    // "Last synced" time). Stamped on success only — never on a failed
    // cycle, or the UI would show "connected, just synced" for a cycle that
    // failed before applying data.
    lastSyncAt: timestamp('last_sync_at'),
    // last_sync_attempt_at = last time the daemon ATTEMPTED this credential,
    // success OR failure. This is the scheduler's fairness clock
    // (getNextCredentialToSync orders by it), kept separate from last_sync_at
    // so a deterministically-failing credential rotates to the back of the
    // queue without masquerading as a fresh successful sync. Not user-facing.
    lastSyncAttemptAt: timestamp('last_sync_attempt_at'),
    syncStatus: text('sync_status').default('pending').notNull(), // 'pending' | 'active' | 'error' | 'expired'
    syncError: text('sync_error'),
    credentialFailureCount: integer('credential_failure_count').default(0).notNull(),
    lastCredentialFailureAt: timestamp('last_credential_failure_at'),
    // consecutive_failures = count of consecutive FAILED sync cycles from ANY
    // cause (transient network, permanent auth, or an unknown throw), reset to
    // 0 on the next success. Distinct from credential_failure_count, which
    // counts only invalid-username/password login failures and expires a
    // credential after 2 — folding network blips into that would wrongly expire
    // a credential after 2 transient failures. This counter instead drives the
    // per-credential exponential backoff in both sync runners: a credential is
    // skipped from selection until last_sync_attempt_at + backoff(n) has
    // elapsed, so a deterministically-failing credential can't burn a daemon
    // cycle every rotation (and can't wedge the single-user-per-cycle queue).
    consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
    // last_sync_error = the most recent failure's message, recorded on EVERY
    // failed cycle — including transient ones that deliberately leave the
    // user-facing sync_status/sync_error untouched (so the card doesn't flip to
    // 'error' on a retryable blip). Observability only: this is how an operator
    // sees WHY a credential keeps failing while the card still reads 'active'.
    // Cleared to NULL on the next success.
    lastSyncError: text('last_sync_error'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    uniqueUserBoardCredential: uniqueIndex('unique_user_board_credential').on(table.userId, table.boardType),
    userCredentialsIdx: index('aurora_credentials_user_idx').on(table.userId),
    // Partial index for the sync-runner's getNextCredentialToSync hot path.
    // Without it the daemon seq-scans + sorts auroraCredentials every cycle;
    // fine at 1k users, painful at 100k. Predicate matches the WHERE clause
    // in kilter-sync's runner so the optimizer can use the index directly.
    syncPriorityIdx: index('aurora_credentials_sync_priority_idx')
      .on(table.boardType, table.syncStatus, table.lastSyncAt)
      .where(sql`${table.syncStatus} IN ('pending', 'active', 'error')`),
    // Sibling of syncPriorityIdx for runners that schedule on the attempt
    // clock (kilter-sync orders by last_sync_attempt_at). Same predicate so
    // the optimizer can serve the getNextCredentialToSync ORDER BY directly.
    syncAttemptPriorityIdx: index('aurora_credentials_sync_attempt_priority_idx')
      .on(table.boardType, table.syncStatus, table.lastSyncAttemptAt)
      .where(sql`${table.syncStatus} IN ('pending', 'active', 'error')`),
  }),
);
