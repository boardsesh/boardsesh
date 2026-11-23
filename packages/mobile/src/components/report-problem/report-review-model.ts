// What the report review sheet shows, read from `boardReports`: the reports
// still waiting, the date the team steps in, and which of them this viewer may
// close. Pure, for a table test.

import { isOpenDirectoryReportStatus } from '@boardsesh/directory-moderation';
import type { DirectoryReport } from '@boardsesh/shared-schema';

/** Reports still waiting on someone (`open` or `escalated`), oldest first. */
export function waitingReports(reports: readonly DirectoryReport[]): DirectoryReport[] {
  return reports
    .filter((report) => isOpenDirectoryReportStatus(report.status))
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

/**
 * The footnote under the reports:
 *
 * - `team_date`: the earliest day a still-`open` report goes to the team
 *   ("If it's still open on 7 Dec, our team takes a look.").
 * - `team_looking`: one is already with the team and this viewer can't close
 *   it; the server refuses, so the sheet says the team has it.
 * - null: nothing waiting.
 */
export type ReviewFootnote = { kind: 'team_date'; escalatesAt: string } | { kind: 'team_looking' } | null;

export function reviewFootnote(waiting: readonly DirectoryReport[]): ReviewFootnote {
  if (waiting.some((report) => !report.viewerCanResolve)) return { kind: 'team_looking' };
  const open = waiting.filter((report) => report.status === 'open');
  if (open.length === 0) return null;
  const earliest = open.reduce((first, report) =>
    Date.parse(report.escalatesAt) < Date.parse(first.escalatesAt) ? report : first,
  );
  return { kind: 'team_date', escalatesAt: earliest.escalatesAt };
}

/** The waiting reports "It's right as it is" closes: the ones the server lets this viewer close. */
export function keepableReports(waiting: readonly DirectoryReport[]): DirectoryReport[] {
  return waiting.filter((report) => report.viewerCanResolve);
}

/** Every reporter note on the waiting reports, newest first. Names are never shown. */
export function reviewNotes(waiting: readonly DirectoryReport[]): { key: string; note: string }[] {
  return waiting
    .flatMap((report) =>
      report.notes.map((note, index) => ({ key: `${report.uuid}:${index}`, note: note.note, at: note.createdAt })),
    )
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
    .map(({ key, note }) => ({ key, note }));
}
