import { pgTable, text, integer, timestamp, bigserial, index, jsonb, boolean, pgEnum } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';

export type FeedbackContext = {
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
    // Whether the reporter opted in to follow-up contact. Only set for bug
    // reports; null/false means "do not reach out". Resolve the reporter via
    // this row's user_id when true.
    contactConsent: boolean('contact_consent'),
    context: jsonb('context').$type<FeedbackContext>(),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
    // Admin triage state. New rows start 'new'; an admin moves them through the
    // dashboard. `resolvedAt`/`resolvedBy` are stamped when moved to a terminal
    // state (resolved/wont_fix) and cleared when reopened.
    status: appFeedbackStatusEnum('status').notNull().default('new'),
    resolvedAt: timestamp('resolved_at', { mode: 'string' }),
    resolvedBy: text('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    // The GitHub issue auto-opened for bug reports, persisted after creation so
    // the admin dashboard can link straight to it. Null for ratings and for
    // rows created before this was captured (or when GitHub sync is unconfigured).
    // Object keys in the public `media` bucket for the screenshots the reporter
    // attached, in attachment order. Bug reports only. The keys are the record;
    // the public URLs embedded in the GitHub issue are derived at creation time.
    screenshotKeys: jsonb('screenshot_keys').$type<string[]>(),
    githubIssueNumber: integer('github_issue_number'),
    githubIssueUrl: text('github_issue_url'),
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
