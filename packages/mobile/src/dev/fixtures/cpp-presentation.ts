import { CPP_STORY_TARGETS, type CppStoryTarget } from './cpp-scenes';
import { STORY_BOARDS } from './boards';
import type { StoryBoardPresentation } from '../stories/story-board-fixture';
import { getBoulderGradesForBoard } from '@boardsesh/board-constants/boulder-grade-mapping';

/** Exact board fixtures plus intentionally selected local view state. No replay provenance. */
export function createCppStoryPresentation(target: CppStoryTarget, scene: string): StoryBoardPresentation {
  const { boardId, label } = CPP_STORY_TARGETS[target];
  const fixture = STORY_BOARDS[boardId];
  const grades = getBoulderGradesForBoard(fixture.board.boardName);
  const minimum = grades.find((grade) => grade.v_grade === 'V4')!;
  const maximum = grades.findLast((grade) => grade.v_grade === 'V7')!;
  const gradeRange =
    target === 'moonboard' && scene === 'search'
      ? {
          minGrade: minimum.difficulty_id,
          maxGrade: maximum.difficulty_id,
          label: `${minimum.v_grade}–${maximum.v_grade}`,
        }
      : undefined;
  const climbs = gradeRange
    ? fixture.climbs.filter((climb) => {
        const grade = /V(\d+)/.exec(climb.difficulty ?? '')?.[1];
        return grade !== undefined && Number(grade) >= 4 && Number(grade) <= 7;
      })
    : fixture.climbs;
  if (!climbs.length) throw new Error(`No ${target} story climbs for ${scene}`);
  return { ...fixture, climbs, label, gradeRange, attemptsOnly: target === 'moonboard' && scene === 'logbook' };
}
