// What the report review sheet shows, read from `boardReports`: the reports
// still waiting, the date the team steps in, and which of them this viewer may
// close. Pure, for a table test.

import { normaliseSetIds } from '@boardsesh/board-config';
import { isOpenDirectoryReportStatus, SETUP_SUGGESTION_REPORT_REASON } from '@boardsesh/directory-moderation';
import type { BoardSetup, DirectoryReport, UpdateBoardInput } from '@boardsesh/shared-schema';

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

/**
 * Every reporter note on the waiting reports, newest first. Names are never
 * shown. A reporter who only suggested a setup left an empty note: that shows
 * as a suggested setup instead ({@link suggestedSetupGroups}).
 */
export function reviewNotes(waiting: readonly DirectoryReport[]): { key: string; note: string }[] {
  return waiting
    .flatMap((report) =>
      report.notes.map((note, index) => ({ key: `${report.uuid}:${index}`, note: note.note, at: note.createdAt })),
    )
    .filter(({ note }) => note.trim().length > 0)
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
    .map(({ key, note }) => ({ key, note }));
}

/** One setup climbers suggested, and how many of them did. */
export type SuggestedSetupGroup = {
  /** Stable for the setup: layout, size, sets in canonical order, angle. */
  key: string;
  setup: BoardSetup;
  count: number;
};

/** The board's setup as it is now, to leave out a suggestion it already matches. */
export type CurrentSetup = { layoutId: number; sizeId: number; setIds: string; angle: number };

function setupKey(setup: { layoutId: number; sizeId: number; setIds: string; angle?: number | null }): string {
  return `${setup.layoutId}:${setup.sizeId}:${normaliseSetIds(setup.setIds)}:${setup.angle ?? ''}`;
}

/** Whether a suggestion asks for nothing the board doesn't already have. */
function matchesCurrent(setup: BoardSetup, current: CurrentSetup): boolean {
  return (
    setup.layoutId === current.layoutId &&
    setup.sizeId === current.sizeId &&
    normaliseSetIds(setup.setIds) === normaliseSetIds(current.setIds) &&
    (setup.angle == null || setup.angle === current.angle)
  );
}

/**
 * The setups reporters suggested on the waiting "Set up wrong" reports, one
 * group per setup: "2 climbers suggested Original · 12×12 · Bolt Ons". Most
 * suggested first, then the most recent. A setup the board already has is left
 * out: there is nothing to use.
 */
export function suggestedSetupGroups(
  waiting: readonly DirectoryReport[],
  current: CurrentSetup,
): SuggestedSetupGroup[] {
  const groups = new Map<string, SuggestedSetupGroup & { latest: number }>();
  for (const report of waiting) {
    if (report.reason !== SETUP_SUGGESTION_REPORT_REASON) continue;
    for (const note of report.notes) {
      const suggested = note.suggestedSetup;
      if (!suggested || matchesCurrent(suggested, current)) continue;
      const key = setupKey(suggested);
      const at = Date.parse(note.createdAt);
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
        existing.latest = Math.max(existing.latest, at);
      } else {
        groups.set(key, {
          key,
          setup: {
            layoutId: suggested.layoutId,
            sizeId: suggested.sizeId,
            setIds: normaliseSetIds(suggested.setIds),
            angle: suggested.angle ?? null,
          },
          count: 1,
          latest: at,
        });
      }
    }
  }
  return [...groups.values()]
    .sort((left, right) => right.count - left.count || right.latest - left.latest)
    .map(({ key, setup, count }) => ({ key, setup, count }));
}

/**
 * "Use this setup" as an `updateBoard` input: the layout, size and sets, and
 * the angle only when the suggestion carries one (a board that doesn't tilt).
 * `allowDuplicateConfig` after the climber says it is a different wall from
 * the owner's other board with this setup, as on the edit screen.
 */
export function suggestedSetupUpdateInput(
  boardUuid: string,
  setup: BoardSetup,
  options: { allowDuplicateConfig?: boolean } = {},
): UpdateBoardInput {
  return {
    boardUuid,
    layoutId: setup.layoutId,
    sizeId: setup.sizeId,
    setIds: normaliseSetIds(setup.setIds),
    ...(setup.angle != null ? { angle: setup.angle } : {}),
    ...(options.allowDuplicateConfig ? { allowDuplicateConfig: true } : {}),
  };
}
