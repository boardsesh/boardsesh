import { pgTable, bigserial, bigint, text, timestamp, index, pgEnum } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';
import { socialEntityTypeEnum, comments } from './social';

export const notificationTypeEnum = pgEnum('notification_type', [
  'app_feedback_reply',
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
  'spray_wall_detection_completed',
  'follow_request',
  // Comments on an item, sent to its owner (#6385). `comment_on_tick` and
  // `comment_on_climb` above cover ticks and climbs.
  'comment_on_session',
  'comment_on_playlist',
  'comment_on_board',
  'comment_on_gym',
  // Directory reports and staff actions on boards (docs/product/directory-reports.md).
  // Sent only while the backend's `directory-reports` flag is on.
  'board_report_opened',
  'board_report_resolved',
  'board_removed_from_gym',
  'board_deleted_by_staff',
  'board_edited_by_staff',
  'gym_report_opened',
  'gym_report_resolved',
  // Claim notices; the claim guardrails PR sends them.
  'gym_claimed_with_your_board',
  'gym_claim_denied',
  // A climber's suggested setup changed a board at an unclaimed gym; sent to
  // the board's creator, who can undo it (docs/product/directory-reports.md).
  'board_setup_changed_by_climber',
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
  | 'app_feedback_reply'
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
  | 'proposal_on_your_climb'
  | 'spray_wall_detection_completed'
  | 'follow_request'
  | 'comment_on_session'
  | 'comment_on_playlist'
  | 'comment_on_board'
  | 'comment_on_gym'
  | 'board_report_opened'
  | 'board_report_resolved'
  | 'board_removed_from_gym'
  | 'board_deleted_by_staff'
  | 'board_edited_by_staff'
  | 'gym_report_opened'
  | 'gym_report_resolved'
  | 'gym_claimed_with_your_board'
  | 'gym_claim_denied'
  | 'board_setup_changed_by_climber';
