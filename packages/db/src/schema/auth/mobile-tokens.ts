import { pgTable, text, timestamp, uniqueIndex, index, integer } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

/**
 * Refresh tokens for mobile (React Native) JWT authentication.
 *
 * The native auth flow issues short-lived JWTs (7 days) alongside long-lived
 * refresh tokens (90 days). When a JWT expires the client presents the refresh
 * token to obtain a new JWT + refresh token pair (rotation).
 *
 * Only the SHA-256 hash of the raw refresh token is stored — the cleartext
 * token is returned to the client exactly once during issuance. Revoking a
 * token sets `revokedAt` rather than deleting the row so we can audit token
 * rotation chains after the fact.
 *
 * The four stamps are written by the issuer under its user lock. A sign-in
 * stamps the generations it read there, the time of the sign-in proof (null
 * when the proof was a transfer token or watch code) and a new session id. A
 * refresh copies its parent's stamps, so a rotation never makes a sign-in
 * newer. Rows from before the stamps keep NULLs; their next child is stamped
 * with generation 0, the value a NULL row stands for, and a new session id.
 */
export const mobileRefreshTokens = pgTable(
  'mobile_refresh_tokens',
  {
    id: text('id')
      .notNull()
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { mode: 'date' }),
    subjectGeneration: integer('subject_generation'),
    nativeGeneration: integer('native_generation'),
    // With time zone, unlike the columns above: it is compared with JWT
    // auth_time and the cutoff timestamps, which are absolute instants.
    authenticatedAt: timestamp('authenticated_at', { withTimezone: true, mode: 'date' }),
    sessionId: text('session_id'),
  },
  (table) => ({
    tokenHashIdx: uniqueIndex('mobile_refresh_tokens_token_hash_idx').on(table.tokenHash),
    userIdIdx: index('mobile_refresh_tokens_user_id_idx').on(table.userId),
    expiresAtIdx: index('mobile_refresh_tokens_expires_at_idx').on(table.expiresAt),
    revokedAtIdx: index('mobile_refresh_tokens_revoked_at_partial_idx')
      .on(table.revokedAt)
      .where(sql`"revoked_at" IS NOT NULL`),
  }),
);
