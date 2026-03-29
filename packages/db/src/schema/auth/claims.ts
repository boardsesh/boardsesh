import {
  pgTable,
  bigserial,
  text,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Aurora username claims: maps a Boardsesh user to their Aurora (Kilter/Tension) username.
 *
 * When a user imports their Aurora JSON export, we store the username from
 * the export so we can show climbs they set as "their climbs" in the UI.
 *
 * Design decisions:
 * - One claim per user per board type (unique constraint on userId + boardType)
 * - Multiple users CAN claim the same aurora username (no unique on auroraUsername)
 *   because we have no way to verify ownership and users may create new accounts
 * - The climb's setterUsername field remains the historical source of truth
 * - This table only enables the UI to highlight "your climbs"
 */
export const auroraUsernameClaims = pgTable(
  'aurora_username_claims',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    boardType: text('board_type').notNull(), // 'kilter', 'tension'
    auroraUsername: text('aurora_username').notNull(),
    claimedAt: timestamp('claimed_at').defaultNow().notNull(),
  },
  (table) => ({
    // One claim per user per board type
    uniqueUserBoardClaim: uniqueIndex('unique_user_board_claim').on(
      table.userId,
      table.boardType,
    ),
    // Fast lookup: "which users claim this aurora username on this board?"
    lookupIdx: index('aurora_username_claims_lookup_idx').on(
      table.boardType,
      table.auroraUsername,
    ),
  }),
);
