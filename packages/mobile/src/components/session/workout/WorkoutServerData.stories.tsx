import type {
  SessionWorkoutHeadlineResult,
  SessionWorkoutResult,
} from '@boardsesh/graphql/operations/session-workouts';
import { formatGrade } from '@boardsesh/play-view';
import type { SessionDetail } from '@boardsesh/shared-schema';
import { SessionDetailStory } from '../../../dev/fixtures/session-detail';
import { SessionFeedStoryCard } from '../../../dev/fixtures/session-feed';
import { SessionSummaryStory } from '../../../dev/fixtures/session-summary';
import { StoryVariant } from '../../../dev/stories/StoryCanvas';
import type { StoryModule } from '../../../dev/stories/types';
import { getGradeLabel } from '../../../lib/grade-label';
import type { WorkoutRunRecord } from '../../../lib/workout-run-store';
import { headlineView, localWorkoutView, serverWorkoutView } from './session-workout-view-model';
import type { WorkoutRepOutcome } from './types';
import {
  STORY_FEED_SESSION,
  STORY_SUMMARY,
  STORY_SUMMARY_UNSYNCED,
  STORY_WORKOUT,
  storyDetailTicks,
} from './workout-story-fixtures';
const formatStoryGrade = (grade: string | null | undefined, board?: string | null) =>
  formatGrade(grade, 'v-grade', board);
const SERVER_SESSION_ID = 'story-server-workout';
const PHONE_SESSION_ID = 'story-phone-workout';
const REP: Record<WorkoutRepOutcome, 'FLASH' | 'SEND' | 'ATTEMPT'> = {
  flash: 'FLASH',
  send: 'SEND',
  attempt: 'ATTEMPT',
};
const KILTER = 'kilter';

/** The fixture workout as `sessionWorkouts` answers it: grade labels as stored, reps uppercase. */
function serverWorkout(userId: string): SessionWorkoutResult {
  return {
    userId,
    displayName: 'Marco',
    avatarUrl: null,
    offPlan: STORY_WORKOUT.offPlan,
    offPlanTickUuids: STORY_WORKOUT.offPlanTickUuids,
    updatedAt: STORY_SUMMARY.endedAt ?? '2026-10-26T08:44:00.000Z',
    stages: STORY_WORKOUT.stages.map((stage) => ({
      id: stage.id,
      kind: stage.kind,
      isCoolDown: stage.isCoolDown,
      targetGrade: stage.targetGrade ? getGradeLabel(18, KILTER) : null,
      repsPerSet: stage.repsPerSet ?? null,
      sets: stage.sets ?? null,
      intervalSeconds: stage.intervalSeconds ?? null,
      restSeconds: stage.restSeconds ?? null,
      tally: stage.tally,
      climbs: stage.climbs.map((climb) => ({
        queueItemUuid: climb.queueItemUuid,
        climbUuid: climb.climbUuid,
        angle: climb.angle,
        isMirror: null,
        name: climb.name,
        grade: getGradeLabel(climb.difficulty, KILTER) || null,
        boardType: KILTER,
        layoutId: 1,
        frames: null,
        renderBoard: null,
        reps: climb.reps.map((rep) => REP[rep]),
        tickUuids: climb.tickUuids ?? [],
        skipped: climb.skipped,
      })),
    })),
  };
}

/** The same workout as the phone held it when the session ended: run, captured climbs and tick log. */
function phoneRecord(): WorkoutRunRecord {
  const ticks = storyDetailTicks();
  const climbs: NonNullable<WorkoutRunRecord['climbs']> = {};
  const log: NonNullable<WorkoutRunRecord['log']> = [];
  for (const stage of STORY_WORKOUT.stages) {
    for (const climb of stage.climbs) {
      climbs[climb.queueItemUuid] = {
        climbUuid: climb.climbUuid,
        angle: climb.angle,
        name: climb.name ?? undefined,
        difficulty: getGradeLabel(climb.difficulty, KILTER),
        boardType: KILTER,
      };
      for (const tickUuid of climb.tickUuids ?? []) {
        const tick = ticks.find((candidate) => candidate.uuid === tickUuid);
        if (!tick) continue;
        log.push({
          queueItemUuid: climb.queueItemUuid,
          status: tick.status as WorkoutRepOutcome,
          climbedAt: tick.climbedAt,
          tickUuid,
        });
      }
    }
  }
  return {
    sessionId: PHONE_SESSION_ID,
    climbs,
    log,
    run: {
      stages: STORY_WORKOUT.stages.map((stage) => ({
        id: stage.id,
        kind: stage.kind as 'warmUp' | 'fourByFour',
        itemUuids: stage.climbs.map((climb) => climb.queueItemUuid),
        ...(stage.isCoolDown ? { coolDown: true as const } : {}),
        ...(stage.targetGrade ? { targetGrade: 18 } : {}),
        ...(stage.repsPerSet
          ? {
              pacing: {
                mode: 'afterTick' as const,
                restSeconds: 10,
                advanceOn: 'set' as const,
                sets: { repsPerSet: stage.repsPerSet, restBetweenSetsSeconds: 180 },
              },
            }
          : {}),
      })),
    },
  };
}

