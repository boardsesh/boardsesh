import type { BoardName } from '@boardsesh/shared-schema';
import type { GradeDisplayFormat } from '@boardsesh/play-view';
import {
  renderDifficulty,
  resolveDisplayGrade,
  type DisplayGrade,
  type RenderedGrade,
} from '../lib/boardsesh-grade-display';
import { deriveClimbRowGrade, type ClimbRowGrade } from '../lib/climb-row-grade';
import { useDisplayGrade } from './use-display-grade';
import { useGradeFormat } from './use-grade-format';
import { useMyGrade } from './use-my-grade';

export type ClimbRowCrowdGradeFields = {
  /** Every label is formatted for this board: MoonBoard has a scale of its own. */
  boardName: BoardName;
  /**
   * The community's difficulty, live from the stats store. The caller owns that
   * subscription, so these hooks never add a stats subscriber of their own.
   */
  difficulty: string | null;
  boardseshDifficulty: number | null | undefined;
  boardseshConfidence: string | null | undefined;
};

export type ClimbRowGradeFields = ClimbRowCrowdGradeFields & {
  climbUuid: string;
  angle: number;
  /** `Climb.myDifficulty`: undefined when the search projected none, null when it found none. */
  myDifficulty: number | null | undefined;
};

export type ResolvedClimbRowGrade = ClimbRowGrade & {
  /** Ramp colour of the grade in the column: it follows the number shown. */
  color: string;
};

type CrowdGrade = {
  /** What the app-wide settings show a climber with no grade of their own. */
  crowd: DisplayGrade;
  communityLabel: string;
  gradeFormat: GradeDisplayFormat;
};

/** The grades that need no logbook: the Boardsesh grade (when active) and the community's. */
function useCrowdGrade({
  boardName,
  difficulty,
  boardseshDifficulty,
  boardseshConfidence,
}: ClimbRowCrowdGradeFields): CrowdGrade {
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

  return { crowd, communityLabel, gradeFormat };
}

/** The one place the labels meet the rule, so every caller below gets the same answer from the same inputs. */
function resolveClimbRowGrade(
  { crowd, communityLabel }: CrowdGrade,
  mine: RenderedGrade | null,
): ResolvedClimbRowGrade {
  const grade = deriveClimbRowGrade({
    personalLabel: mine?.label,
    boardseshLabel: crowd.isBoardsesh ? crowd.label : null,
    communityLabel,
  });

  return { ...grade, color: grade.source === 'personal' && mine ? mine.color : crowd.color };
}

/**
 * A climb row's grade: the one for the column, its mark, the community grade
 * token for the detail line, and the set-angle marker's place.
 *
 * The row's grade column and its detail line both call this with the same
 * fields, and the answer comes from the one rule in `deriveClimbRowGrade`, so
 * the two cannot disagree.
 *
 * This is a LOGBOOK SUBSCRIBER (through `useMyGrade`): it re-renders its caller
 * on every tick merge. Call it only from a memoised leaf over primitive props,
 * never from the row itself.
 */
export function useClimbRowGrade(fields: ClimbRowGradeFields): ResolvedClimbRowGrade {
  const crowdGrade = useCrowdGrade(fields);
  // Your grade wins over the crowd's (#4796, #4828). Resolved ABOVE
  // `resolveGrade` rather than inside it: that resolver's contract is
  // community-grade-only (its `boardseshDifficulty`/`boardseshConfidence`
  // fields must only ever accompany a community grade), and its own docblock
  // says a caller holding a user grade has to check it first.
  // The row's own `myDifficulty` is the number the search filtered and sorted it
  // by. It stands in until the logbook resolves this climb — which offline it
  // never does — so the label always agrees with the band the row sits in.
  const myGrade = useMyGrade(fields.climbUuid, fields.angle, { rowDifficulty: fields.myDifficulty });
  const mine =
    myGrade.status === 'set' ? renderDifficulty(myGrade.difficultyId, crowdGrade.gradeFormat, fields.boardName) : null;

  return resolveClimbRowGrade(crowdGrade, mine);
}

/**
 * `useClimbRowGrade` for a climber who cannot have a grade of their own: the
 * same rule over the same fields, with no logbook subscription.
 *
 * Only for a caller that knows personal grades are inactive. `useMyGrade`
 * reports no grade then, so the two hooks give the same answer and this one
 * spares the row a leaf that re-renders on every tick merge for nothing.
 */
export function useClimbRowCrowdGrade(fields: ClimbRowCrowdGradeFields): ResolvedClimbRowGrade {
  return resolveClimbRowGrade(useCrowdGrade(fields), null);
}
