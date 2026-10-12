import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '../auth/users';
import { userBoards } from './boards';

/**
 * A home board's share link (`/b/{slug}?invite={token}`).
 *
 * A signed-in climber who opens it and chooses Join becomes an approved member
 * of a Followers or Invite-only board, the same `resource_grants` row an
 * owner's name invite writes. Opening it alone grants nothing. The token is 128 random bits in base64url, minted server-side only.
 * A board has at most one active link; "Reset link" stamps `revoked_at` on it
 * and mints a new one, so a forwarded old link stops working while the people
 * who already joined keep their access.
 */
export const boardShareLinks = pgTable(
  'board_share_links',
  {
    token: text('token').primaryKey(),
    boardUuid: text('board_uuid')
      .notNull()
      .references(() => userBoards.uuid, { onDelete: 'cascade' }),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    revokedAt: timestamp('revoked_at'),
  },
  (table) => [
    // One active link per board, and the lookup the share sheet makes.
    uniqueIndex('board_share_links_active_board_idx')
      .on(table.boardUuid)
      .where(sql`${table.revokedAt} IS NULL`),
    index('board_share_links_board_idx').on(table.boardUuid),
  ],
);
