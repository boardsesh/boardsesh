/**
 * The hourly sweep over directory reports (docs/product/directory-reports.md,
 * "The sweep"), and the admin's daily digest email.
 *
 * Every step reads what is due rather than what changed since the last run, so
 * a missed hour, a retry or a second replica changes nothing twice:
 *
 * 1. Reports about a board or gym that has since been deleted or merged close
 *    as deleted or merged (the deletes and merges that do not go through a hook).
 * 2. Waiting reports older than fourteen days move to the admin queue
 *    (`escalated`).
 * 3. Open reports older than seven days with no reminder get one: a second
 *    notice to the people the report went to.
 * 4. Admin-review gym claims nobody decided within 30 days expire, and the
 *    claimant hears (`expireStaleAdminClaims`, docs/product/gym-claims.md).
 *    Only claims filed from `GYM_CLAIM_EXPIRY_STARTS_AT` on; older ones wait
 *    for a person.
 * 5. Once a UTC day, from 08:00, the team gets the digest: reports that reached
 *    the admin queue since the last digest, claims that approved themselves,
 *    setups climbers changed, and the sections other features add. No email
 *    when every section is empty.
 *
 * On the job queue: `DIRECTORY_REPORT_SWEEP_QUEUE` is `exclusive`, so one run is
 * queued or running across every replica.
 */
import type { PgBoss } from 'pg-boss';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { DirectoryReport } from '@boardsesh/db/schema';
import { DIRECTORY_REPORT_SWEEP_QUEUE } from '@boardsesh/db/job-queue-schema';
import { boardSetupSummary } from '@boardsesh/board-config';
import { ESCALATE_AFTER_DAYS, REMINDER_AFTER_DAYS } from '@boardsesh/directory-moderation';
import { db } from '../db/client';
import { transactionWithAfterCommit } from '../db/after-commit';
import { logger } from '../utils/logger';
import { webPublicUrl } from '../utils/public-urls';
import { ADMIN_DIGEST_MAX_ROWS, sendAdminDailyDigestEmail, type AdminDigestSection } from '../email/email-service';
import { loadBoardFacts, loadGymFacts, WAITING_STATUSES } from '../graphql/resolvers/social/directory-reports/core';
import { resolveWaitingReports } from '../graphql/resolvers/social/directory-reports/lifecycle';
import { readSetupSnapshot, setupChangeStates } from '../graphql/resolvers/social/directory-reports/setup-snapshot';
import {
  sendDirectoryNotices,
  type PendingDirectoryNotice,
} from '../graphql/resolvers/social/directory-reports/notices';
import { reminderRecipients } from '../graphql/resolvers/social/directory-reports/submit';
import { expireStaleAdminClaims } from '../graphql/resolvers/social/gym-claims';
import { autoApprovedClaimCondition } from '../graphql/resolvers/social/gym-claim-guardrails';

/** Every hour at :47 UTC, away from the :00, :17, :23 and :34 jobs. */
export const DIRECTORY_REPORT_SWEEP_CRON = '47 * * * *';

/** The digest goes out with the first sweep at or after this UTC hour. */
export const ADMIN_DIGEST_HOUR_UTC = 8;

/** Rows one sweep step handles; the next hour takes the rest. */
const SWEEP_BATCH = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

