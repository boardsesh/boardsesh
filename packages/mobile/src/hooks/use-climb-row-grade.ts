import type { BoardName } from '@boardsesh/shared-schema';
import { renderDifficulty, resolveDisplayGrade } from '../lib/boardsesh-grade-display';
import { deriveClimbRowGrade, type ClimbRowGrade } from '../lib/climb-row-grade';
import { useDisplayGrade } from './use-display-grade';
import { useGradeFormat } from './use-grade-format';
import { useMyGrade } from './use-my-grade';

export type ClimbRowGradeFields = {
  climbUuid: string;
  angle: number;
  /** Every label is formatted for this board: MoonBoard has a scale of its own. */
  boardName: BoardName;
  /**
   * The community's difficulty, live from the stats store. The caller owns that
   * subscription, so this hook never adds a stats subscriber of its own.
   */
  difficulty: string | null;
  /** `Climb.myDifficulty`: undefined when the search projected none, null when it found none. */
  myDifficulty: number | null | undefined;
  boardseshDifficulty: number | null | undefined;
  boardseshConfidence: string | null | undefined;
};

export type ResolvedClimbRowGrade = ClimbRowGrade & {
  /** Ramp colour of the grade in the column: it follows the number shown. */
  color: string;
};

/**
 * A climb row's grade: the one for the column, its mark, and the community
 * grade token for the detail line.
 *
 * The row's grade column and its detail line both call this with the same
 * fields, and the answer comes from the one rule in `deriveClimbRowGrade`, so
 * the two cannot disagree.
 *
 * This is a LOGBOOK SUBSCRIBER (through `useMyGrade`): it re-renders its caller
 * on every tick merge. Call it only from a memoised leaf over primitive props,
 * never from the row itself.
 */
export function useClimbRowGrade({
  climbUuid,
  angle,
  boardName,
  difficulty,
  myDifficulty,
  boardseshDifficulty,
  boardseshConfidence,
}: ClimbRowGradeFields): ResolvedClimbRowGrade {
  const { resolveGrade } = useDisplayGrade();
  const { gradeFormat } = useGradeFormat();
  // The canonical community difficulty may change, but the Boardsesh grade
  // fields remain authoritative when that preference is active.
  const crowd = resolveGrade({ difficulty, boardseshDifficulty, boardseshConfidence }, boardName);
  // The community's own grade is that resolver's branch for a climber with
  // Boardsesh grades off. Asked for again only when the first answer was a
  // Boardsesh grade, so the label is formatted by the same code either way.
  const communityLabel = crowd.isBoardsesh
    ? resolveDisplayGrade({ difficulty }, { useBoardseshGrades: false, gradeFormat, boardName }).label
    : crowd.label;

  // Your grade wins over the crowd's (#4796, #4828). Resolved ABOVE
  // `resolveGrade` rather than inside it: that resolver's contract is
  // community-grade-only (its `boardseshDifficulty`/`boardseshConfidence`
  // fields must only ever accompany a community grade), and its own docblock
  // says a caller holding a user grade has to check it first.
  // The row's own `myDifficulty` is the number the search filtered and sorted it
  // by. It stands in until the logbook resolves this climb — which offline it
  // never does — so the label always agrees with the band the row sits in.
  const myGrade = useMyGrade(climbUuid, angle, { rowDifficulty: myDifficulty });
  const mine = myGrade.status === 'set' ? renderDifficulty(myGrade.difficultyId, gradeFormat, boardName) : null;

  const grade = deriveClimbRowGrade({
    personalLabel: mine?.label,
    boardseshLabel: crowd.isBoardsesh ? crowd.label : null,
    communityLabel,
  });

  return { ...grade, color: grade.source === 'personal' && mine ? mine.color : crowd.color };
}
