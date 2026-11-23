/**
 * The clock of a report (docs/product/gym-board-governance.md, decision 2): one
 * reminder to the people it went to after a week, and the Boardsesh admin queue
 * after two weeks without an outcome.
 */

/** Days after a report opens that its recipients get one reminder. */
export const REMINDER_AFTER_DAYS = 7;

/** Days after a report opens that it moves to the admin queue. */
export const ESCALATE_AFTER_DAYS = 14;

/** How long a closed report stays in the creator's and staff's reads. */
export const RECENTLY_RESOLVED_DAYS = 30;

/**
 * Days after a climber's report closes that they can't open the same report
 * (same board or gym, same reason) again. Each new report reaches its people
 * with a notice and, for a board, a push.
 */
export const REPORT_REFILE_COOLDOWN_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** When a report opened at `createdAt` is due its reminder. */
export function reportReminderDueAt(createdAt: Date): Date {
  return addDays(createdAt, REMINDER_AFTER_DAYS);
}

/**
 * When a report opened at `createdAt` moves to the admin queue, for the review
 * sheet's "If it's still open on {{date}}, our team takes a look."
 */
export function reportEscalatesAt(createdAt: Date): Date {
  return addDays(createdAt, ESCALATE_AFTER_DAYS);
}

/** Whether an open report is due its one reminder at `now`. */
export function isReportReminderDue(report: { createdAt: Date; remindedAt: Date | null }, now: Date): boolean {
  return report.remindedAt === null && now.getTime() >= reportReminderDueAt(report.createdAt).getTime();
}

/** Whether an open report is due the admin queue at `now`. */
export function isReportEscalationDue(report: { createdAt: Date }, now: Date): boolean {
  return now.getTime() >= reportEscalatesAt(report.createdAt).getTime();
}