export type DirectoryReportSweepResult = {
  closedForVanishedTargets: number;
  escalated: number;
  reminded: number;
  /** Admin-review gym claims that expired after 30 days without a decision. */
  claimsExpired: number;
  digest: AdminDigestOutcome;
  /** Reports a step could not handle this run, and steps that failed outright. The next run tries them again. */
  failures: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Every step runs whatever happened in the one before it, and each report is
 * handled on its own, so one report that fails (a lock timeout, a notice that
 * can't be written) neither stops the others nor the digest.
 */
export async function runDirectoryReportSweep(now: Date = new Date()): Promise<DirectoryReportSweepResult> {
  const failures = { count: 0 };
  const step = async <T>(name: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      failures.count += 1;
      logger.error(`[DirectoryReports] Sweep step failed: ${name}`, { error: errorMessage(error) });
      return fallback;
    }
  };
  const closedForVanishedTargets = await step('close', () => closeReportsOnVanishedTargets(failures), 0);
  const escalated = await step('escalate', () => escalateOverdueReports(now), 0);
  const reminded = await step('remind', () => remindOpenReports(now, failures), 0);
  const claimsExpired = await step('expire claims', () => expireStaleAdminClaims(now, failures, SWEEP_BATCH), 0);
  const digest = await step('digest', () => maybeSendAdminDigest(now), 'failed' as AdminDigestOutcome);
  return { closedForVanishedTargets, escalated, reminded, claimsExpired, digest, failures: failures.count };
}

/** Step 1: reports whose board or gym is gone close as deleted or merged, by the system. */
async function closeReportsOnVanishedTargets(failures: { count: number }): Promise<number> {
  const waiting = inArray(dbSchema.directoryReports.status, [...WAITING_STATUSES]);
  const boardGone = (merged: boolean) =>
    sql`EXISTS (SELECT 1 FROM ${dbSchema.userBoards} WHERE ${dbSchema.userBoards.id} = ${dbSchema.directoryReports.boardId}
      AND ${dbSchema.userBoards.deletedAt} IS NOT NULL
      AND ${dbSchema.userBoards.mergedIntoBoardUuid} IS ${merged ? sql`NOT NULL` : sql`NULL`})`;
  const gymGone = (merged: boolean) =>
    sql`EXISTS (SELECT 1 FROM ${dbSchema.gyms} WHERE ${dbSchema.gyms.id} = ${dbSchema.directoryReports.gymId}
      AND (${dbSchema.gyms.deletedAt} IS NOT NULL OR ${dbSchema.gyms.mergedIntoGymId} IS NOT NULL)
      AND ${dbSchema.gyms.mergedIntoGymId} IS ${merged ? sql`NOT NULL` : sql`NULL`})`;
  let closed = 0;
  for (const [condition, outcome] of [
    [boardGone(true), 'merged'],
    [boardGone(false), 'deleted'],
    [gymGone(true), 'merged'],
    [gymGone(false), 'deleted'],
  ] as const) {
    const due = await db
      .select({ id: dbSchema.directoryReports.id })
      .from(dbSchema.directoryReports)
      .where(and(waiting, condition))
      .limit(SWEEP_BATCH);
    for (const { id } of due) {
      try {
        const resolved = await transactionWithAfterCommit((tx) =>
          resolveWaitingReports(tx, eq(dbSchema.directoryReports.id, id), {
            outcome,
            resolvedBy: null,
            role: 'auto',
          }),
        );
        closed += resolved.length;
      } catch (error) {
        failures.count += 1;
        logger.error('[DirectoryReports] Could not close a report on a vanished target', {
          reportId: id,
          error: errorMessage(error),
        });
      }
    }
  }
  return closed;
}

/** Step 2: open reports past fourteen days move to the admin queue. */
async function escalateOverdueReports(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - ESCALATE_AFTER_DAYS * DAY_MS);
  const escalated = await db
    .update(dbSchema.directoryReports)
    .set({ status: 'escalated', escalatedAt: now })
    .where(and(eq(dbSchema.directoryReports.status, 'open'), lte(dbSchema.directoryReports.createdAt, cutoff)))
    .returning({ id: dbSchema.directoryReports.id });
  if (escalated.length > 0) logger.info('[DirectoryReports] Escalated to the admin queue', { count: escalated.length });
  return escalated.length;
}

