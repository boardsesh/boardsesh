import { gql } from 'graphql-request';

// Workout-aware sessions (#6903). Separate documents from the session detail /
// summary / feed ones on purpose: adding selections to those trips the pinned
// screenshot fixtures.

export const GET_SESSION_WORKOUTS = gql`
  query GetSessionWorkouts($sessionId: ID!) {
    sessionWorkouts(sessionId: $sessionId) {
      userId
      displayName
      avatarUrl
      offPlan
      offPlanTickUuids
      updatedAt
      stages {
        id
        kind
        isCoolDown
        targetGrade
        repsPerSet
        sets
        intervalSeconds
        restSeconds
        tally {
          sent
          attempts
          skipped
          climbs
        }
        climbs {
          queueItemUuid
          climbUuid
          angle
          isMirror
          name
          grade
          boardType
          layoutId
          frames
          renderBoard {
            layoutId
            sizeId
            setIds
          }
          reps
          tickUuids
          skipped
        }
      }
    }
  }
`;

export const GET_SESSION_WORKOUT_HEADLINES = gql`
  query GetSessionWorkoutHeadlines($sessionIds: [ID!]!) {
    sessionWorkoutHeadlines(sessionIds: $sessionIds) {
      sessionId
      userId
      mainKind
      mainTargetGrade
      secondMainKind
      blockCount
      extraMainBlocks
    }
  }
`;

/** The server's per-batch cap on `sessionWorkoutHeadlines`. */
export const MAX_SESSION_WORKOUT_HEADLINE_IDS = 50;

export type SessionWorkoutRepOutcomeValue = 'FLASH' | 'SEND' | 'ATTEMPT';

export type SessionWorkoutClimbResult = {
  queueItemUuid: string;
  climbUuid: string;
  angle: number;
  isMirror: boolean | null;
  name: string | null;
  grade: string | null;
  boardType: string | null;
  layoutId: number | null;
  frames: string | null;
  renderBoard: { layoutId: number; sizeId: number; setIds: number[] } | null;
  reps: SessionWorkoutRepOutcomeValue[];
  /** The viewer-visible ticks behind `reps`, in rep order. Absent from an older server. */
  tickUuids?: string[];
  skipped: boolean;
};

export type SessionWorkoutStageResult = {
  id: string;
  kind: string;
  isCoolDown: boolean;
  targetGrade: string | null;
  repsPerSet: number | null;
  sets: number | null;
  intervalSeconds: number | null;
  restSeconds: number | null;
  tally: { sent: number; attempts: number; skipped: number; climbs: number };
  climbs: SessionWorkoutClimbResult[];
};

export type SessionWorkoutResult = {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  offPlan: number;
  /** The viewer-visible off-plan ticks. Absent from an older server. */
  offPlanTickUuids?: string[];
  updatedAt: string;
  stages: SessionWorkoutStageResult[];
};

export type GetSessionWorkoutsQueryResponse = { sessionWorkouts: SessionWorkoutResult[] };

export type SessionWorkoutHeadlineResult = {
  sessionId: string;
  userId: string;
  mainKind: string | null;
  mainTargetGrade: string | null;
  secondMainKind: string | null;
  blockCount: number;
  extraMainBlocks: number;
};

export type GetSessionWorkoutHeadlinesQueryResponse = { sessionWorkoutHeadlines: SessionWorkoutHeadlineResult[] };
