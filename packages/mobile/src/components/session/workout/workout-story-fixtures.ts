// One workout session, end to end, for the #6903 stories and tests: a warm-up
// of 4 climbs V1–V3 (all sent, 3 flashed), a 4x4 at V4 (4 reps × 4 sets: 9 sent,
// 7 attempts) and a cool-down of 3 climbs (2 sent, 1 skipped), climbed in 74
// minutes: 15 sends, 3 flashes, 22 ticks. Imported by stories and tests only.

import type { SessionDetailTick, SessionFeedItem, SessionSummary } from '@boardsesh/shared-schema';
import type {
  SessionWorkoutView,
  WorkoutClimbView,
  WorkoutHeadlineView,
  WorkoutRepOutcome,
  WorkoutStageView,
} from './types';

export const STORY_USER_ID = 'story-user';
export const STORY_SESSION_ID = 'story-summary-workout';
const ANGLE = 40;

// Kilter difficulty ids, so the span orders by difficulty and the tick rows draw
// their grade pills.
const GRADES = {
  V1: { grade: 'V1', difficulty: 13 },
  V2: { grade: 'V2', difficulty: 15 },
  V3: { grade: 'V3', difficulty: 16 },
  V4: { grade: 'V4', difficulty: 18 },
} as const;

type GradeKey = keyof typeof GRADES;

function climb(
  queueItemUuid: string,
  climbUuid: string,
  name: string,
  gradeKey: GradeKey,
  reps: WorkoutRepOutcome[],
): WorkoutClimbView {
  return {
    queueItemUuid,
    climbUuid,
    angle: ANGLE,
    reps,
    skipped: reps.length === 0,
    // The derivation's tick map: the uuids `storyDetailTicks` gives these reps.
    tickUuids: reps.map((_, index) => `t-${queueItemUuid}-${index}`),
    name,
    ...GRADES[gradeKey],
    boardType: 'kilter',
    layoutId: 1,
  };
}

function tally(climbs: WorkoutClimbView[]): WorkoutStageView['tally'] {
  let sent = 0;
  let attempts = 0;
  let skipped = 0;
  for (const item of climbs) {
    if (item.skipped) skipped += 1;
    for (const rep of item.reps) {
      if (rep === 'attempt') attempts += 1;
      else sent += 1;
    }
  }
  return { sent, attempts, skipped, climbs: climbs.length };
}

function stage(fields: Omit<WorkoutStageView, 'tally'>): WorkoutStageView {
  return { ...fields, tally: tally(fields.climbs) };
}

const SEND: WorkoutRepOutcome = 'send';
const FLASH: WorkoutRepOutcome = 'flash';
const ATTEMPT: WorkoutRepOutcome = 'attempt';

export const WARM_UP = stage({
  id: 'stage-warm-up',
  kind: 'warmUp',
  isCoolDown: false,
  climbs: [
    climb('q-w1', 'c-jug-haul', 'Jug Haul', 'V1', [FLASH]),
    climb('q-w2', 'c-easy-tiger', 'Easy Tiger', 'V2', [FLASH]),
    climb('q-w3', 'c-pinch-me', 'Pinch Me', 'V2', [SEND]),
    climb('q-w4', 'c-slopey-joe', 'Slopey Joe', 'V3', [FLASH]),
  ],
});

export const FOUR_BY_FOUR = stage({
  id: 'stage-4x4',
  kind: 'fourByFour',
  isCoolDown: false,
  targetGrade: 'V4',
  repsPerSet: 4,
  sets: 4,
  restSeconds: 180,
  climbs: [
    climb('q-m1', 'c-crimp-lord', 'Crimp Lord', 'V4', [SEND, SEND, SEND, ATTEMPT]),
    climb('q-m2', 'c-undercling-city', 'Undercling City', 'V4', [SEND, SEND, ATTEMPT, ATTEMPT]),
    climb('q-m3', 'c-the-pocket', 'The Pocket', 'V4', [SEND, SEND, SEND, ATTEMPT]),
    climb('q-m4', 'c-heel-yeah', 'Heel Yeah', 'V4', [SEND, ATTEMPT, ATTEMPT, ATTEMPT]),
  ],
});

