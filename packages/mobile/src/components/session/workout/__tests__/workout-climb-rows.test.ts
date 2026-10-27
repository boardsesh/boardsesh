import { describe, expect, it } from 'vitest';
import { buildWorkoutClimbRows, type WorkoutClimbsRow } from '../workout-climb-rows';
import { STORY_WORKOUT, storyDetailTicks } from '../workout-story-fixtures';

function describeRow(row: WorkoutClimbsRow): string {
  switch (row.type) {
    case 'block':
      return `block ${row.stage.id}`;
    case 'tick':
      return `tick ${row.tick.uuid}`;
    case 'set':
      return `set ${row.setNumber} ${row.climb.name} ${row.tick?.uuid ?? 'none'}`;
    case 'skipped':
      return `skipped ${row.climb.name}`;
    case 'offPlan':
      return `offPlan ${row.count}`;
    case 'crew':
      return `crew ${row.count}`;
  }
}

describe('buildWorkoutClimbRows', () => {
  it('groups ticks by block, one row per 4x4 set, and the rest off plan', () => {
    // Newest first, the way the server lists them: grouping must not depend on it.
    const ticks = storyDetailTicks().reverse();
    const { rows } = buildWorkoutClimbRows(ticks, STORY_WORKOUT);

    expect(rows.map(describeRow)).toEqual([
      'block stage-warm-up',
      'tick t-q-w1-0',
      'tick t-q-w2-0',
      'tick t-q-w3-0',
      'tick t-q-w4-0',
      'block stage-4x4',
      'set 1 Crimp Lord t-q-m1-0',
      'set 2 Undercling City t-q-m2-0',
      'set 3 The Pocket t-q-m3-0',
      'set 4 Heel Yeah t-q-m4-0',
      'block stage-cool-down',
      // Slopey Joe and Easy Tiger are in the warm-up too: the second tick on
      // each lands here because the warm-up's one rep is already filled.
      'tick t-q-c1-0',
      'tick t-q-c2-0',
      'skipped Jug Haul',
      'offPlan 1',
      'tick t-off-plan',
    ]);
  });

  it('plays the ticks in list order', () => {
    const { orderedTicks } = buildWorkoutClimbRows(storyDetailTicks(), STORY_WORKOUT);
    expect(orderedTicks.map((tick) => tick.uuid)).toEqual([
      't-q-w1-0',
      't-q-w2-0',
      't-q-w3-0',
      't-q-w4-0',
      't-q-m1-0',
      't-q-m2-0',
      't-q-m3-0',
      't-q-m4-0',
      't-q-c1-0',
      't-q-c2-0',
      't-off-plan',
    ]);
  });

  it('trusts the stored tick map over climb matching', () => {
    const ticks = storyDetailTicks();
    // Say the warm-up's Slopey Joe flash was really the cool-down's.
    const workout = {
      ...STORY_WORKOUT,
      stages: STORY_WORKOUT.stages.map((stage) => ({
        ...stage,
        climbs: stage.climbs.map((climb) => {
          if (climb.queueItemUuid === 'q-w4') return { ...climb, tickUuids: [] };
          if (climb.queueItemUuid === 'q-c1') return { ...climb, tickUuids: ['t-q-w4-0', 't-q-c1-0'] };
          return climb;
        }),
      })),
    };
    const { rows } = buildWorkoutClimbRows(ticks, workout);
    const coolDownStart = rows.findIndex((row) => row.type === 'block' && row.stage.id === 'stage-cool-down');
    expect(rows.slice(coolDownStart + 1, coolDownStart + 3).map(describeRow)).toEqual([
      'tick t-q-w4-0',
      'tick t-q-c1-0',
    ]);
  });

  it("puts another climber's ticks under the crew, not off plan", () => {
    const ticks = storyDetailTicks();
    const crewTick = { ...ticks[0]!, uuid: 't-crew', userId: 'someone-else' };
    const { rows } = buildWorkoutClimbRows([...ticks, crewTick], STORY_WORKOUT);
    expect(rows.slice(-2).map(describeRow)).toEqual(['crew 1', 'tick t-crew']);
  });
});