/** Step 3: one reminder to the people an open report went to, at seven days. */
async function remindOpenReports(now: Date, failures: { count: number }): Promise<number> {
  const cutoff = new Date(now.getTime() - REMINDER_AFTER_DAYS * DAY_MS);
  const due = await db
    .select({ id: dbSchema.directoryReports.id })
    .from(dbSchema.directoryReports)
    .where(
      and(
        eq(dbSchema.directoryReports.status, 'open'),
        isNull(dbSchema.directoryReports.remindedAt),
        lte(dbSchema.directoryReports.createdAt, cutoff),
      ),
    )
    .orderBy(asc(dbSchema.directoryReports.createdAt))
    .limit(SWEEP_BATCH);
  let reminded = 0;
  for (const { id } of due) {
    try {
      const sent = await db.transaction(async (tx) => {
        // Claimed under the row lock, so a second runner skips it.
        const [report] = await tx
          .update(dbSchema.directoryReports)
          .set({ remindedAt: now })
          .where(
            and(
              eq(dbSchema.directoryReports.id, id),
              eq(dbSchema.directoryReports.status, 'open'),
              isNull(dbSchema.directoryReports.remindedAt),
            ),
          )
          .returning();
        if (!report) return false;
        await sendDirectoryNotices(tx, await reminderNotices(tx, report));
        return true;
      });
      if (sent) reminded += 1;
    } catch (error) {
      // Rolled back, `reminded_at` with it: the next run reminds it again.
      failures.count += 1;
      logger.error('[DirectoryReports] Could not send a reminder', { reportId: id, error: errorMessage(error) });
    }
  }
  return reminded;
}

async function reminderNotices(
  executor: Parameters<typeof reminderRecipients>[0],
  report: DirectoryReport,
): Promise<PendingDirectoryNotice[]> {
  const board =
    report.boardId != null ? (await loadBoardFacts([report.boardId], executor)).get(report.boardId) : undefined;
  const gym = report.gymId != null ? (await loadGymFacts([report.gymId], executor)).get(report.gymId) : undefined;
  const recipients = await reminderRecipients(executor, report, board, gym);
  return recipients.flatMap((recipientId): PendingDirectoryNotice[] => {
    if (report.targetKind === 'board' && board) {
      return [
        {
          recipientId,
          type: 'board_report_opened',
          target: { kind: 'board', boardId: board.id, boardUuid: board.uuid, ownerId: board.ownerId },
          reportId: report.id,
          gymId: report.gymIdAtReport,
          isReminder: true,
          push: true,
        },
      ];
    }
    if (report.targetKind === 'gym' && gym) {
      return [
        {
          recipientId,
          type: 'gym_report_opened',
          target: { kind: 'gym', gymId: gym.id, gymUuid: gym.uuid },
          reportId: report.id,
          isReminder: true,
        },
      ];
    }
    return [];
  });
}

// ============================================
// The admin's daily digest
// ============================================

export type AdminDigestWindow = { start: Date; end: Date };

/**
 * A digest section, or null when it has nothing to report. Add a provider to
 * {@link ADMIN_DIGEST_SECTION_PROVIDERS} to put a new section in the email.
 */
export type AdminDigestSectionProvider = (window: AdminDigestWindow) => Promise<AdminDigestSection | null>;

/** The YYYY-MM-DD UTC day of a time. */
export function utcDay(time: Date): string {
  return time.toISOString().slice(0, 10);
}

/** Whether a digest is due: at or after the digest hour, on a UTC day that has none yet. */
export function isAdminDigestDue(now: Date, lastDigestDay: string | null): boolean {
  return now.getUTCHours() >= ADMIN_DIGEST_HOUR_UTC && lastDigestDay !== utcDay(now);
}

const REASON_LABELS: Record<dbSchema.DirectoryReportReasonValue, string> = {
  wrong_setup: 'Set up wrong',
  duplicate: 'Listed twice',
  gone: 'Not on the wall anymore',
  wrong_place: 'Wrong gym or place',
  other: 'Something else',
  relist_request: 'Asks to be listed again',
  closed: 'Closed for good',
  wrong_details: 'Wrong address or details',
  not_a_gym: "It's someone's home",
};