export const COOL_DOWN = stage({
  id: 'stage-cool-down',
  kind: 'warmUp',
  isCoolDown: true,
  climbs: [
    climb('q-c1', 'c-slopey-joe', 'Slopey Joe', 'V3', [SEND]),
    climb('q-c2', 'c-easy-tiger', 'Easy Tiger', 'V2', [SEND]),
    climb('q-c3', 'c-jug-haul', 'Jug Haul', 'V1', []),
  ],
});

export const STORY_WORKOUT: SessionWorkoutView = {
  userId: STORY_USER_ID,
  stages: [WARM_UP, FOUR_BY_FOUR, COOL_DOWN],
  offPlan: 1,
  offPlanTickUuids: ['t-off-plan'],
};

/** The other kinds, one block each, for the row story. */
export const OTHER_KIND_STAGES: WorkoutStageView[] = [
  stage({
    id: 'stage-otm',
    kind: 'onTheMinute',
    isCoolDown: false,
    targetGrade: 'V3',
    intervalSeconds: 60,
    climbs: [
      climb('q-o1', 'c-o1', 'Tick Tock', 'V3', [SEND]),
      climb('q-o2', 'c-o2', 'Minute Man', 'V3', [SEND]),
      climb('q-o3', 'c-o3', 'Clockwork', 'V3', [ATTEMPT]),
      climb('q-o4', 'c-o4', 'Second Hand', 'V3', [SEND]),
      climb('q-o5', 'c-o5', 'Pendulum', 'V3', [FLASH]),
      climb('q-o6', 'c-o6', 'Alarm', 'V3', []),
    ],
  }),
  stage({
    id: 'stage-pyramid',
    kind: 'pyramid',
    isCoolDown: false,
    targetGrade: 'V4',
    climbs: [
      climb('q-p1', 'c-p1', 'Base Camp', 'V2', [FLASH]),
      climb('q-p2', 'c-p2', 'Ridge Line', 'V3', [SEND]),
      climb('q-p3', 'c-p3', 'Summit', 'V4', [ATTEMPT, ATTEMPT, SEND]),
      climb('q-p4', 'c-p4', 'Descent', 'V3', [SEND]),
      climb('q-p5', 'c-p5', 'Valley', 'V2', [SEND]),
    ],
  }),
  stage({
    id: 'stage-limit',
    kind: 'limitBouldering',
    isCoolDown: false,
    targetGrade: 'V4',
    climbs: [
      climb('q-l1', 'c-l1', 'Project X', 'V4', [ATTEMPT, ATTEMPT, ATTEMPT, ATTEMPT]),
      climb('q-l2', 'c-l2', 'The Big One', 'V4', [ATTEMPT, ATTEMPT, SEND]),
    ],
  }),
  stage({
    id: 'stage-future',
    kind: 'campusLadder',
    isCoolDown: false,
    climbs: [climb('q-f1', 'c-f1', 'Rungs', 'V3', [SEND])],
  }),
];

/** Long names and a tally that can't share a line with them. */
export const LONG_STAGE = stage({
  id: 'stage-long',
  kind: 'fourByFour',
  isCoolDown: false,
  targetGrade: '7A+/V7',
  repsPerSet: 4,
  sets: 3,
  climbs: [
    climb('q-x1', 'c-x1', 'Die unendliche Geschichte des Leistenkletterns', 'V4', [SEND, ATTEMPT, ATTEMPT, ATTEMPT]),
    climb('q-x2', 'c-x2', 'Überhängende Sloper-Traverse', 'V4', [SEND, SEND, ATTEMPT, ATTEMPT]),
    climb('q-x3', 'c-x3', 'Kurz', 'V4', []),
  ],
});

export const STORY_SUMMARY: SessionSummary = {
  sessionId: STORY_SESSION_ID,
  totalSends: 15,
  totalFlashes: 3,
  totalAttempts: 22,
  gradeDistribution: [
    { grade: 'V1', count: 1, flash: 1, send: 0, attempt: 0 },
    { grade: 'V2', count: 3, flash: 1, send: 2, attempt: 0 },
    { grade: 'V3', count: 2, flash: 1, send: 1, attempt: 0 },
    { grade: 'V4', count: 16, flash: 0, send: 9, attempt: 7 },
  ],
  hardestClimb: { climbUuid: 'c-crimp-lord', climbName: 'Crimp Lord', grade: 'V4', boardType: 'kilter' },
  participants: [{ userId: STORY_USER_ID, displayName: 'Marco', avatarUrl: null, sends: 15, flashes: 3, attempts: 22 }],
  startedAt: '2026-10-26T07:30:00.000Z',
  endedAt: '2026-10-26T08:44:00.000Z',
  durationMinutes: 74,
  goal: null,
  notes: null,
};

