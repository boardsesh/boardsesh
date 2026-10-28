import { useEffect, useMemo } from 'react';
import { useRouter, type Href } from 'expo-router';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { SessionDetail, SessionSummary } from '@boardsesh/shared-schema';
import type {
  SessionWorkoutHeadlineResult,
  SessionWorkoutResult,
} from '@boardsesh/graphql/operations/session-workouts';
import type { StoryModule } from '../../../dev/stories/types';
import { StoryVariant } from '../../../dev/stories/StoryCanvas';
import { Text } from '../../Text';
import { SessionFeedCard } from '../../you/SessionFeedCard';
import { useProfile } from '../../../lib/graphql/hooks';
import { sessionSummaryQueryKey, sessionWorkoutsQueryKey } from '../../../lib/graphql/query-keys';
import { getGradeLabel } from '../../../lib/grade-label';
import { useGradeFormat } from '../../../hooks/use-grade-format';
import { rememberEndedWorkout } from '../../../lib/ended-workout-store';
import { nowMs } from '../../../lib/clock';
import type { WorkoutRunRecord } from '../../../lib/workout-run-store';
import { headlineView } from './session-workout-view-model';
import {
  STORY_FEED_SESSION,
  STORY_SUMMARY,
  STORY_SUMMARY_UNSYNCED,
  STORY_WORKOUT,
  storyDetailTicks,
} from './workout-story-fixtures';
import type { WorkoutRepOutcome } from './types';

// The workout through the real data path (#6903): the story puts server-shaped
// answers (`sessionWorkouts`, `sessionDetail`, the summary) in the query cache
// under story-only session ids, pinned so nothing refetches, and opens the real
// routes, so `useSessionWorkoutView` picks and maps them as it does a live
// answer. The workout is stamped with the signed-in climber's id, so it reads
// as theirs. The saving story leaves the server empty and keeps a recap on the
// phone instead, the fallback a just-ended session sees.

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

type CacheEntry = { key: QueryKey; data: unknown };

/** Pins `entries` in the query cache, then opens `href`. Waits for the signed-in profile first. */
function OpenWithCache({ build, href }: { build: (userId: string) => CacheEntry[]; href: string }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data: profile } = useProfile();
  const userId = profile?.id ?? null;
  useEffect(() => {
    if (!userId) return;
    for (const { key, data } of build(userId)) {
      queryClient.setQueryDefaults(key, { staleTime: Infinity, gcTime: Infinity, retry: false });
      queryClient.setQueryData(key, data);
    }
    router.push(href as Href);
  }, [queryClient, router, build, href, userId]);
  return <Text variant="footnote">{userId ? 'Opening…' : 'Sign in to open this story.'}</Text>;
}

const summaryEntries = (userId: string): CacheEntry[] => [
  {
    key: sessionSummaryQueryKey(SERVER_SESSION_ID),
    data: { sessionSummary: { ...STORY_SUMMARY, sessionId: SERVER_SESSION_ID } satisfies SessionSummary },
  },
  { key: sessionWorkoutsQueryKey(SERVER_SESSION_ID), data: [serverWorkout(userId)] },
];

const detailEntries = (userId: string): CacheEntry[] => [
  { key: ['sessionDetail', SERVER_SESSION_ID], data: detail(userId) },
  { key: ['sessionOwner', SERVER_SESSION_ID], data: userId },
  { key: sessionWorkoutsQueryKey(SERVER_SESSION_ID), data: [serverWorkout(userId)] },
];

const phoneEntries = (): CacheEntry[] => {
  rememberEndedWorkout(phoneRecord(), nowMs());
  return [
    {
      key: sessionSummaryQueryKey(PHONE_SESSION_ID),
      data: { sessionSummary: { ...STORY_SUMMARY_UNSYNCED, sessionId: PHONE_SESSION_ID } satisfies SessionSummary },
    },
    // The server answers nothing for an owner with no synced tick.
    { key: sessionWorkoutsQueryKey(PHONE_SESSION_ID), data: [] },
  ];
};

const SERVER_HEADLINES: SessionWorkoutHeadlineResult[] = [
  {
    sessionId: 'one',
    userId: 'story',
    mainKind: 'fourByFour',
    mainTargetGrade: '6b/V4',
    secondMainKind: null,
    blockCount: 3,
    extraMainBlocks: 0,
  },
  {
    sessionId: 'two',
    userId: 'story',
    mainKind: 'fourByFour',
    mainTargetGrade: '6b/V4',
    secondMainKind: 'pyramid',
    blockCount: 4,
    extraMainBlocks: 1,
  },
  {
    sessionId: 'more',
    userId: 'story',
    mainKind: 'onTheMinute',
    mainTargetGrade: '6a/V3',
    secondMainKind: 'pyramid',
    blockCount: 5,
    extraMainBlocks: 2,
  },
];

function FeedCards() {
  const { formatGrade } = useGradeFormat();
  const lines = useMemo(() => SERVER_HEADLINES.map((headline) => headlineView(headline, formatGrade)), [formatGrade]);
  return (
    <>
      {lines.map((line, index) => (
        <StoryVariant
          key={SERVER_HEADLINES[index]?.sessionId}
          label={`server headline: ${SERVER_HEADLINES[index]?.sessionId}`}
        >
          <SessionFeedCard
            session={{ ...STORY_FEED_SESSION, sessionId: `story-feed-${index}`, socialEntityId: `story-feed-${index}` }}
            onOpenComments={() => {}}
            onPress={() => {}}
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
      name: 'Summary: the workout as sessionWorkouts answers it (real route)',
      render: () => <OpenWithCache build={summaryEntries} href={`/record/summary?sessionId=${SERVER_SESSION_ID}`} />,
    },
    summaryFromPhone: {
      name: 'Summary: nothing on the server yet, the phone’s recap (real route)',
      render: () => <OpenWithCache build={phoneEntries} href={`/record/summary?sessionId=${PHONE_SESSION_ID}`} />,
    },
    detail: {
      name: 'Session detail: climbs grouped by the server’s tick uuids (real route)',
      render: () => <OpenWithCache build={detailEntries} href={`/profile/session/${SERVER_SESSION_ID}`} />,
    },
    feed: {
      name: 'Feed cards from sessionWorkoutHeadlines answers',
      render: () => <FeedCards />,
    },
  },
};

export default stories;
