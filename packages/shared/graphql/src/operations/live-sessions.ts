import { gql } from 'graphql-request';
import type { LiveSession } from '@boardsesh/shared-schema';

// ============================================
// Fragments
// ============================================

export const LIVE_SESSION_FIELDS = gql`
  fragment LiveSessionFields on LiveSession {
    sessionId
    name
    goal
    color
    startedAt
    lastActivity
    host {
      userId
      displayName
      avatarUrl
    }
    participants {
      userId
      displayName
      avatarUrl
    }
    participantCount
    followedParticipantIds
    viewerIsMember
    isPublic
    board {
      uuid
      name
      slug
      boardType
      gymName
    }
    boardType
    angle
    sendCount
    flashCount
    hardestSendGrade
    currentClimb {
      name
      grade
    }
    reasons
  }
`;

// ============================================
// Queries
// ============================================

// The fragment is interpolated AFTER the operation so the document starts
// with `query` — operations-schema-validation.test.ts only validates exports
// that do, and these should be validated against the schema.
export const FOLLOWED_LIVE_SESSIONS = gql`
  query FollowedLiveSessions($boardUuid: ID, $limit: Int) {
    followedLiveSessions(boardUuid: $boardUuid, limit: $limit) {
      ...LiveSessionFields
    }
  }
  ${LIVE_SESSION_FIELDS}
`;

export const BOARD_LIVE_SESSIONS = gql`
  query BoardLiveSessions($boardId: Int!) {
    boardLiveSessions(boardId: $boardId) {
      ...LiveSessionFields
    }
  }
  ${LIVE_SESSION_FIELDS}
`;

// ============================================
// Types
// ============================================

export type FollowedLiveSessionsVariables = {
  boardUuid?: string | null;
  limit?: number | null;
};

export type FollowedLiveSessionsResponse = {
  followedLiveSessions: LiveSession[];
};

export type BoardLiveSessionsVariables = {
  boardId: number;
};

export type BoardLiveSessionsResponse = {
  boardLiveSessions: LiveSession[];
};