/** The same session the moment it ends, before any of its ticks reached the server. */
export const STORY_SUMMARY_UNSYNCED: SessionSummary = {
  ...STORY_SUMMARY,
  sessionId: 'story-summary-workout-saving',
  totalSends: 0,
  totalFlashes: 0,
  totalAttempts: 0,
  gradeDistribution: [],
  hardestClimb: null,
  participants: [{ userId: STORY_USER_ID, displayName: 'Marco', avatarUrl: null, sends: 0, flashes: 0, attempts: 0 }],
};

const STATUS: Record<WorkoutRepOutcome, string> = { flash: 'flash', send: 'send', attempt: 'attempt' };

/** The owner's 22 ticks in climbing order, a minute apart, plus one off-plan tick. */
export function storyDetailTicks(): SessionDetailTick[] {
  const ticks: SessionDetailTick[] = [];
  let minute = 0;
  const add = (item: WorkoutClimbView, rep: WorkoutRepOutcome, uuid: string, userId = STORY_USER_ID) => {
    minute += 2;
    ticks.push({
      uuid,
      userId,
      climbUuid: item.climbUuid,
      climbName: item.name,
      boardType: 'kilter',
      layoutId: 1,
      angle: item.angle,
      status: STATUS[rep],
      attemptCount: 1,
      difficulty: item.difficulty ?? null,
      difficultyName: null,
      isMirror: false,
      isBenchmark: false,
      isNoMatch: false,
      climbedAt: new Date(Date.parse('2026-10-26T07:30:00.000Z') + minute * 60_000).toISOString(),
      upvotes: 0,
    });
  };
  for (const block of STORY_WORKOUT.stages) {
    for (const item of block.climbs) {
      item.reps.forEach((rep, index) => add(item, rep, `t-${item.queueItemUuid}-${index}`));
    }
  }
  const offPlan: WorkoutClimbView = climb('q-off', 'c-off-plan', 'Bonus Round', 'V3', [SEND]);
  add(offPlan, 'send', 't-off-plan');
  return ticks;
}

export const STORY_HEADLINE: WorkoutHeadlineView = {
  mainKind: 'fourByFour',
  mainTargetGrade: 'V4',
  blockCount: 3,
  extraMainBlocks: 0,
};

export const STORY_HEADLINE_TWO: WorkoutHeadlineView = {
  mainKind: 'fourByFour',
  mainTargetGrade: 'V4',
  secondMainKind: 'pyramid',
  blockCount: 4,
  extraMainBlocks: 1,
};

export const STORY_HEADLINE_MORE: WorkoutHeadlineView = {
  mainKind: 'fourByFour',
  mainTargetGrade: 'V4',
  blockCount: 5,
  extraMainBlocks: 2,
};

export const STORY_FEED_SESSION: SessionFeedItem = {
  sessionId: STORY_SESSION_ID,
  sessionType: 'party',
  sessionName: null,
  ownerUserId: STORY_USER_ID,
  participants: [{ userId: STORY_USER_ID, displayName: 'Marco', avatarUrl: null, sends: 15, flashes: 3, attempts: 22 }],
  totalSends: 15,
  totalFlashes: 3,
  totalAttempts: 22,
  tickCount: 22,
  gradeDistribution: STORY_SUMMARY.gradeDistribution,
  boardTypes: ['kilter'],
  hardestGrade: 'V4',
  hardestSend: null,
  featuredBeta: null,
  socialEntityType: 'session',
  socialEntityId: STORY_SESSION_ID,
  firstTickAt: '2026-10-26T07:32:00.000Z',
  lastTickAt: '2026-10-26T08:44:00.000Z',
  durationMinutes: 74,
  goal: null,
  notes: null,
  upvotes: 4,
  downvotes: 0,
  voteScore: 4,
  commentCount: 1,
};
