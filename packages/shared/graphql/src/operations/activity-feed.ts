import { gql } from 'graphql-request';
import type { ActivityFeedInput, ActivityFeedResult, SessionFeedResult, SessionDetail } from '@boardsesh/shared-schema';

// ============================================
// Activity Feed Queries
// ============================================

export const GET_ACTIVITY_FEED = gql`
  query GetActivityFeed($input: ActivityFeedInput) {
    activityFeed(input: $input) {
      items {
        id
        type
        entityType
        entityId
        boardUuid
        actorId
        actorDisplayName
        actorAvatarUrl
        climbName
        climbUuid
        boardType
        layoutId
        gradeName
        status
        angle
        frames
        setterUsername
        commentBody
        isMirror
        isBenchmark
        isNoMatch
        difficulty
        difficultyName
        quality
        attemptCount
        comment
        commentCount
        createdAt
      }
      cursor
      hasMore
    }
  }
`;

// ============================================
// Session-Grouped Feed Queries
// ============================================

const SESSION_SUMMARY_FIELDS = `
  sessionId
  sessionType
  sessionName
  ownerUserId
  participants {
    userId
    displayName
    avatarUrl
    sends
    flashes
    attempts
  }
  totalSends
  totalFlashes
  totalAttempts
  tickCount
  gradeDistribution {
    grade
    flash
    send
    attempt
  }
  boardTypes
  hardestGrade
  firstTickAt
  lastTickAt
  durationMinutes
  goal
  upvotes
  downvotes
  voteScore
  commentCount
`;

const SESSION_FEED_ITEM_FIELDS = `
  ${SESSION_SUMMARY_FIELDS}
  hardestSend {
    uuid
    userId
    climbUuid
    climbName
    boardType
    layoutId
    angle
    status
    attemptCount
    difficulty
    difficultyName
    quality
    isMirror
    isBenchmark
    isNoMatch
    comment
    frames
    setterUsername
    climbedAt
  }
  featuredBeta {
    tick {
      uuid
      userId
      climbUuid
      climbName
      boardType
      layoutId
      angle
      status
      attemptCount
      difficulty
      difficultyName
      quality
      isMirror
      isBenchmark
      isNoMatch
      comment
      frames
      setterUsername
      climbedAt
    }
    betaLink {
      climbUuid
      link
      foreignUsername
      angle
      thumbnail
      isListed
      createdAt
      tickUuid
      boardId
    }
  }
  socialEntityType
  socialEntityId
`;

export const GET_SESSION_GROUPED_FEED = gql`
  query GetSessionGroupedFeed($input: ActivityFeedInput) {
    sessionGroupedFeed(input: $input) {
      sessions {
        ${SESSION_FEED_ITEM_FIELDS}
      }
      cursor
      hasMore
    }
  }
`;

export const GET_SESSION_DETAIL = gql`
  query GetSessionDetail($sessionId: ID!) {
    sessionDetail(sessionId: $sessionId) {
      ${SESSION_SUMMARY_FIELDS}
      healthKitWorkoutId
      ticks {
        uuid
        userId
        climbUuid
        climbName
        boardType
        layoutId
        angle
        status
        attemptCount
        difficulty
        difficultyName
        quality
        isMirror
        isBenchmark
        isNoMatch
        comment
        frames
        setterUsername
        climbedAt
        upvotes
        totalAttempts
        betaLinks {
          climbUuid
          link
          foreignUsername
          angle
          thumbnail
          isListed
          createdAt
          tickUuid
          # boardId is kept for BetaLinksGqlRow type parity and flows through
          # dedupeBetaLinks — it is not displayed by the session-detail carousel.
          boardId
        }
      }
    }
  }
`;

export const SET_SESSION_HEALTHKIT_WORKOUT_ID = gql`
  mutation SetSessionHealthKitWorkoutId($sessionId: ID!, $workoutId: String!) {
    setSessionHealthKitWorkoutId(sessionId: $sessionId, workoutId: $workoutId)
  }
`;

// ============================================
// Query Variable Types
// ============================================

export type GetSessionGroupedFeedQueryVariables = {
  input?: ActivityFeedInput;
};

export type GetActivityFeedQueryVariables = {
  input?: ActivityFeedInput;
};

export type GetActivityFeedQueryResponse = {
  activityFeed: ActivityFeedResult;
};

export type GetSessionGroupedFeedQueryResponse = {
  sessionGroupedFeed: SessionFeedResult;
};

export type GetSessionDetailQueryVariables = {
  sessionId: string;
};

export type GetSessionDetailQueryResponse = {
  sessionDetail: SessionDetail | null;
};
