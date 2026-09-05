// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * Pure display rules for a logbook row's meta line. The row is a review
 * surface — every rule here answers "what did I do, and how did it go?" — so
 * the decisions (clamps, unset semantics, note visibility) live here where
 * they're unit-testable and shareable with web; the i18n formatting stays in
 * the component.
 */

export type LogbookAttemptsKind = 'flash' | 'send' | 'project';

/** How the attempts part reads: a flash, a send with tries, or a project. */
export function logbookAttemptsKind(status: 'flash' | 'send' | 'attempt'): LogbookAttemptsKind {
  if (status === 'flash') return 'flash';
  return status === 'send' ? 'send' : 'project';
}

/**
 * Tries shown on the row. Imported ticks can carry 0 — the edit sheet already
 * clamps to 1 on edit (a logged ascent implies at least one attempt); the row
 * displays the same floor rather than "0 tries".
 */
export function displayedAttemptCount(attemptCount: number): number {
  return Math.max(1, attemptCount);
}

/**
 * The climber's OWN star rating, normalised for display. Quality is a 1–5
 * scale; the edit sheet's "clear" saves 0, and older rows carry null — both
 * mean "not rated" and render nothing. Defensive against out-of-range input:
 * rounding FIRST means a sub-half float (0.3) normalises to unset instead of
 * rendering "0★", and anything above 5 clamps.
 */
export function normalizeLogbookQuality(quality: number | null | undefined): number | null {
  if (quality == null) return null;
  const rounded = Math.round(quality);
  if (rounded < 1) return null;
  return Math.min(5, rounded);
}

/**
 * Whether the row shows the note glyph. Comments save untrimmed, so a
 * whitespace-only comment must not show a phantom note marker.
 */
export function logbookNoteIsVisible(comment: string | null | undefined): boolean {
  return !!comment && comment.trim().length > 0;
}