/** Reports that reached the admin queue in the window and are still waiting there. */
export async function escalatedReportsSection(window: AdminDigestWindow): Promise<AdminDigestSection | null> {
  const inWindow = and(
    eq(dbSchema.directoryReports.status, 'escalated'),
    isNotNull(dbSchema.directoryReports.escalatedAt),
    gt(dbSchema.directoryReports.escalatedAt, window.start),
    lte(dbSchema.directoryReports.escalatedAt, window.end),
  );
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(dbSchema.directoryReports)
    .where(inWindow);
  if (total === 0) return null;
  const reports = await db
    .select()
    .from(dbSchema.directoryReports)
    .where(inWindow)
    .orderBy(asc(dbSchema.directoryReports.escalatedAt), asc(dbSchema.directoryReports.id))
    .limit(ADMIN_DIGEST_MAX_ROWS);
  const [boards, gyms] = await Promise.all([
    loadBoardFacts(reports.flatMap((report) => (report.boardId != null ? [report.boardId] : []))),
    loadGymFacts(
      reports.flatMap((report) => [report.gymId, report.gymIdAtReport]).filter((id): id is number => id != null),
    ),
  ]);
  const queueUrl = `${webPublicUrl()}/admin/board-reports`;
  return {
    key: 'escalatedReports',
    heading: 'Reports in the admin queue',
    total,
    moreUrl: queueUrl,
    moreLabel: 'Open the report queue',
    rows: reports.map((report) => {
      const board = report.boardId != null ? boards.get(report.boardId) : undefined;
      const gym = gyms.get((report.targetKind === 'board' ? report.gymIdAtReport : report.gymId) ?? -1);
      const subject =
        report.targetKind === 'board'
          ? `${board?.name ?? 'A board'}${gym ? ` at ${gym.name}` : ''}`
          : (gym?.name ?? 'A gym');
      return {
        label: `${REASON_LABELS[report.reason]}: ${subject}`,
        url: `${queueUrl}?report=${encodeURIComponent(report.uuid)}`,
      };
    }),
  };
}

/**
 * Claims that approved themselves in the window (by their ownership decision's
 * time), each with the gym, the claimant's name and how old their account was
 * when it approved, and a link to revert it: `/admin/gym-claims?revert=<claim
 * id>` (docs/product/gym-claims.md). One already reverted says so and keeps
 * its link, so the count is every auto-approval in the window.
 */
export async function autoApprovedClaimsSection(window: AdminDigestWindow): Promise<AdminDigestSection | null> {
  const inWindow = and(
    autoApprovedClaimCondition(['approved', 'revoked']),
    eq(dbSchema.gymClaimOwnershipDecisions.didTransfer, true),
    gt(dbSchema.gymClaimOwnershipDecisions.decidedAt, window.start),
    lte(dbSchema.gymClaimOwnershipDecisions.decidedAt, window.end),
  );
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(dbSchema.gymClaims)
    .innerJoin(
      dbSchema.gymClaimOwnershipDecisions,
      eq(dbSchema.gymClaimOwnershipDecisions.claimId, dbSchema.gymClaims.id),
    )
    .where(inWindow);
  if (total === 0) return null;
  const claims = await db
    .select({
      id: dbSchema.gymClaims.id,
      status: dbSchema.gymClaims.status,
      approvedAt: dbSchema.gymClaimOwnershipDecisions.decidedAt,
      gymName: dbSchema.gyms.name,
      displayName: dbSchema.userProfiles.displayName,
      userName: dbSchema.users.name,
      accountCreatedAt: dbSchema.users.createdAt,
    })
    .from(dbSchema.gymClaims)
    .innerJoin(
      dbSchema.gymClaimOwnershipDecisions,
      eq(dbSchema.gymClaimOwnershipDecisions.claimId, dbSchema.gymClaims.id),
    )
    .innerJoin(dbSchema.gyms, eq(dbSchema.gyms.id, dbSchema.gymClaims.gymId))
    .leftJoin(dbSchema.users, eq(dbSchema.users.id, dbSchema.gymClaims.claimantUserId))
    .leftJoin(dbSchema.userProfiles, eq(dbSchema.userProfiles.userId, dbSchema.gymClaims.claimantUserId))
    .where(inWindow)
    .orderBy(asc(dbSchema.gymClaimOwnershipDecisions.decidedAt), asc(dbSchema.gymClaims.id))
    .limit(ADMIN_DIGEST_MAX_ROWS);
  const queueUrl = `${webPublicUrl()}/admin/gym-claims`;
  return {
    key: 'autoApprovedClaims',
    heading: 'Claims that approved themselves',
    total,
    moreUrl: queueUrl,
    moreLabel: 'Open the claim queue',
    rows: claims.map((claim) => {
      const claimant = claim.displayName || claim.userName || 'A climber';
      const accountAgeDays = claim.accountCreatedAt
        ? Math.max(0, Math.floor((claim.approvedAt.getTime() - claim.accountCreatedAt.getTime()) / DAY_MS))
        : null;
      const age = accountAgeDays === null ? 'account deleted' : `account ${accountAgeDays} days old`;
      const reverted = claim.status === 'revoked' ? ' (already reverted)' : '';
      return {
        label: `${claim.gymName}: claimed by ${claimant}, ${age}${reverted}`,
        url: `${queueUrl}?revert=${encodeURIComponent(String(claim.id))}`,
      };
    }),
  };
}

