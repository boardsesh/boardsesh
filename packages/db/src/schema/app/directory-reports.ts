import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from '../auth/users';
import { userBoards } from './boards';
import { gyms } from './gyms';
import { notifications } from './notifications';
import {
  boardModerationActorRoleEnum,
  boardModerationEvents,
  type BoardSetupSnapshot,
} from './board-moderation-events';

// The values below are `@boardsesh/directory-moderation`'s lists, written out:
// this package builds to plain JS for drizzle-kit and cannot import a TS-source
// workspace package. A backend test asserts the two agree.

export const directoryReportTargetKindEnum = pgEnum('directory_report_target_kind', ['board', 'gym']);

export const directoryReportReasonEnum = pgEnum('directory_report_reason', [
  // Board reasons
  'wrong_setup',
  'duplicate',
  'gone',
  'wrong_place',
  'other',
  // Board, creator only: put a board staff removed back on their gym.
  'relist_request',
  // Gym reasons (`duplicate` and `other` are shared)
  'closed',
  'wrong_details',
  'not_a_gym',
]);

export const directoryReportStatusEnum = pgEnum('directory_report_status', [
  'open',
  'escalated',
  'fixed',
  'removed',
  'deleted',
  'kept',
  'merged',
]);

export const directoryReportRecipientEnum = pgEnum('directory_report_recipient', ['creator', 'gym_staff', 'admin']);

// `climber`: a climber's suggested setup changed the board and closed its
// "Set up wrong" reports (docs/product/directory-reports.md, "Suggested setup").
export const directoryReportResolverRoleEnum = pgEnum('directory_report_resolver_role', [
  'creator',
  'gym_staff',
  'admin',
  'auto',
  'climber',
]);

/**
 * One problem with one board or gym listing, reported by one or more climbers
 * (docs/product/directory-reports.md).
 *
 * Reports on the same target and reason join one open report, the `reportClimb`
 * pattern: the first reporter opens it, later ones are added to
 * `directory_report_reporters`. The partial unique indexes below hold that: at
 * most one `open` or `escalated` report per (board, reason) and per (gym, reason).
 *
 * `routed_to` is decided once, when the report opens, by `routeBoardReport` /
 * `routeGymReport` in `@boardsesh/directory-moderation`. It is what the reporter
 * was told ("who will see this"), so it does not move when the gym is later
 * claimed. Reads by gym staff follow it.
 *
 * Never deleted by the app. A board's reports go with the board row (an account
 * deletion removes its boards); a gym's with the gym row.
 */
