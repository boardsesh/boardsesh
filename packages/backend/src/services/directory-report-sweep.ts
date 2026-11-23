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
 * 4. Once a UTC day, from 08:00, the team gets the digest: reports that reached
 *    the admin queue since the last digest, and the sections other features add.
 *    No email when every section is empty.
 *
 * On the job queue: `DIRECTORY_REPORT_SWEEP_QUEUE` is `exclusive`, so one run is
 * queued or running across every replica.
 */
import type { PgBoss } from 'pg-boss';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { DirectoryReport } from '@boardsesh/db/schema';
import { DIRECTORY_REPORT_SWEEP_QUEUE } from '@boardsesh/db/job-queue-schema';
import { ESCALATE_AFTER_DAYS, REMINDER_AFTER_DAYS } from '@boardsesh/directory-moderation';
import { db } from '../db/client';
import { transactionWithAfterCommit } from '../db/after-commit';
import { logger } from '../utils/logger';
import { webPublicUrl } from '../utils/public-urls';
import { ADMIN_DIGEST_MAX_ROWS, sendAdminDailyDigestEmail, type AdminDigestSection } from '../email/email-service';
import { loadBoardFacts, loadGymFacts, WAITING_STATUSES } from '../graphql/resolvers/social/directory-reports/core';
import { resolveWaitingReports } from '../graphql/resolvers/social/directory-reports/lifecycle';
import {
  sendDirectoryNotices,
  type PendingDirectoryNotice,
} from '../graphql/resolvers/social/directory-reports/notices';
import { reminderRecipients } from '../graphql/resolvers/social/directory-reports/submit';

/** Every hour at :47 UTC, away from the :00, :17, :23 and :34 jobs. */
export const DIRECTORY_REPORT_SWEEP_CRON = '47 * * * *';

/** The digest goes out with the first sweep at or after this UTC hour. */
export const ADMIN_DIGEST_HOUR_UTC = 8;

/** Rows one sweep step handles; the next hour takes the rest. */
const SWEEP_BATCH = 200;

/** A digest claim older than this never finished sending (a crash mid-send); the next run retries it. */
const STALE_DIGEST_CLAIM_MS = 30 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export type DirectoryReportSweepResult = {
  closedForVanishedTargets: number;
  escalated: number;
  reminded: number;
  digest: AdminDigestOutcome;
};

export async function runDirectoryReportSweep(now: Date = new Date()): Promise<DirectoryReportSweepResult> {
  const closedForVanishedTargets = await closeReportsOnVanishedTargets();
  const escalated = await escalateOverdueReports(now);
  const reminded = await remindOpenReports(now);
  const digest = await maybeSendAdminDigest(now);
  return { closedForVanishedTargets, escalated, reminded, digest };
}

/** Step 1: reports whose board or gym is gone close as deleted or merged, by the system. */
async function closeReportsOnVanishedTargets(): Promise<number> {
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
    if (due.length === 0) continue;
    const resolved = await transactionWithAfterCommit((tx) =>
      resolveWaitingReports(
        tx,
        inArray(
          dbSchema.directoryReports.id,
          due.map((row) => row.id),
        ),
        { outcome, resolvedBy: null, role: 'auto' },
      ),
    );
    closed += resolved.length;
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
async function remindOpenReports(now: Date): Promise<number> {
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
 * {@link ADMIN_DIGEST_SECTION_PROVIDERS} to put a new section in the email;
 * the claim guardrails PR fills {@link autoApprovedClaimsSection}.
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
 * Claims that approved themselves in the window, each with a link to revert it.
 * Empty until the claim guardrails land: that PR replaces this body.
 */
export async function autoApprovedClaimsSection(_window: AdminDigestWindow): Promise<AdminDigestSection | null> {
  return null;
}

/** The digest's sections, in the order the email shows them. */
export const ADMIN_DIGEST_SECTION_PROVIDERS: readonly AdminDigestSectionProvider[] = [
  escalatedReportsSection,
  autoApprovedClaimsSection,
];

export type AdminDigestOutcome = 'not_due' | 'claimed_elsewhere' | 'empty' | 'sent' | 'failed';

/**
 * Step 4. Claims today's row first, so one replica sends; reads the window from
 * the last digest (sent or empty) to now; skips the email when nothing is in
 * it. A failed send gives the claim back for the next hour's run.
 */
export async function maybeSendAdminDigest(
  now: Date = new Date(),
  providers: readonly AdminDigestSectionProvider[] = ADMIN_DIGEST_SECTION_PROVIDERS,
): Promise<AdminDigestOutcome> {
  const today = utcDay(now);
  const [last] = await db
    .select()
    .from(dbSchema.adminDailyDigests)
    .orderBy(desc(dbSchema.adminDailyDigests.digestDate))
    .limit(1);
  if (last && last.status === 'sending' && now.getTime() - last.createdAt.getTime() > STALE_DIGEST_CLAIM_MS) {
    await db
      .delete(dbSchema.adminDailyDigests)
      .where(
        and(
          eq(dbSchema.adminDailyDigests.digestDate, last.digestDate),
          eq(dbSchema.adminDailyDigests.status, 'sending'),
        ),
      );
  }
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

  try {
    const sections = (await Promise.all(providers.map((provider) => provider(window)))).filter(
      (section): section is AdminDigestSection => section !== null && section.total > 0,
    );
    const counts = Object.fromEntries(sections.map((section) => [section.key, section.total]));
    if (sections.length === 0) {
      await db
        .update(dbSchema.adminDailyDigests)
        .set({ status: 'empty', counts })
        .where(eq(dbSchema.adminDailyDigests.digestDate, today));
      return 'empty';
    }
    await sendAdminDailyDigestEmail({ date: today, sections });
    await db
      .update(dbSchema.adminDailyDigests)
      .set({ status: 'sent', counts })
      .where(eq(dbSchema.adminDailyDigests.digestDate, today));
    return 'sent';
  } catch (error) {
    await db.delete(dbSchema.adminDailyDigests).where(eq(dbSchema.adminDailyDigests.digestDate, today));
    logger.error('[DirectoryReports] Daily digest failed; the next run retries', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  }
}

export async function startDirectoryReportSweep(boss: PgBoss): Promise<void> {
  await boss.schedule(DIRECTORY_REPORT_SWEEP_QUEUE, DIRECTORY_REPORT_SWEEP_CRON, null, { tz: 'UTC' });
  await boss.work(DIRECTORY_REPORT_SWEEP_QUEUE, async () => {
    const result = await runDirectoryReportSweep();
    if (result.closedForVanishedTargets + result.escalated + result.reminded > 0 || result.digest === 'sent') {
      logger.info('[DirectoryReports] Sweep', result);
    }
  });
}