/** Rows the climbers' setup changes section lists; the rest are behind its link. */
export const SETUP_CHANGES_DIGEST_ROWS = 10;

/**
 * Setups climbers changed in the window (docs/product/directory-reports.md,
 * "Suggested setup"), newest first: the count, and up to
 * {@link SETUP_CHANGES_DIGEST_ROWS} rows with the board, its gym and the setup
 * before → after in words. Every row and the section link open the admin's
 * Setup changes tab, where each one can be undone. A change already undone
 * says so and still counts.
 */
export async function climberSetupChangesSection(window: AdminDigestWindow): Promise<AdminDigestSection | null> {
  const events = dbSchema.boardModerationEvents;
  const inWindow = and(
    eq(events.action, 'setup_changed_by_climber'),
    gt(events.createdAt, window.start),
    lte(events.createdAt, window.end),
  );
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(events)
    .where(inWindow);
  if (total === 0) return null;
  const rows = await db
    .select({
      id: events.id,
      boardId: events.boardId,
      details: events.details,
      boardName: dbSchema.userBoards.name,
      boardType: dbSchema.userBoards.boardType,
      gymName: dbSchema.gyms.name,
    })
    .from(events)
    .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.id, events.boardId))
    .leftJoin(dbSchema.gyms, eq(dbSchema.gyms.id, events.gymId))
    .where(inWindow)
    .orderBy(desc(events.id))
    .limit(SETUP_CHANGES_DIGEST_ROWS);
  const recorded = rows.flatMap((row) => {
    const before = readSetupSnapshot(row.details?.before);
    const after = readSetupSnapshot(row.details?.after);
    return before && after ? [{ row, before, after }] : [];
  });
  const states = await setupChangeStates(
    recorded.map(({ row, after }) => ({ id: row.id, boardId: row.boardId, after })),
  );
  const tabUrl = `${webPublicUrl()}/admin/board-reports?tab=setup-changes`;
  return {
    key: 'climberSetupChanges',
    heading: 'Setups climbers changed',
    total,
    moreUrl: tabUrl,
    moreLabel: 'Open setup changes',
    rows: recorded.map(({ row, before, after }) => {
      const place = row.gymName ? ` at ${row.gymName}` : '';
      const undone = states.get(row.id) === 'UNDONE' ? ' (already undone)' : '';
      return {
        label: `${row.boardName}${place}: ${boardSetupSummary(row.boardType, before)} → ${boardSetupSummary(row.boardType, after)}${undone}`,
        url: tabUrl,
      };
    }),
  };
}

/** The digest's sections, in the order the email shows them. */
export const ADMIN_DIGEST_SECTION_PROVIDERS: readonly AdminDigestSectionProvider[] = [
  escalatedReportsSection,
  autoApprovedClaimsSection,
  climberSetupChangesSection,
];

export type AdminDigestOutcome = 'not_due' | 'claimed_elsewhere' | 'empty' | 'sent' | 'failed';