export const directoryReports = pgTable(
  'directory_reports',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    uuid: text('uuid').notNull().unique(),
    targetKind: directoryReportTargetKindEnum('target_kind').notNull(),
    // Exactly one of these two is set, the one `target_kind` names.
    boardId: bigint('board_id', { mode: 'number' }).references(() => userBoards.id, { onDelete: 'cascade' }),
    gymId: bigint('gym_id', { mode: 'number' }).references(() => gyms.id, { onDelete: 'cascade' }),
    // A board report: the gym the board was listed at when the report opened. For
    // `relist_request`, the gym in the latest staff removal. Staff reads key on it,
    // because a removal clears the board's own link.
    gymIdAtReport: bigint('gym_id_at_report', { mode: 'number' }).references(() => gyms.id, { onDelete: 'set null' }),
    reason: directoryReportReasonEnum('reason').notNull(),
    // "Listed twice": the other board or gym, as the first reporter who named one
    // picked it. The board merge tool prefills its target from this.
    duplicateOfBoardId: bigint('duplicate_of_board_id', { mode: 'number' }).references(() => userBoards.id, {
      onDelete: 'set null',
    }),
    duplicateOfGymId: bigint('duplicate_of_gym_id', { mode: 'number' }).references(() => gyms.id, {
      onDelete: 'set null',
    }),
    status: directoryReportStatusEnum('status').default('open').notNull(),
    routedTo: directoryReportRecipientEnum('routed_to').array().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    // The one reminder at seven days. Null until it went out.
    remindedAt: timestamp('reminded_at'),
    // When the report reached the admin queue: at creation for admin-routed
    // reports, otherwise after fourteen days without an outcome.
    escalatedAt: timestamp('escalated_at'),
    resolvedAt: timestamp('resolved_at'),
    resolvedBy: text('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    resolvedByRole: directoryReportResolverRoleEnum('resolved_by_role'),
    // What the person who closed it said. Passed on to the reporters.
    resolutionNote: text('resolution_note'),
  },
  (table) => [
    check(
      'directory_reports_target_check',
      sql`(${table.targetKind} = 'board' AND ${table.boardId} IS NOT NULL AND ${table.gymId} IS NULL)
        OR (${table.targetKind} = 'gym' AND ${table.gymId} IS NOT NULL AND ${table.boardId} IS NULL AND ${table.gymIdAtReport} IS NULL)`,
    ),
    check(
      'directory_reports_resolution_check',
      sql`(${table.status} IN ('open', 'escalated')) = (${table.resolvedAt} IS NULL)`,
    ),
    // One waiting report per target and reason. The predicate is what `reportBoard`
    // and `reportGym` name in their ON CONFLICT target; they move together.
    uniqueIndex('directory_reports_open_board_reason_idx')
      .on(table.boardId, table.reason)
      .where(sql`${table.boardId} IS NOT NULL AND ${table.status} IN ('open', 'escalated')`),
    uniqueIndex('directory_reports_open_gym_reason_idx')
      .on(table.gymId, table.reason)
      .where(sql`${table.gymId} IS NOT NULL AND ${table.status} IN ('open', 'escalated')`),
    // A board's and a gym's reports, open and recently closed.
    index('directory_reports_board_created_idx')
      .on(table.boardId, table.createdAt)
      .where(sql`${table.boardId} IS NOT NULL`),
    index('directory_reports_gym_created_idx')
      .on(table.gymId, table.createdAt)
      .where(sql`${table.gymId} IS NOT NULL`),
    // Staff reads: reports about boards at their gym, which may no longer be linked.
    index('directory_reports_gym_at_report_idx')
      .on(table.gymIdAtReport, table.createdAt)
      .where(sql`${table.gymIdAtReport} IS NOT NULL`),
    // The hourly sweep and the admin queue: everything still waiting, oldest first.
    index('directory_reports_waiting_created_idx')
      .on(table.status, table.createdAt)
      .where(sql`${table.status} IN ('open', 'escalated')`),
    // The daily digest: reports that reached the admin queue since the last one.
    index('directory_reports_escalated_at_idx')
      .on(table.escalatedAt)
      .where(sql`${table.escalatedAt} IS NOT NULL`),
  ],
);

/**
 * Who reported a directory report, and what they said: a note, and on "Set up
 * wrong" the setup they suggest. One row per reporter per report; a second
 * report from the same climber is `already_reported`.
 *
 * Reporters stay anonymous to the creator and to gym staff: only global admins
 * read `reporter_id`. Partial on `reporter_id IS NOT NULL` for the reason
 * `spray_wall_reports` gives: an account deletion nulls the column and leaves
 * the report standing, and several such rows on one report are fine.
 */
export const directoryReportReporters = pgTable(
  'directory_report_reporters',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    reportId: bigint('report_id', { mode: 'number' })
      .notNull()
      .references(() => directoryReports.id, { onDelete: 'cascade' }),
    reporterId: text('reporter_id').references(() => users.id, { onDelete: 'set null' }),
    note: text('note'),
    // "Set up wrong" on a board that isn't a spray wall: the layout, size, sets
    // and (for a board that doesn't tilt) angle this reporter says are right.
    // Shown to the people the report reached; the reporter stays anonymous.
    suggestedSetup: jsonb('suggested_setup').$type<BoardSetupSnapshot>(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('directory_report_reporters_report_reporter_idx')
      .on(table.reportId, table.reporterId)
      .where(sql`${table.reporterId} IS NOT NULL`),
    // "Have I already reported this board?" (`UserBoard.viewerHasOpenReport`).
    index('directory_report_reporters_reporter_idx').on(table.reporterId),
  ],
);

