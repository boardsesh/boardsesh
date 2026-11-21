import {
  pgTable,
  text,
  integer,
  timestamp,
  bigserial,
  index,
  jsonb,
  boolean,
  pgEnum,
  bigint,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from '../auth/users';
import type { ReleaseContext } from '@boardsesh/shared-schema';

export type FeedbackContext = {
  releaseContext?: ReleaseContext;
  climbUuid?: string;
  climbName?: string;
  difficulty?: string;
  sessionId?: string;
  sessionName?: string;
  url?: string;
  userAgent?: string;
};

/**
 * Triage state for a feedback row, driven from the admin feedback dashboard.
 * `new` is the untouched default; `resolved`/`wont_fix` are the terminal
 * ("done") states that stamp `resolved_at` + `resolved_by`.
 */
export const appFeedbackStatusEnum = pgEnum('app_feedback_status', ['new', 'in_progress', 'resolved', 'wont_fix']);

export const appFeedback = pgTable(
  'app_feedback',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    rating: integer('rating'),
    comment: text('comment'),
    platform: text('platform').notNull(),
    appVersion: text('app_version'),
    source: text('source').notNull(),
    boardName: text('board_name'),
    layoutId: integer('layout_id'),
    sizeId: integer('size_id'),
    setIds: jsonb('set_ids').$type<number[]>(),
    angle: integer('angle'),
    // Email follow-up consent. Private in-app support is available regardless.
    contactConsent: boolean('contact_consent'),
    context: jsonb('context').$type<FeedbackContext>(),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
    // Admin triage state. New rows start 'new'; an admin moves them through the
    // dashboard. `resolvedAt`/`resolvedBy` are stamped when moved to a terminal
    // state (resolved/wont_fix) and cleared when reopened.
    status: appFeedbackStatusEnum('status').notNull().default('new'),
    resolvedAt: timestamp('resolved_at', { mode: 'string' }),
    resolvedBy: text('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    // Object keys in the public `media` bucket for the screenshots the reporter
    // attached, in attachment order. Bug reports only. The keys are the record;
    // the public URLs embedded in the GitHub issue are derived at creation time.
    screenshotKeys: jsonb('screenshot_keys').$type<string[]>(),
    // The GitHub issue auto-opened for bug reports, persisted after creation so
    // the admin dashboard can link straight to it. Null for ratings and for
    // rows created before this was captured (or when GitHub sync is unconfigured).
    githubIssueNumber: integer('github_issue_number'),
    githubIssueUrl: text('github_issue_url'),
    githubIssueState: text('github_issue_state').$type<'open' | 'closed'>(),
    githubIssueStateReason: text('github_issue_state_reason'),
    lastMessageAt: timestamp('last_message_at', { mode: 'string' }),
    lastMessagePreview: text('last_message_preview'),
    needsReply: boolean('needs_reply').notNull().default(false),
  },
  (table) => ({
    createdAtIdx: index('app_feedback_created_at_idx').on(table.createdAt),
    userIdx: index('app_feedback_user_idx').on(table.userId),
    boardIdx: index('app_feedback_board_idx').on(table.boardName),
    statusIdx: index('app_feedback_status_idx').on(table.status),
  }),
);

export type AppFeedback = typeof appFeedback.$inferSelect;
export type NewAppFeedback = typeof appFeedback.$inferInsert;

/** Filtered GitHub conversation cache plus durable outbox for reporter replies. */
export const appFeedbackMessages = pgTable(
  'app_feedback_messages',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    reportId: bigint('report_id', { mode: 'bigint' })
      .notNull()
      .references(() => appFeedback.id, { onDelete: 'cascade' }),
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    authorRole: text('author_role').$type<'reporter' | 'staff'>().notNull(),
    body: text('body').notNull(),
    submittedBodyHash: text('submitted_body_hash'),
    clientMutationId: text('client_mutation_id').notNull(),
    notificationUuid: text('notification_uuid').notNull().unique(),
    githubCommentId: text('github_comment_id').unique(),
    withdrawnAt: timestamp('withdrawn_at', { mode: 'string' }),
    deliveryStatus: text('delivery_status').$type<'pending' | 'sent' | 'failed'>().notNull().default('pending'),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => ({
    reportIdx: index('app_feedback_messages_report_idx').on(table.reportId, table.id),
    mutationIdx: uniqueIndex('app_feedback_messages_mutation_idx').on(table.authorId, table.clientMutationId),
  }),
);
