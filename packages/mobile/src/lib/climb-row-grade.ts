// Which grade a climb row puts in its grade column, and what else the row says
// about grades: the `person` mark, the community grade token in the detail line
// under the name, and where the "set at N°" marker sits.
//
// A climb can have three grades: the climber's own, the Boardsesh grade, and the
// community consensus. The column shows ONE of them, picked by the app-wide
// grade settings. The detail line can lead with a second one, and that token is
// always the community's ("V4 · 1.2k sends · 4.5★ · setterx").
//
// Two leaves of the row need these answers: the grade column and the detail
// line. Both get them from the one function below, so they can never disagree.
//
// Pure on purpose (no React, no formatting). Callers render each grade for the
// climber's grade format and board, and pass the labels in.
import { derivePersonalGradeDisplay } from '@boardsesh/logbook';
import { splitGradeLabel } from '@boardsesh/play-view';
import { ESTIMATE_PREFIX } from './boardsesh-grade-display';

/** Whose grade the column shows. `'none'` when the climb has no grade at all. */
export type ClimbRowGradeSource = 'personal' | 'boardsesh' | 'community' | 'none';

/** Where a row's "set at N°" marker sits. */
export type ClimbRowSetAngleMarkerPlace = 'gradeColumn' | 'detailLine';

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
  /**
   * Where the row's "set at N°" marker belongs, on a row that has one. The
   * marker says the community's numbers were read at another angle, so it sits
   * with them: under the column's grade while that is the community's or the
   * Boardsesh grade, and in the detail line once the column shows the climber's
   * own, which was logged at the angle on the wall.
   */
  setAngleMarkerPlace: ClimbRowSetAngleMarkerPlace;
};

function present(label: string | null | undefined): string | null {
  return label == null || label === '' ? null : label;
}

/** A label as it reads: an estimated Boardsesh grade is the same number with a `≈` in front. */
function withoutEstimatePrefix(label: string): string {
  return label.startsWith(ESTIMATE_PREFIX) ? label.slice(ESTIMATE_PREFIX.length) : label;
}

/**
 * The community's grade as the detail line shows it beside the column's grade,
 * or null when it would say nothing the column does not.
 *
 * A label is one grade, or two under the "V5 / 6C" format. The token uses
 * only the first (V) half under that format. A matching V half suppresses the
 * token even when the Font halves differ; single-format labels compare whole.
 */
function communityTokenBeside(columnLabel: string, communityLabel: string): string | null {
  const columnHalf = splitGradeLabel(withoutEstimatePrefix(columnLabel))[0];
  const communityHalf = splitGradeLabel(communityLabel)[0];
  return communityHalf !== columnHalf ? (communityHalf ?? null) : null;
}

/**
 * The column's grade, its mark, the detail line's token, and the set-angle
 * marker's place.
 *
 * THE COLUMN shows the climber's own grade, else the Boardsesh grade, else the
 * community's.
 *
 * THE MARK (`person`) says the number in the column is the climber's, not the
 * one this row would otherwise show. So it compares the climber's grade with
 * what it replaced: the Boardsesh grade for a climber with those on, else the
 * community's. It is left off when the two read the same, and put on when there
 * was nothing to replace.
 *
 * THE TOKEN is always the community's grade, never the Boardsesh grade: one
 * token, one meaning, the one its switch is named for. It compares the
 * community's grade with whatever the column shows.
 *
 * With Boardsesh grades on and a grade of the climber's own, those are two
 * different comparisons, on purpose. The row then shows the climber's grade and
 * the community's, and the Boardsesh grade is not on the row at all: it is in
 * the play drawer.
 *
 *   mine V4, Boardsesh V6, community V5:  V4 marked, token V5
 *   mine V4, Boardsesh V5, community V4:  V4 marked, no token
 *   mine V5, Boardsesh ≈V5, community V4: V5 unmarked, token V4
 *
 * Both compare RENDERED LABELS, never difficulty ids: several ids render to one
 * label (4a, 4b and 4c are all "V0"), and a second number stating no difference
 * is noise. For the same reason the `≈` on an estimated Boardsesh grade is not
 * a difference, in either comparison. Comparing labels also makes the answer
 * follow the climber's grade format, with no scale maths here.
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
  if (label === null) {
    return {
      source: 'none',
      label: '',
      markedAsMine: false,
      communityGradeToken: null,
      setAngleMarkerPlace: 'gradeColumn',
    };
  }

  const source: ClimbRowGradeSource = personal !== null ? 'personal' : boardsesh !== null ? 'boardsesh' : 'community';

  return {
    source,
    label,
    // Never set without a grade of the climber's own: that function marks nothing then.
    markedAsMine: derivePersonalGradeDisplay(personal, crowd === null ? null : withoutEstimatePrefix(crowd))
      .markPrimary,
    communityGradeToken: community !== null && source !== 'community' ? communityTokenBeside(label, community) : null,
    setAngleMarkerPlace: source === 'personal' ? 'detailLine' : 'gradeColumn',
  };
}
