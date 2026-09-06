import { pgTable, bigserial, bigint, text, timestamp, index, pgEnum } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';
import { socialEntityTypeEnum, comments } from './social';

export const notificationTypeEnum = pgEnum('notification_type', [
  'new_follower',
  'comment_reply',
  'comment_on_tick',
  'comment_on_climb',
  'vote_on_tick',
  'vote_on_comment',
  'new_climb',
  'new_climb_global',
  'proposal_approved',
  'proposal_rejected',
  'proposal_vote',
  'proposal_created',
  'new_climbs_synced',
  'gym_claim_approved',
  'proposal_on_your_climb',
]);

export const notifications = pgTable(
  'notifications',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    uuid: text('uuid').notNull().unique(),
    recipientId: text('recipient_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    actorId: text('actor_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    type: notificationTypeEnum('type').notNull(),
    entityType: socialEntityTypeEnum('entity_type'),
    entityId: text('entity_id'),
    commentId: bigint('comment_id', { mode: 'number' }).references(() => comments.id, {
      onDelete: 'set null',
    }),
    readAt: timestamp('read_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    recipientUnreadIdx: index('notifications_recipient_unread_idx').on(
      table.recipientId,
      table.readAt,
      table.createdAt,
    ),
    recipientCreatedAtIdx: index('notifications_recipient_created_at_idx').on(table.recipientId, table.createdAt),
    deduplicationIdx: index('notifications_dedup_idx').on(table.actorId, table.recipientId, table.type, table.entityId),
    createdAtIdx: index('notifications_created_at_idx').on(table.createdAt),
  }),
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type NotificationType =
  | 'new_follower'
  | 'comment_reply'
  | 'comment_on_tick'
  | 'comment_on_climb'
  | 'vote_on_tick'
  | 'vote_on_comment'
  | 'new_climb'
  | 'new_climb_global'
  | 'proposal_approved'
  | 'proposal_rejected'
  | 'proposal_vote'
  | 'proposal_created'
  | 'new_climbs_synced'
  | 'gym_claim_approved'
  | 'proposal_on_your_climb';
