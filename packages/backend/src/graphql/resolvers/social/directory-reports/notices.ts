import { randomUUID } from 'node:crypto';
import { and, eq, exists, gt, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as dbSchema from '@boardsesh/db/schema';
import type { BoardModerationActorRole } from '@boardsesh/db/schema';
import type { DirectoryNotice, Notification } from '@boardsesh/shared-schema';
import { isDirectoryReportOutcome } from '@boardsesh/directory-moderation';
import english from '@boardsesh/i18n/locales/en-US/notifications.json';
import spanish from '@boardsesh/i18n/locales/es/notifications.json';
import french from '@boardsesh/i18n/locales/fr/notifications.json';
import german from '@boardsesh/i18n/locales/de/notifications.json';
import italian from '@boardsesh/i18n/locales/it/notifications.json';
import chinese from '@boardsesh/i18n/locales/zh-CN/notifications.json';
import { db } from '../../../../db/client';
import { pubsub } from '../../../../pubsub/index';
import { canAccessResource } from '../../../../services/privacy';
import { directoryReportsEnabledNow, isDirectoryReportsEnabled } from '../../../../services/directory-reports-flag';
import { enqueueOn, getJobQueue } from '../../../../services/job-queue';
import { NOTIFICATION_PUSH_QUEUE, NOTIFICATION_PUSH_RETRIES } from '../../../../services/notification-push-options';
import { logger } from '../../../../utils/logger';
import { gymVisibleCondition } from '../gym-visibility';
import { WAITING_STATUSES, type DirectoryExecutor } from './core';
import { isDirectoryNoticeType, type DirectoryNoticeType } from './notice-types';
import { readSetupSnapshot, setupChangeStates, toBoardSetup, type RecordedSetupChange } from './setup-snapshot';

export { DIRECTORY_NOTICE_TYPES, isDirectoryNoticeType, type DirectoryNoticeType } from './notice-types';

// ============================================
// Directory notices
// ============================================
//
// Every notification the reports feature sends, in one place
// (docs/product/directory-reports.md, "Notifications"):
//
// - `board_report_opened` / `gym_report_opened`: to the creator and the gym
//   staff a report went to, once when it opens and once more at seven days
//   (`is_reminder`). `board_report_opened` also goes out as a push.
// - `board_report_resolved` / `gym_report_resolved`: to the reporters, with
//   the outcome.
// - `board_removed_from_gym`, `board_deleted_by_staff`, `board_edited_by_staff`:
//   to a board's creator when someone else acts on it.
// - `gym_claimed_with_your_board`: to a creator whose board is listed at a gym
//   that was just claimed, naming the board (gym-claims.ts).
// - `gym_claim_denied`: to a claimant whose claim was denied, expired or
//   reverted (gym-claims.ts, gym-claim-revert.ts).
// - `board_setup_changed_by_climber`: to the people who can undo a climber's
//   change to a board (setup-suggestion.ts): its creator (not SYSTEM) and the
//   owner and admins of its gym, never the climber. Its context names the
//   change, so the notice can show before and after and offer Undo. Also a push.
//
// The rules every one of them follows:
//
// - No actor. The feed names a notification's actor, and for a report that is
//   the reporter, who stays anonymous. Who acted is carried as a role instead.
// - Only while the `directory-reports` flag is on, so no notice reaches an app
//   build that cannot word it.
// - Never about a board the recipient cannot read. The board's creator always
//   can; a deleted board's notices go only to its creator and to its reporters,
//   who could read it when they reported it.
// - Written in the caller's transaction, so a change that rolls back sends
//   nothing. The live feed publish happens once the rows are committed.
// - At most `DIRECTORY_REPORT_PUSHES_PER_DAY` pushes per person per 24 hours,
//   report and setup change pushes together; past that the notice is in-app only.
//
// The feed words a row from `directory_notification_context` (see
// `enrichDirectoryNotices`). Its copy keys live in the `notifications`
// namespace; the app renders them (the mobile PR), and the backend reads only
// the push copy:
//
// i18n-keep notifications.items.boardReportedWrongSetup
// i18n-keep notifications.items.boardReportedDuplicate
// i18n-keep notifications.items.boardReportedGone
// i18n-keep notifications.items.boardReportedWrongPlace
// i18n-keep notifications.items.boardReportedOther
// i18n-keep notifications.items.gymBoardReported
// i18n-keep notifications.items.boardRelistRequested
// i18n-keep notifications.items.boardReportReminder
// i18n-keep notifications.items.boardReportFixed
// i18n-keep notifications.items.boardReportRemoved
// i18n-keep notifications.items.boardReportDeleted
// i18n-keep notifications.items.boardReportMerged
// i18n-keep notifications.items.boardReportKeptByCreator
// i18n-keep notifications.items.boardReportKeptByStaff
// i18n-keep notifications.items.boardReportKeptByTeam
// i18n-keep notifications.items.boardRelisted
// i18n-keep notifications.items.boardRelistDeclined
// i18n-keep notifications.items.boardRemovedByStaff
// i18n-keep notifications.items.boardRemovedByModerator
// i18n-keep notifications.items.boardDeletedByStaff
// i18n-keep notifications.items.boardDeletedByModerator
// i18n-keep notifications.items.boardEditedByStaff
// i18n-keep notifications.items.boardEditedByModerator
// i18n-keep notifications.items.gymReportedWrongDetails
// i18n-keep notifications.items.gymReportReminder
// i18n-keep notifications.items.gymReportFixed
// i18n-keep notifications.items.gymReportRemoved
// i18n-keep notifications.items.gymReportDeleted
// i18n-keep notifications.items.gymReportMerged
// i18n-keep notifications.items.gymReportKeptByStaff
// i18n-keep notifications.items.gymReportKeptByTeam
// i18n-keep notifications.items.gymClaimedWithYourBoard
// i18n-keep notifications.items.gymClaimDenied
// i18n-keep notifications.items.boardSetupChangedByClimber
// i18n-keep notifications.items.boardSetupChangedByClimberAtGym

export type DirectoryNoticeTarget =
  | { kind: 'board'; boardId: number; boardUuid: string; ownerId: string }
  | { kind: 'gym'; gymId: number; gymUuid: string };

export type PendingDirectoryNotice = {
  recipientId: string;
  type: DirectoryNoticeType;
  target: DirectoryNoticeTarget;
  reportId?: number | null;
  /** The gym the notice is about, when the target is a board. */
  gymId?: number | null;
  /** The board the notice names, when the target is a gym (`gym_claimed_with_your_board`). */
  boardId?: number | null;
  /** Staff action notices: the authority the actor used. */
  actorRole?: BoardModerationActorRole | null;
  /** `board_setup_changed_by_climber`: the `setup_changed_by_climber` event. */
  boardModerationEventId?: number | null;
  isReminder?: boolean;
  /** Also send a push to the recipient's registered devices. */
  push?: boolean;
};

/**
 * Whether the recipient may hear about the target. A board: its creator, or
 * anyone who can read it, or (once deleted) a reporter on the notice's report,
 * who could read it when they reported it. Gym staff and anyone else hear
 * nothing about a deleted board. A gym: anyone who can see it, or anyone once
 * it is deleted.
 */
async function recipientMayHear(executor: DirectoryExecutor, notice: PendingDirectoryNotice): Promise<boolean> {
  const { target, recipientId } = notice;
  if (target.kind === 'board') {
    if (target.ownerId === recipientId) return true;
    const [board] = await executor
      .select({ deletedAt: dbSchema.userBoards.deletedAt })
      .from(dbSchema.userBoards)
      .where(eq(dbSchema.userBoards.id, target.boardId))
      .limit(1);
    if (!board) return false;
    if (board.deletedAt) {
      if (notice.reportId == null) return false;
      const [reporter] = await executor
        .select({ id: dbSchema.directoryReportReporters.id })
        .from(dbSchema.directoryReportReporters)
        .where(
          and(
            eq(dbSchema.directoryReportReporters.reportId, notice.reportId),
            eq(dbSchema.directoryReportReporters.reporterId, recipientId),
          ),
        )
        .limit(1);
      return reporter !== undefined;
    }
    return canAccessResource('board', target.boardUuid, recipientId, executor);
  }
  const [gym] = await executor
    .select({
      deletedAt: dbSchema.gyms.deletedAt,
      visible: gymVisibleCondition(dbSchema.gyms, recipientId),
    })
    .from(dbSchema.gyms)
    .where(eq(dbSchema.gyms.id, target.gymId))
    .limit(1);
  if (!gym) return false;
  return gym.deletedAt !== null || gym.visible === true;
}

/**
 * Write these notices in the caller's transaction. Does nothing while the
 * `directory-reports` flag is off. Returns the notification uuids written.
 */
export async function sendDirectoryNotices(
  executor: DirectoryExecutor,
  notices: readonly PendingDirectoryNotice[],
): Promise<string[]> {
  if (notices.length === 0 || !directoryReportsEnabledNow()) return [];
  const written: string[] = [];
  const seen = new Set<string>();
  for (const notice of notices) {
    const targetKey = notice.target.kind === 'board' ? `b${notice.target.boardId}` : `g${notice.target.gymId}`;
    const key = `${notice.recipientId}:${notice.type}:${targetKey}:${notice.reportId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!(await recipientMayHear(executor, notice))) continue;

    const uuid = randomUUID();
    await executor.insert(dbSchema.notifications).values({
      uuid,
      recipientId: notice.recipientId,
      actorId: null,
      type: notice.type,
      entityType: notice.target.kind,
      entityId: notice.target.kind === 'board' ? notice.target.boardUuid : notice.target.gymUuid,
    });
    await executor.insert(dbSchema.directoryNotificationContext).values({
      notificationUuid: uuid,
      reportId: notice.reportId ?? null,
      boardId: notice.target.kind === 'board' ? notice.target.boardId : (notice.boardId ?? null),
      gymId: notice.target.kind === 'gym' ? notice.target.gymId : (notice.gymId ?? null),
      isReminder: notice.isReminder ?? false,
      actorRole: notice.actorRole ?? null,
      boardModerationEventId: notice.boardModerationEventId ?? null,
    });
    if (notice.push) await enqueuePush(executor, uuid, notice.recipientId);
    written.push(uuid);
  }
  publishWhenCommitted(written);
  return written;
}

/**
 * At most this many directory pushes (a report opened, or a climber's setup
 * change) reach one person in 24 hours. Past it, the notices still land in the
 * inbox; only the push is left out. Two reports filed at the same moment can
 * both see one below the cap, so it can be passed by one or two.
 */
export const DIRECTORY_REPORT_PUSHES_PER_DAY = 10;

/** The directory notices that may go out as a push. */
const PUSHED_DIRECTORY_NOTICE_TYPES = ['board_report_opened', 'board_setup_changed_by_climber'] as const;

/** Directory notices pushed to this person in the last 24 hours (to any device). */
async function directoryPushesInLastDay(executor: DirectoryExecutor, recipientId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(dbSchema.notifications)
    .where(
      and(
        eq(dbSchema.notifications.recipientId, recipientId),
        inArray(dbSchema.notifications.type, [...PUSHED_DIRECTORY_NOTICE_TYPES]),
        gt(dbSchema.notifications.createdAt, since),
        exists(
          db
            .select({ one: sql`1` })
            .from(dbSchema.notificationDeliveries)
            .where(eq(dbSchema.notificationDeliveries.notificationUuid, dbSchema.notifications.uuid)),
        ),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Queue a push to every live device of the recipient, in the caller's
 * transaction (the delivery worker in spray-detection-notifications.ts sends it
 * and rechecks the report first). Without a running job queue (a script, a
 * test) the notice stays in-app only, and so does one past the recipient's
 * daily cap (`DIRECTORY_REPORT_PUSHES_PER_DAY`).
 */
async function enqueuePush(executor: DirectoryExecutor, notificationUuid: string, recipientId: string): Promise<void> {
  const boss = getJobQueue();
  if (!boss) return;
  if ((await directoryPushesInLastDay(executor, recipientId)) >= DIRECTORY_REPORT_PUSHES_PER_DAY) return;
  const devices = await executor
    .select()
    .from(dbSchema.notificationDevices)
    .where(
      and(
        eq(dbSchema.notificationDevices.userId, recipientId),
        eq(dbSchema.notificationDevices.active, true),
        gt(dbSchema.notificationDevices.expiresAt, new Date()),
      ),
    );
  for (const device of devices) {
    const deliveryId = randomUUID();
    await executor.insert(dbSchema.notificationDeliveries).values({
      id: deliveryId,
      notificationUuid,
      installationId: device.installationId,
      recipientId,
      token: device.token,
      locale: device.locale,
    });
    const jobId = await boss.send(
      NOTIFICATION_PUSH_QUEUE,
      { deliveryId },
      // Every caller passes its transaction; the executor type is the wider one
      // the moderation helpers share.
      { ...NOTIFICATION_PUSH_RETRIES, db: enqueueOn(executor as unknown as Parameters<typeof enqueueOn>[0]) },
    );
    if (!jobId) throw new Error('PUSH_ENQUEUE_FAILED');
  }
}

// ============================================
// Live publish, after commit
// ============================================
//
// The rows are written inside the caller's transaction, which this module
// cannot see end. So the live publish waits a moment and publishes only the
// rows that are visible by then, which are exactly the committed ones; a
// transaction still running is tried once more, and after that the row reaches
// the app on its next feed read instead.

const PUBLISH_DELAYS_MS = [200, 2_000] as const;
const pendingPublishes = new Set<Promise<void>>();

function publishWhenCommitted(uuids: readonly string[]): void {
  if (uuids.length === 0) return;
  const run = publishAttempt([...uuids], 0).catch((error: unknown) => {
    logger.warn('[DirectoryNotices] Live publish failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  pendingPublishes.add(run);
  void run.finally(() => pendingPublishes.delete(run));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

async function publishAttempt(uuids: string[], attempt: number): Promise<void> {
  await delay(PUBLISH_DELAYS_MS[attempt]);
  const rows = await db
    .select({
      uuid: dbSchema.notifications.uuid,
      recipientId: dbSchema.notifications.recipientId,
      type: dbSchema.notifications.type,
      entityType: dbSchema.notifications.entityType,
      entityId: dbSchema.notifications.entityId,
      createdAt: dbSchema.notifications.createdAt,
    })
    .from(dbSchema.notifications)
    .where(inArray(dbSchema.notifications.uuid, uuids));
  const byRecipient = new Map<string, Notification[]>();
  for (const row of rows) {
    const notification: Notification = {
      uuid: row.uuid,
      type: row.type,
      actorId: null,
      entityType: row.entityType,
      entityId: row.entityId,
      isRead: false,
      createdAt: row.createdAt.toISOString(),
    };
    const list = byRecipient.get(row.recipientId) ?? [];
    list.push(notification);
    byRecipient.set(row.recipientId, list);
  }
  for (const [recipientId, notifications] of byRecipient) {
    await enrichDirectoryNotices(notifications, recipientId);
    for (const notification of notifications) pubsub.publishNotificationEvent(recipientId, { notification });
  }
  const found = new Set(rows.map((row) => row.uuid));
  const missing = uuids.filter((uuid) => !found.has(uuid));
  if (missing.length > 0 && attempt + 1 < PUBLISH_DELAYS_MS.length) await publishAttempt(missing, attempt + 1);
}

/** Wait for every scheduled live publish. For tests and graceful shutdown. */
export async function settleDirectoryNoticePublishes(): Promise<void> {
  while (pendingPublishes.size > 0) await Promise.all(pendingPublishes);
}

// ============================================
// Reading: what a notice is about
// ============================================

type DirectoryNoticeHolder = {
  uuid: string;
  type: string;
  entityType?: string | null;
  gymName?: string | null;
  directoryNotice?: DirectoryNotice | null;
};

function noticeActorRole(actorRole: BoardModerationActorRole | null): DirectoryNotice['actorRole'] {
  // A climber's setup change is worded by its own notice type, not as staff or a moderator.
  if (!actorRole || actorRole === 'board_owner' || actorRole === 'climber') return null;
  if (actorRole === 'gym_owner' || actorRole === 'gym_admin' || actorRole === 'gym_editor') return 'gym_staff';
  return 'moderator';
}

/**
 * Fill `directoryNotice` (and `gymName`) on the directory notices among these
 * notifications or notification groups, in three batched reads. A group is
 * worded from its newest notification, whose uuid it carries.
 */
export async function enrichDirectoryNotices(targets: DirectoryNoticeHolder[], recipientId: string): Promise<void> {
  const holders = targets.filter((target) => isDirectoryNoticeType(target.type));
  if (holders.length === 0) return;
  const contexts = await db
    .select({
      notificationUuid: dbSchema.directoryNotificationContext.notificationUuid,
      reportId: dbSchema.directoryNotificationContext.reportId,
      boardId: dbSchema.directoryNotificationContext.boardId,
      gymId: dbSchema.directoryNotificationContext.gymId,
      isReminder: dbSchema.directoryNotificationContext.isReminder,
      actorRole: dbSchema.directoryNotificationContext.actorRole,
      boardModerationEventId: dbSchema.directoryNotificationContext.boardModerationEventId,
      report: {
        uuid: dbSchema.directoryReports.uuid,
        targetKind: dbSchema.directoryReports.targetKind,
        gymId: dbSchema.directoryReports.gymId,
        gymIdAtReport: dbSchema.directoryReports.gymIdAtReport,
        reason: dbSchema.directoryReports.reason,
        status: dbSchema.directoryReports.status,
        resolvedByRole: dbSchema.directoryReports.resolvedByRole,
        resolutionNote: dbSchema.directoryReports.resolutionNote,
      },
    })
    .from(dbSchema.directoryNotificationContext)
    .leftJoin(
      dbSchema.directoryReports,
      eq(dbSchema.directoryReports.id, dbSchema.directoryNotificationContext.reportId),
    )
    .where(
      inArray(
        dbSchema.directoryNotificationContext.notificationUuid,
        holders.map((holder) => holder.uuid),
      ),
    );
  if (contexts.length === 0) return;

  const boardIds = contexts.flatMap((context) => (context.boardId != null ? [context.boardId] : []));
  const gymIds = contexts.flatMap((context) => {
    const gymId = context.gymId ?? context.report?.gymId ?? context.report?.gymIdAtReport ?? null;
    return gymId != null ? [gymId] : [];
  });
  const [boards, gyms] = await Promise.all([
    boardIds.length > 0
      ? db
          .select({
            id: dbSchema.userBoards.id,
            uuid: dbSchema.userBoards.uuid,
            name: dbSchema.userBoards.name,
            boardType: dbSchema.userBoards.boardType,
            ownerId: dbSchema.userBoards.ownerId,
          })
          .from(dbSchema.userBoards)
          .where(inArray(dbSchema.userBoards.id, [...new Set(boardIds)]))
      : Promise.resolve([]),
    gymIds.length > 0
      ? db
          .select({ id: dbSchema.gyms.id, uuid: dbSchema.gyms.uuid, name: dbSchema.gyms.name })
          .from(dbSchema.gyms)
          .where(inArray(dbSchema.gyms.id, [...new Set(gymIds)]))
      : Promise.resolve([]),
  ]);
  const boardById = new Map(boards.map((board) => [board.id, board]));
  const gymById = new Map(gyms.map((gym) => [gym.id, gym]));
  const contextByUuid = new Map(contexts.map((context) => [context.notificationUuid, context]));
  const setupChanges = await loadNoticeSetupChanges(contexts);

  for (const holder of holders) {
    const context = contextByUuid.get(holder.uuid);
    if (!context) continue;
    const report = context.report;
    const board = context.boardId != null ? boardById.get(context.boardId) : undefined;
    const gymId = context.gymId ?? report?.gymId ?? report?.gymIdAtReport ?? null;
    const gym = gymId != null ? gymById.get(gymId) : undefined;
    const resolved = report && isDirectoryReportOutcome(report.status) ? report.status : null;
    const isResolvedNotice = holder.type === 'board_report_resolved' || holder.type === 'gym_report_resolved';
    holder.directoryNotice = {
      // A gym notice can name a board too (a claim at the gym your board is
      // listed at), so the notification's own entity decides when there is no report.
      targetKind:
        report?.targetKind ??
        (holder.entityType === 'gym' || holder.entityType === 'board' ? holder.entityType : board ? 'board' : 'gym'),
      boardUuid: board?.uuid ?? null,
      boardName: board?.name ?? null,
      boardType: board?.boardType ?? null,
      gymUuid: gym?.uuid ?? null,
      gymName: gym?.name ?? null,
      reportUuid: report?.uuid ?? null,
      reason: report?.reason ?? null,
      outcome: isResolvedNotice ? resolved : null,
      resolvedByRole: isResolvedNotice ? (report?.resolvedByRole ?? null) : null,
      resolutionNote: isResolvedNotice && resolved === 'kept' ? (report?.resolutionNote ?? null) : null,
      actorRole: noticeActorRole(context.actorRole),
      isReminder: context.isReminder,
      recipientIsCreator: board?.ownerId === recipientId,
      ...noticeSetupFields(
        context.boardModerationEventId != null ? setupChanges.get(context.boardModerationEventId) : undefined,
      ),
    };
    if (gym && !holder.gymName) holder.gymName = gym.name;
  }
}

type NoticeSetupChange = RecordedSetupChange & {
  before: NonNullable<ReturnType<typeof readSetupSnapshot>>;
  state: NonNullable<DirectoryNotice['setupChangeState']>;
};

/**
 * The climber setup changes these notices name (`board_setup_changed_by_climber`),
 * with where each stands now: one read of the events, then two for their states.
 */
async function loadNoticeSetupChanges(
  contexts: ReadonlyArray<{ boardModerationEventId: number | null }>,
): Promise<Map<number, NoticeSetupChange>> {
  const eventIds = [
    ...new Set(
      contexts.flatMap((context) => (context.boardModerationEventId != null ? [context.boardModerationEventId] : [])),
    ),
  ];
  if (eventIds.length === 0) return new Map();
  const events = await db
    .select({
      id: dbSchema.boardModerationEvents.id,
      boardId: dbSchema.boardModerationEvents.boardId,
      action: dbSchema.boardModerationEvents.action,
      details: dbSchema.boardModerationEvents.details,
    })
    .from(dbSchema.boardModerationEvents)
    .where(inArray(dbSchema.boardModerationEvents.id, eventIds));
  const changes = events.flatMap((event) => {
    const before = readSetupSnapshot(event.details?.before);
    const after = readSetupSnapshot(event.details?.after);
    if (event.action !== 'setup_changed_by_climber' || !before || !after) return [];
    return [{ id: event.id, boardId: event.boardId, before, after }];
  });
  const states = await setupChangeStates(changes);
  return new Map(changes.map((change) => [change.id, { ...change, state: states.get(change.id) ?? 'CHANGED_SINCE' }]));
}

/** The `directoryNotice` fields of a climber setup change, all null for every other notice. */
function noticeSetupFields(
  change: NoticeSetupChange | undefined,
): Pick<DirectoryNotice, 'setupChangeEventId' | 'setupBefore' | 'setupAfter' | 'setupChangeState'> {
  if (!change) return { setupChangeEventId: null, setupBefore: null, setupAfter: null, setupChangeState: null };
  return {
    setupChangeEventId: String(change.id),
    setupBefore: toBoardSetup(change.before),
    setupAfter: toBoardSetup(change.after),
    setupChangeState: change.state,
  };
}

// ============================================
// Push
// ============================================

const pushCopySchema = z.object({
  push: z.object({
    boardReportTitle: z.string(),
    boardReportBody: z.string(),
    boardReportReminderTitle: z.string(),
    boardReportReminderBody: z.string(),
    boardRelistTitle: z.string(),
    boardRelistBody: z.string(),
    boardSetupChangedTitle: z.string(),
    boardSetupChangedBody: z.string(),
  }),
});

const PUSH_CATALOGS: Record<string, unknown> = {
  'en-US': english,
  es: spanish,
  fr: french,
  de: german,
  it: italian,
  'zh-CN': chinese,
};

// i18n-keep notifications.push.boardReportTitle
// i18n-keep notifications.push.boardReportBody
// i18n-keep notifications.push.boardReportReminderTitle
// i18n-keep notifications.push.boardReportReminderBody
// i18n-keep notifications.push.boardRelistTitle
// i18n-keep notifications.push.boardRelistBody
export function directoryReportPushCopy(
  locale: string,
  input: { boardName: string; gymName: string | null; isReminder: boolean; isRelistRequest: boolean },
): { title: string; body: string } {
  const { push } = pushCopySchema.parse(PUSH_CATALOGS[locale] ?? english);
  const fill = (text: string) =>
    text.replaceAll('{{board}}', input.boardName).replaceAll('{{gym}}', input.gymName ?? input.boardName);
  if (input.isRelistRequest && !input.isReminder) {
    return { title: fill(push.boardRelistTitle), body: fill(push.boardRelistBody) };
  }
  if (input.isReminder) return { title: fill(push.boardReportReminderTitle), body: fill(push.boardReportReminderBody) };
  return { title: fill(push.boardReportTitle), body: fill(push.boardReportBody) };
}

/**
 * Recheck a queued `board_report_opened` push before every attempt, receipt
 * retries included: the flag is still on, the report is still waiting, and the
 * recipient can still read the board. Null means skip.
 */
export async function directoryReportPushTarget(
  notificationUuid: string,
  executor: DirectoryExecutor = db,
): Promise<{
  recipientId: string;
  boardUuid: string;
  boardName: string;
  gymName: string | null;
  reportUuid: string;
  isReminder: boolean;
  isRelistRequest: boolean;
} | null> {
  // Awaited, not read from the cache: a cold or stale cache reads as off, and
  // an off answer marks the delivery skipped for good.
  if (!(await isDirectoryReportsEnabled())) return null;
  const [row] = await executor
    .select({
      recipientId: dbSchema.notifications.recipientId,
      type: dbSchema.notifications.type,
      isReminder: dbSchema.directoryNotificationContext.isReminder,
      reportUuid: dbSchema.directoryReports.uuid,
      reason: dbSchema.directoryReports.reason,
      status: dbSchema.directoryReports.status,
      gymId: dbSchema.directoryReports.gymIdAtReport,
      boardId: dbSchema.userBoards.id,
      boardUuid: dbSchema.userBoards.uuid,
      boardName: dbSchema.userBoards.name,
      ownerId: dbSchema.userBoards.ownerId,
      boardDeletedAt: dbSchema.userBoards.deletedAt,
    })
    .from(dbSchema.notifications)
    .innerJoin(
      dbSchema.directoryNotificationContext,
      eq(dbSchema.directoryNotificationContext.notificationUuid, dbSchema.notifications.uuid),
    )
    .innerJoin(
      dbSchema.directoryReports,
      eq(dbSchema.directoryReports.id, dbSchema.directoryNotificationContext.reportId),
    )
    .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.id, dbSchema.directoryReports.boardId))
    .where(eq(dbSchema.notifications.uuid, notificationUuid))
    .limit(1);
  if (!row || row.type !== 'board_report_opened' || row.boardDeletedAt) return null;
  if (!(WAITING_STATUSES as readonly string[]).includes(row.status)) return null;
  if (
    row.ownerId !== row.recipientId &&
    !(await canAccessResource('board', row.boardUuid, row.recipientId, executor))
  ) {
    return null;
  }
  let gymName: string | null = null;
  if (row.gymId != null) {
    const [gym] = await executor
      .select({ name: dbSchema.gyms.name })
      .from(dbSchema.gyms)
      .where(eq(dbSchema.gyms.id, row.gymId))
      .limit(1);
    gymName = gym?.name ?? null;
  }
  return {
    recipientId: row.recipientId,
    boardUuid: row.boardUuid,
    boardName: row.boardName,
    gymName,
    reportUuid: row.reportUuid,
    isReminder: row.isReminder,
    isRelistRequest: row.reason === 'relist_request',
  };
}

// i18n-keep notifications.push.boardSetupChangedTitle
// i18n-keep notifications.push.boardSetupChangedBody
export function directorySetupChangePushCopy(
  locale: string,
  input: { boardName: string },
): {
  title: string;
  body: string;
} {
  const { push } = pushCopySchema.parse(PUSH_CATALOGS[locale] ?? english);
  return {
    title: push.boardSetupChangedTitle.replaceAll('{{board}}', input.boardName),
    body: push.boardSetupChangedBody,
  };
}

/**
 * Recheck a queued `board_setup_changed_by_climber` push before every attempt,
 * receipt retries included: the flag is still on, the board is live, the
 * recipient can still read it, and the change is still LIVE (nothing to undo
 * once it was undone or the board changed again). Null means skip.
 */
export async function directorySetupChangePushTarget(
  notificationUuid: string,
  executor: DirectoryExecutor = db,
): Promise<{ recipientId: string; boardUuid: string; boardName: string; setupChangeEventId: string } | null> {
  // Awaited, not read from the cache, as for the report push.
  if (!(await isDirectoryReportsEnabled())) return null;
  const [row] = await executor
    .select({
      recipientId: dbSchema.notifications.recipientId,
      type: dbSchema.notifications.type,
      eventId: dbSchema.boardModerationEvents.id,
      action: dbSchema.boardModerationEvents.action,
      details: dbSchema.boardModerationEvents.details,
      boardId: dbSchema.userBoards.id,
      boardUuid: dbSchema.userBoards.uuid,
      boardName: dbSchema.userBoards.name,
      ownerId: dbSchema.userBoards.ownerId,
      boardDeletedAt: dbSchema.userBoards.deletedAt,
    })
    .from(dbSchema.notifications)
    .innerJoin(
      dbSchema.directoryNotificationContext,
      eq(dbSchema.directoryNotificationContext.notificationUuid, dbSchema.notifications.uuid),
    )
    .innerJoin(
      dbSchema.boardModerationEvents,
      eq(dbSchema.boardModerationEvents.id, dbSchema.directoryNotificationContext.boardModerationEventId),
    )
    .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.id, dbSchema.boardModerationEvents.boardId))
    .where(eq(dbSchema.notifications.uuid, notificationUuid))
    .limit(1);
  if (!row || row.type !== 'board_setup_changed_by_climber' || row.action !== 'setup_changed_by_climber') return null;
  if (row.boardDeletedAt) return null;
  const after = readSetupSnapshot(row.details?.after);
  if (!after) return null;
  const states = await setupChangeStates([{ id: row.eventId, boardId: row.boardId, after }], executor);
  if (states.get(row.eventId) !== 'LIVE') return null;
  if (
    row.ownerId !== row.recipientId &&
    !(await canAccessResource('board', row.boardUuid, row.recipientId, executor))
  ) {
    return null;
  }
  return {
    recipientId: row.recipientId,
    boardUuid: row.boardUuid,
    boardName: row.boardName,
    setupChangeEventId: String(row.eventId),
  };
}
