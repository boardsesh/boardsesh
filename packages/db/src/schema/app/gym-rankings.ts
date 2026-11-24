import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { boardseshTicks } from './ascents';
import { comments } from './social';

export const gymReportingTickVotes = pgTable(
  'gym_reporting_tick_votes',
  {
    tickId: bigint('tick_id', { mode: 'bigint' })
      .notNull()
      .references(() => boardseshTicks.id, { onDelete: 'cascade' }),
    metric: text('metric').$type<'QUALITY' | 'DIFFICULTY'>().notNull(),
    attestedValue: integer('attested_value').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tickId, table.metric] }),
    check(
      'gym_reporting_tick_votes_value_check',
      sql`
      (${table.metric} = 'QUALITY' AND ${table.attestedValue} BETWEEN 1 AND 5)
      OR (${table.metric} = 'DIFFICULTY' AND ${table.attestedValue} BETWEEN 0 AND 100)
    `,
    ),
  ],
);

export const gymClimbCommentAttributions = pgTable(
  'gym_climb_comment_attributions',
  {
    commentId: bigint('comment_id', { mode: 'number' })
      .primaryKey()
      .references(() => comments.id, { onDelete: 'cascade' }),
    logicalBoardId: bigint('logical_board_id', { mode: 'number' }).notNull(),
    boardUuid: text('board_uuid').notNull(),
    gymId: bigint('gym_id', { mode: 'number' }).notNull(),
    boardType: text('board_type').notNull(),
    climbUuid: text('climb_uuid').notNull(),
    angle: integer('angle').notNull(),
    isMirror: boolean('is_mirror').notNull(),
    commentCreatedAt: timestamp('comment_created_at', { mode: 'string' }).notNull(),
  },
  (table) => [
    index('gym_climb_comment_attribution_board_time_idx').on(
      table.logicalBoardId,
      table.commentCreatedAt,
      table.commentId,
    ),
  ],
);
