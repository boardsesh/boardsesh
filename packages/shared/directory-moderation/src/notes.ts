/**
 * The free-text note a reporter adds, and the note a creator or staff member
 * adds when they keep a board as it is. Both are trimmed, both are capped, and
 * "Something else" needs enough words to act on (the climb-report rule).
 */

/** The longest note a report or a resolution may carry, after trimming. */
export const REPORT_NOTE_MAX_LENGTH = 500;

/** The shortest note "Something else" accepts, after trimming. */
export const OTHER_REASON_NOTE_MIN_LENGTH = 10;

export type ReportNoteProblem = 'too_long' | 'required' | 'too_short';

/** Trim a note; an empty or whitespace-only note is no note. */
export function normalizeReportNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * What is wrong with a reporter's note for this reason, or null when it is
 * fine. The same check runs in the report sheet (to keep Send disabled) and
 * on the server (to refuse the mutation).
 */
export function reportNoteProblem(reason: string, note: string | null | undefined): ReportNoteProblem | null {
  const normalized = normalizeReportNote(note);
  if (normalized !== null && normalized.length > REPORT_NOTE_MAX_LENGTH) return 'too_long';
  if (reason === 'other') {
    if (normalized === null) return 'required';
    if (normalized.length < OTHER_REASON_NOTE_MIN_LENGTH) return 'too_short';
  }
  return null;
}

/** The problem with a resolution note (always optional), or null. */
export function resolutionNoteProblem(note: string | null | undefined): ReportNoteProblem | null {
  const normalized = normalizeReportNote(note);
  return normalized !== null && normalized.length > REPORT_NOTE_MAX_LENGTH ? 'too_long' : null;
}
