// Which grade a climb row puts in its grade column, and whether the community's
// grade also gets a place in the detail line under the name.
//
// A climb can have three grades: the climber's own, the Boardsesh grade, and the
// community consensus. The column shows ONE of them, picked by the app-wide
// grade settings. When that one is not the community's, and the two read
// differently, the community's grade leads the detail line as a plain token
// ("V4 · 1.2k sends · 4.5★ · setterx").
//
// Two leaves of the row need this answer: the grade column and the detail line.
// Both call the one function below, so they can never disagree about which grade
// is big and whether there is a token.
//
// Pure on purpose (no React, no formatting). Callers render each grade for the
// climber's grade format and board, and pass the labels in.
//
// Modelled on `deriveGradeTokenModel` from the unmerged grade-value-composition
// branch, with three changes: it knows the Boardsesh grade as a third number, it
// keeps today's rule for the `person` mark instead of marking every grade of the
// climber's own, and it lives here because its only reader is the mobile row.
import { derivePersonalGradeDisplay } from '@boardsesh/logbook';
import { splitGradeLabel } from '@boardsesh/play-view';
import { ESTIMATE_PREFIX } from './boardsesh-grade-display';

/** Whose grade the column shows. `'none'` when the climb has no grade at all. */
export type ClimbRowGradeSource = 'personal' | 'boardsesh' | 'community' | 'none';

export type ClimbRowGradeLabels = {
  /**
   * The climber's own grade. Null for both "never graded it" and "the logbook
   * has not said yet": an unknown must draw exactly like an ungraded climb
   * rather than guess (#3940).
   */
  personalLabel?: string | null;
  /**
   * The Boardsesh grade, `≈` prefix included when it is an estimate. Null when
   * the climber has Boardsesh grades off, or the climb has no trusted one.
   */
  boardseshLabel?: string | null;
  /** The community consensus grade. Null or empty when nobody has graded the climb. */
  communityLabel?: string | null;
};

export type ClimbRowGrade = {
  source: ClimbRowGradeSource;
  /** The grade for the column. Empty when `source` is `'none'`. */
  label: string;
  /** Whether the column's grade wears the `person` glyph. */
  markedAsMine: boolean;
  /**
   * The community grade for the detail line, or null for no token. Set only when
   * the community has a grade, the column shows another one, and the two read
   * differently.
   */
  communityGradeToken: string | null;
};

function present(label: string | null | undefined): string | null {
  return label == null || label === '' ? null : label;
}

/** A label as it reads: an estimated Boardsesh grade is the same number with a `≈` in front. */
function withoutEstimatePrefix(label: string): string {
  return label.startsWith(ESTIMATE_PREFIX) ? label.slice(ESTIMATE_PREFIX.length) : label;
}

/**
 * The column's grade, its mark, and the detail line's token.
 *
 * The column: the climber's own grade, else the Boardsesh grade, else the
 * community's. The `person` mark follows `derivePersonalGradeDisplay`, unchanged:
 * the climber's grade is marked when it reads differently from the grade it
 * replaced, or when it replaced nothing.
 *
 * The token compares RENDERED LABELS, never difficulty ids, for the reason that
 * function gives: several ids render to one label (4a, 4b and 4c are all "V0"),
 * and a token repeating the column would be a second number stating no
 * difference. The `≈` on an estimated Boardsesh grade is not a difference
 * either. Labels are compared whole, so the answer follows the climber's grade
 * format; under the "V5 / 6C" format the token then shows only its V half, which
 * keeps it on the column's scale and costs the line no extra width.
 *
 * A climb nobody has graded (a Project) never gets a token: with no label in the
 * column there is no community grade to show.
 */
export function deriveClimbRowGrade({
  personalLabel,
  boardseshLabel,
  communityLabel,
}: ClimbRowGradeLabels): ClimbRowGrade {
  const personal = present(personalLabel);
  const boardsesh = present(boardseshLabel);
  const community = present(communityLabel);
  // What the column shows for a climber with no grade of their own.
  const crowd = boardsesh ?? community;
  const label = personal ?? crowd;
  if (label === null) return { source: 'none', label: '', markedAsMine: false, communityGradeToken: null };

  const source: ClimbRowGradeSource = personal !== null ? 'personal' : boardsesh !== null ? 'boardsesh' : 'community';
  // All three: the community has a grade, the column shows another one, and the
  // two read differently.
  const hasCommunityToken = community !== null && source !== 'community' && withoutEstimatePrefix(label) !== community;

  return {
    source,
    label,
    // Never set without a grade of the climber's own: that function marks nothing then.
    markedAsMine: derivePersonalGradeDisplay(personal, crowd).markPrimary,
    communityGradeToken: hasCommunityToken ? splitGradeLabel(community)[0] : null,
  };
}
