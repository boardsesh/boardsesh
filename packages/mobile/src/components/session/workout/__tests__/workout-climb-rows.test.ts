import { describe, expect, it } from 'vitest';
import type { SessionDetailTick } from '@boardsesh/shared-schema';
import { buildWorkoutClimbRows, type WorkoutClimbsRow } from '../workout-climb-rows';
import type { SessionWorkoutView } from '../types';
import { STORY_WORKOUT, storyDetailTicks } from '../workout-story-fixtures';

function describeRow(row: WorkoutClimbsRow): string {
  switch (row.type) {
    case 'block':
      return `block ${row.stage.id}`;
    case 'tick':
      return `tick ${row.tick.uuid}`;
    case 'set':
      return `set ${row.setNumber} ${row.climb.name} ${row.tick?.uuid ?? 'none'}`;
    case 'climb':
      return `climb ${row.climb.name}`;
    case 'offPlan':
      return `offPlan ${row.count}`;
    case 'crew':
      return `crew ${row.count}`;
  }
}

/** The same workout as an older payload without the derivation's tick map. */
function withoutTickMap(workout: SessionWorkoutView): SessionWorkoutView {
  return {
    ...workout,
    offPlanTickUuids: undefined,
    stages: workout.stages.map((stage) => ({
      ...stage,
      climbs: stage.climbs.map((climb) => ({ ...climb, tickUuids: undefined })),
    })),
  };
}

function rowsOf(ticks: readonly SessionDetailTick[], workout: SessionWorkoutView): string[] {
  return buildWorkoutClimbRows(ticks, workout).rows.map(describeRow);
}

const MEMBER_ROW = /^(tick|set|climb) /;

/** The rows under one block's section row. */
function blockRows(rows: string[], stageId: string): string[] {
  const start = rows.indexOf(`block ${stageId}`);
  const end = rows.findIndex((row, index) => index > start && !MEMBER_ROW.test(row));
  return rows.slice(start + 1, end === -1 ? undefined : end);
}

const GROUPED = [
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
  'tick t-q-c1-0',
  'tick t-q-c2-0',
  'climb Jug Haul',
  'offPlan 1',
  'tick t-off-plan',
];

describe('buildWorkoutClimbRows with the tick map', () => {
  it('groups ticks by block, one row per 4x4 set, and the rest off plan', () => {
    // Newest first, the way the server lists them: grouping must not depend on it.
    expect(rowsOf(storyDetailTicks().reverse(), STORY_WORKOUT)).toEqual(GROUPED);
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

  it('assigns by uuid alone, wherever climb matching would put the tick', () => {
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
    const rows = rowsOf(storyDetailTicks(), workout);
    expect(blockRows(rows, 'stage-cool-down')).toEqual([
      'tick t-q-w4-0',
      'tick t-q-c1-0',
      'tick t-q-c2-0',
      'climb Jug Haul',
    ]);
    // The warm-up's Slopey Joe keeps its row, saying what its tally counted.
    expect(blockRows(rows, 'stage-warm-up').at(-1)).toBe('climb Slopey Joe');
  });

  it("puts every tick outside the map under the crew, even on the owner's climbs", () => {
    const ticks = storyDetailTicks();
    // A crewmate repeats the warm-up's first climb at the same angle, and the
    // warm-up still has room for it by rep count: only the map keeps it out.
    const crewTick = { ...ticks[0]!, uuid: 't-crew', userId: 'someone-else' };
    const workout = {
      ...STORY_WORKOUT,
      stages: STORY_WORKOUT.stages.map((stage) => ({
        ...stage,
        climbs: stage.climbs.map((climb) =>
          climb.queueItemUuid === 'q-w1' ? { ...climb, reps: [...climb.reps, 'send' as const] } : climb,
        ),
      })),
    };
    const rows = rowsOf([...ticks, crewTick], workout);
    expect(blockRows(rows, 'stage-warm-up')).toEqual(GROUPED.slice(1, 5));
    expect(rows.slice(-2)).toEqual(['crew 1', 'tick t-crew']);
  });

  it('still lists a planned climb whose ticks the viewer cannot see', () => {
    // Pinch Me's send is counted in the tally, but its tick is hidden here.
    const ticks = storyDetailTicks().filter((tick) => tick.uuid !== 't-q-w3-0');
    expect(blockRows(rowsOf(ticks, STORY_WORKOUT), 'stage-warm-up')).toEqual([
      'tick t-q-w1-0',
      'tick t-q-w2-0',
      'climb Pinch Me',
      'tick t-q-w4-0',
    ]);
  });
});

describe('buildWorkoutClimbRows without the tick map', () => {
  const legacy = withoutTickMap(STORY_WORKOUT);

  it('fills a climb repeated in the warm-up and cool-down block by block', () => {
    // Slopey Joe and Easy Tiger are in both: the warm-up takes the one tick it
    // logged on each, and the later tick goes on to the cool-down.
    expect(rowsOf(storyDetailTicks().reverse(), legacy)).toEqual(GROUPED);
  });

  it('passes over a warm-up climb with no reps to the cool-down that logged it', () => {
    const workout: SessionWorkoutView = {
      ...legacy,
      stages: legacy.stages.map((stage) => ({
        ...stage,
        climbs: stage.climbs.map((climb) =>
          climb.queueItemUuid === 'q-w4' ? { ...climb, reps: [], skipped: true } : climb,
        ),
      })),
    };
    const ticks = storyDetailTicks().filter((tick) => tick.uuid !== 't-q-w4-0');
    const rows = rowsOf(ticks, workout);
    expect(blockRows(rows, 'stage-warm-up').at(-1)).toBe('climb Slopey Joe');
    expect(blockRows(rows, 'stage-cool-down')[0]).toBe('tick t-q-c1-0');
  });

  it("never matches another climber's tick to the owner's plan", () => {
    const ticks = storyDetailTicks();
    const crewTick = { ...ticks[0]!, uuid: 't-crew', userId: 'someone-else' };
    expect(rowsOf([...ticks, crewTick], legacy).slice(-2)).toEqual(['crew 1', 'tick t-crew']);
  });
});
