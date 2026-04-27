import {
  boolean,
  pgTable,
  bigserial,
  bigint,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
  check,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '../auth/users';

export const socialEntityTypeEnum = pgEnum('social_entity_type', [
  'playlist_climb',
  'climb',
  'tick',
  'comment',
  'proposal',
  'board',
  'gym',
  'session',
]);

export const comments = pgTable(
  'comments',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    uuid: text('uuid').notNull().unique(),
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    entityType: socialEntityTypeEnum('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    parentCommentId: bigint('parent_comment_id', { mode: 'number' }),
    body: text('body').notNull(),
    isPublic: boolean('is_public').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => ({
    entityCreatedAtIdx: index('comments_entity_created_at_idx').on(
      table.entityType,
      table.entityId,
      table.createdAt
    ),
    userCreatedAtIdx: index('comments_user_created_at_idx').on(
      table.userId,
      table.createdAt
    ),
    parentCommentIdx: index('comments_parent_comment_idx').on(
      table.parentCommentId
    ),
  })
);

export const votes = pgTable(
  'votes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    entityType: socialEntityTypeEnum('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    value: integer('value').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    uniqueVote: uniqueIndex('votes_unique_user_entity').on(
      table.userId,
      table.entityType,
      table.entityId
    ),
    entityIdx: index('votes_entity_idx').on(table.entityType, table.entityId),
    userIdx: index('votes_user_idx').on(table.userId),
    valueCheck: check('vote_value_check', sql`${table.value} IN (1, -1)`),
  })
);

export type Comment = typeof comments.$inferSelect;
export type NewComment = typeof comments.$inferInsert;
export type Vote = typeof votes.$inferSelect;
export type NewVote = typeof votes.$inferInsert;
export type SocialEntityType =
  | 'playlist_climb'
  | 'climb'
  | 'tick'
  | 'comment'
  | 'proposal'
  | 'board'
  | 'gym'
  | 'session';