/**
 * What a directory notification is about, beyond the `notifications` row's own
 * entity (the board or gym uuid). The feed reads it to word the row: the
 * report's reason and outcome, whether it was the seven-day reminder, who
 * acted on a board (gym staff or a moderator), and the gym a staff removal took
 * the board off (which the board itself no longer names once it is unlinked).
 *
 * A side table rather than columns on `notifications`, which is large and hot;
 * `app_feedback_messages.notification_uuid` is the same shape.
 */
export const directoryNotificationContext = pgTable(
  'directory_notification_context',
  {
    notificationUuid: text('notification_uuid')
      .primaryKey()
      .references(() => notifications.uuid, { onDelete: 'cascade' }),
    reportId: bigint('report_id', { mode: 'number' }).references(() => directoryReports.id, { onDelete: 'cascade' }),
    boardId: bigint('board_id', { mode: 'number' }).references(() => userBoards.id, { onDelete: 'cascade' }),
    gymId: bigint('gym_id', { mode: 'number' }).references(() => gyms.id, { onDelete: 'set null' }),
    isReminder: boolean('is_reminder').default(false).notNull(),
    // A staff action notice (removed, deleted, edited): the authority the actor
    // used, so the feed can say "{{gym}} staff" or "a Boardsesh moderator".
    actorRole: boardModerationActorRoleEnum('actor_role'),
    // `board_setup_changed_by_climber`: the change, so the creator's notice can
    // show before and after and offer its undo.
    boardModerationEventId: bigint('board_moderation_event_id', { mode: 'number' }).references(
      () => boardModerationEvents.id,
      { onDelete: 'set null' },
    ),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('directory_notification_context_report_idx').on(table.reportId)],
);

/**
 * One row per UTC day the admin daily digest ran: claimed before the email is
 * sent, so one replica sends it, and read for the next digest's window start.
 * `status` is `sending` while the email goes out, then `sent`, or `empty` when
 * there was nothing to say and no email went out. A failed send deletes its
 * row, so the next hourly run tries again.
 *
 * `counts` holds one number per digest section (`escalatedReports`, and the
 * claim sections PR 6 adds), for the record.
 */
export const adminDailyDigests = pgTable(
  'admin_daily_digests',
  {
    digestDate: date('digest_date', { mode: 'string' }).primaryKey(),
    windowStart: timestamp('window_start').notNull(),
    windowEnd: timestamp('window_end').notNull(),
    status: text('status').notNull(),
    counts: jsonb('counts').$type<Record<string, number>>().default({}).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [check('admin_daily_digests_status_check', sql`${table.status} IN ('sending', 'sent', 'empty')`)],
);

export type DirectoryReport = typeof directoryReports.$inferSelect;
export type NewDirectoryReport = typeof directoryReports.$inferInsert;
export type DirectoryReportReporter = typeof directoryReportReporters.$inferSelect;
export type DirectoryReportTargetKindValue = (typeof directoryReportTargetKindEnum.enumValues)[number];
export type DirectoryReportReasonValue = (typeof directoryReportReasonEnum.enumValues)[number];
export type DirectoryReportStatusValue = (typeof directoryReportStatusEnum.enumValues)[number];
export type DirectoryReportRecipientValue = (typeof directoryReportRecipientEnum.enumValues)[number];
export type DirectoryReportResolverRoleValue = (typeof directoryReportResolverRoleEnum.enumValues)[number];
export type AdminDailyDigest = typeof adminDailyDigests.$inferSelect;