function detail(userId: string): SessionDetail {
  return {
    sessionId: SERVER_SESSION_ID,
    sessionType: 'party',
    sessionName: null,
    ownerUserId: userId,
    participants: [{ userId, displayName: 'Marco', avatarUrl: null, sends: 16, flashes: 3, attempts: 23 }],
    totalSends: 16,
    totalFlashes: 3,
    totalAttempts: 23,
    tickCount: 23,
    gradeDistribution: STORY_SUMMARY.gradeDistribution,
    boardTypes: [KILTER],
    hardestGrade: 'V4',
    firstTickAt: '2026-10-26T07:32:00.000Z',
    lastTickAt: '2026-10-26T08:44:00.000Z',
    durationMinutes: 74,
    goal: null,
    notes: null,
    ticks: storyDetailTicks()
      .map((tick) => ({ ...tick, userId }))
      .reverse(),
    upvotes: 0,
    downvotes: 0,
    voteScore: 0,
    commentCount: 0,
  };
}

const SERVER_HEADLINES: SessionWorkoutHeadlineResult[] = [
  {
    sessionId: 'one',
    userId: 'story',
    mainKind: 'fourByFour',
    mainTargetGrade: '6b/V4',
    mainTargetBoardType: 'kilter',
    secondMainKind: null,
    blockCount: 3,
    extraMainBlocks: 0,
  },
  {
    sessionId: 'two',
    userId: 'story',
    mainKind: 'fourByFour',
    mainTargetGrade: '6b/V4',
    mainTargetBoardType: 'kilter',
    secondMainKind: 'pyramid',
    blockCount: 4,
    extraMainBlocks: 1,
  },
  {
    sessionId: 'more',
    userId: 'story',
    mainKind: 'onTheMinute',
    mainTargetGrade: '6a/V3',
    mainTargetBoardType: 'kilter',
    secondMainKind: 'pyramid',
    blockCount: 5,
    extraMainBlocks: 2,
  },
];

function FeedCards() {
  const lines = SERVER_HEADLINES.map((headline) => headlineView(headline, formatStoryGrade));
  return (
    <>
      {lines.map((line, index) => (
        <StoryVariant
          key={SERVER_HEADLINES[index]?.sessionId}
          label={`server headline: ${SERVER_HEADLINES[index]?.sessionId}`}
        >
          <SessionFeedStoryCard
            session={{ ...STORY_FEED_SESSION, sessionId: `story-feed-${index}`, socialEntityId: `story-feed-${index}` }}
            workoutHeadline={line}
          />
        </StoryVariant>
      ))}
    </>
  );
}

const stories: StoryModule = {
  title: 'Session / Workout from the server',
  stories: {
    summary: {
      name: 'Summary: the workout as sessionWorkouts answers it (injected view)',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => (
        <SessionSummaryStory
          {...controls}
          summary={STORY_SUMMARY}
          workout={serverWorkoutView(serverWorkout('story'), formatStoryGrade)}
        />
      ),
    },
    summaryFromPhone: {
      name: 'Summary: nothing on the server yet, the phone’s recap (injected view)',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => (
        <SessionSummaryStory
          {...controls}
          summary={STORY_SUMMARY_UNSYNCED}
          workout={localWorkoutView(phoneRecord(), 'story', formatStoryGrade) ?? undefined}
          pendingTicks={22}
        />
      ),
    },
    detail: {
      name: 'Session detail: climbs grouped by the server’s tick uuids (injected view)',
      layout: 'fullscreen',
      tab: 'home',
      tabRoot: false,
      readiness: 'explicit',
      render: (controls) => (
        <SessionDetailStory
          {...controls}
          session={detail('story')}
          workout={serverWorkoutView(serverWorkout('story'), formatStoryGrade)}
        />
      ),
    },
    feed: {
      name: 'Feed cards from sessionWorkoutHeadlines answers',
      render: () => <FeedCards />,
    },
  },
};

export default stories;