/**
 * Step 4. Claims today's row first, so one replica sends; reads the window from
 * the last digest (sent or empty) to now; skips the email when nothing is in
 * it. A digest that failed before or while sending gives the claim back for the
 * next hour's run. One whose email went out keeps it, even when recording
 * `sent` fails: the claim then holds the day, rather than the next run sending
 * the email again.
 */
export async function maybeSendAdminDigest(
  now: Date = new Date(),
  providers: readonly AdminDigestSectionProvider[] = ADMIN_DIGEST_SECTION_PROVIDERS,
): Promise<AdminDigestOutcome> {
  const today = utcDay(now);
  // A claim left in `sending` (a crash mid-send, or an email that went out but
  // could not be recorded) holds its day, so that day's email never goes out
  // twice. It is cleared from the next day on; that day's digest covers the
  // window, which starts where the last finished digest ended.
  await db
    .delete(dbSchema.adminDailyDigests)
    .where(and(eq(dbSchema.adminDailyDigests.status, 'sending'), lt(dbSchema.adminDailyDigests.digestDate, today)));
  const [lastFinished] = await db
    .select()
    .from(dbSchema.adminDailyDigests)
    .where(or(eq(dbSchema.adminDailyDigests.status, 'sent'), eq(dbSchema.adminDailyDigests.status, 'empty')))
    .orderBy(desc(dbSchema.adminDailyDigests.digestDate))
    .limit(1);
  if (!isAdminDigestDue(now, lastFinished?.digestDate ?? null)) return 'not_due';

  const window: AdminDigestWindow = { start: lastFinished?.windowEnd ?? new Date(now.getTime() - DAY_MS), end: now };
  const [claimed] = await db
    .insert(dbSchema.adminDailyDigests)
    .values({ digestDate: today, windowStart: window.start, windowEnd: window.end, status: 'sending', createdAt: now })
    .onConflictDoNothing()
    .returning({ digestDate: dbSchema.adminDailyDigests.digestDate });
  if (!claimed) return 'claimed_elsewhere';

  const giveBackClaim = async (error: unknown): Promise<AdminDigestOutcome> => {
    logger.error('[DirectoryReports] Daily digest failed; the next run retries', { error: errorMessage(error) });
    await db.delete(dbSchema.adminDailyDigests).where(eq(dbSchema.adminDailyDigests.digestDate, today));
    return 'failed';
  };
  const record = async (status: 'sent' | 'empty', counts: Record<string, number>): Promise<void> => {
    try {
      await db
        .update(dbSchema.adminDailyDigests)
        .set({ status, counts })
        .where(eq(dbSchema.adminDailyDigests.digestDate, today));
    } catch (error) {
      logger.error('[DirectoryReports] Daily digest done but not recorded; the claim holds the day', {
        status,
        error: errorMessage(error),
      });
    }
  };

  let sections: AdminDigestSection[];
  try {
    sections = (await Promise.all(providers.map((provider) => provider(window)))).filter(
      (section): section is AdminDigestSection => section !== null && section.total > 0,
    );
  } catch (error) {
    return giveBackClaim(error);
  }
  const counts = Object.fromEntries(sections.map((section) => [section.key, section.total]));
  if (sections.length === 0) {
    await record('empty', counts);
    return 'empty';
  }
  try {
    await sendAdminDailyDigestEmail({ date: today, sections });
  } catch (error) {
    return giveBackClaim(error);
  }
  await record('sent', counts);
  return 'sent';
}

export async function startDirectoryReportSweep(boss: PgBoss): Promise<void> {
  await boss.schedule(DIRECTORY_REPORT_SWEEP_QUEUE, DIRECTORY_REPORT_SWEEP_CRON, null, { tz: 'UTC' });
  await boss.work(DIRECTORY_REPORT_SWEEP_QUEUE, async () => {
    const result = await runDirectoryReportSweep();
    if (
      result.closedForVanishedTargets + result.escalated + result.reminded + result.claimsExpired + result.failures >
        0 ||
      result.digest === 'sent'
    ) {
      logger.info('[DirectoryReports] Sweep', result);
    }
  });
}
