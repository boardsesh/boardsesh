import { describe, expect, it } from 'vitest';
import { CPP_STORY_SCENES, CPP_STORY_TARGETS, type CppStoryTarget } from '../cpp-scenes';
import { createCppStoryPresentation } from '../cpp-presentation';
import { buildStoryAscents } from '../ascents';
import { STORY_BOARDS } from '../boards';
import { getBoulderGradesForBoard } from '@boardsesh/board-constants/boulder-grade-mapping';
import { buildStoryWorkout } from '../workout';

describe('CPP scene board identity', () => {
  it.each(Object.keys(CPP_STORY_TARGETS) as CppStoryTarget[])(
    '%s keeps its primary geometry in every scene',
    (target) => {
      const primary = STORY_BOARDS[CPP_STORY_TARGETS[target].boardId];
      for (const scene of CPP_STORY_SCENES[target]) {
        const presentation = createCppStoryPresentation(target, scene);
        expect(presentation.board).toBe(primary.board);
        expect(presentation.spray).toBe(primary.spray);
        expect(presentation.climbs.length).toBeGreaterThan(0);
        for (const climb of presentation.climbs) expect(primary.climbs).toContain(climb);
        for (const ascent of buildStoryAscents(presentation)) {
          expect(ascent.boardType).toBe(primary.board.boardName);
          expect(ascent.renderBoard).toEqual({
            layoutId: primary.board.layoutId,
            sizeId: primary.board.sizeId,
            setIds: primary.board.setIds.split(',').map(Number),
          });
        }
      }
    },
  );
  it('shows MoonBoard attempts without silently applying that state to other targets', () => {
    expect(
      buildStoryAscents(createCppStoryPresentation('moonboard', 'logbook')).every(
        (ascent) => ascent.status === 'attempt',
      ),
    ).toBe(true);
    for (const target of ['kilter', 'tension', 'spray'] as const) {
      expect(createCppStoryPresentation(target, 'logbook').attemptsOnly).toBe(false);
    }
  });
  it.each(Object.keys(CPP_STORY_TARGETS) as CppStoryTarget[])(
    '%s workout grade and count agree with every preview row',
    (target) => {
      const presentation = createCppStoryPresentation(target, 'workout');
      const workout = buildStoryWorkout(presentation);
      const selectedGrade = getBoulderGradesForBoard(presentation.board.boardName).find(
        (grade) => grade.difficulty_id === workout.targetGrade,
      );
      expect(workout.requestedCount).toBe(workout.climbs.length);
      expect(workout.requestedCount).toBeGreaterThan(0);
      for (const climb of workout.climbs)
        expect(climb.difficulty?.toLowerCase()).toBe(selectedGrade?.difficulty_name.toLowerCase());
    },
  );
  it('filters the MoonBoard search sample to the selected grade range, leaving its queue intact', () => {
    const search = createCppStoryPresentation('moonboard', 'search');
    const grades = getBoulderGradesForBoard('moonboard');
    expect(grades.find((grade) => grade.difficulty_id === search.gradeRange?.minGrade)?.v_grade).toBe('V4');
    expect(grades.find((grade) => grade.difficulty_id === search.gradeRange?.maxGrade)?.v_grade).toBe('V7');
    for (const climb of search.climbs) {
      const grade = Number(/V(\d+)/.exec(climb.difficulty ?? '')?.[1]);
      expect(grade).toBeGreaterThanOrEqual(4);
      expect(grade).toBeLessThanOrEqual(7);
    }
    const queue = createCppStoryPresentation('moonboard', 'queue');
    expect(queue.gradeRange).toBeUndefined();
    expect(queue.climbs).toBe(STORY_BOARDS['moonboard-2024'].climbs);
  });
});
