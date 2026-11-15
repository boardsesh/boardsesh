import { getBoulderGradesForBoard } from '@boardsesh/board-constants/boulder-grade-mapping';
import type { StoryBoardFixture } from './boards';

/** A small volume set whose selected grade and requested count match its actual rows. */
export function buildStoryWorkout(fixture: StoryBoardFixture) {
  const grades = getBoulderGradesForBoard(fixture.board.boardName);
  const gradeFor = (difficulty: string | null | undefined) =>
    grades.find((grade) => grade.difficulty_name.toLowerCase() === difficulty?.toLowerCase())?.difficulty_id;
  const targetGrade = gradeFor(fixture.climbs[0]?.difficulty);
  if (targetGrade === undefined) throw new Error('Workout story requires a known climb grade');
  const climbs = fixture.climbs.filter((climb) => gradeFor(climb.difficulty) === targetGrade).slice(0, 3);
  return { targetGrade, climbs, requestedCount: climbs.length };
}
