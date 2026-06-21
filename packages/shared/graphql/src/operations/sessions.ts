import { gql } from 'graphql-request';
import type { SessionSummary } from '@boardsesh/shared-schema';

// ============================================
// Fragments
// ============================================

export const SESSION_SUMMARY_FIELDS = gql`
  fragment SessionSummaryFields on SessionSummary {
    sessionId
    totalSends
    totalFlashes
    totalAttempts
    gradeDistribution {
      grade
      flash
      send
      attempt
    }
    hardestClimb {
      climbUuid
      climbName
      grade
      frames
      layoutId
      boardType
      isMirror
    }
    participants {
      userId
      displayName
      avatarUrl
      sends
      flashes
      attempts
    }
    startedAt
    endedAt
    durationMinutes
    goal
  }
`;

// ============================================
// Mutations
// ============================================

export const END_SESSION = gql`
  ${SESSION_SUMMARY_FIELDS}
  mutation EndSession($sessionId: ID!, $timezone: String) {
    endSession(sessionId: $sessionId, timezone: $timezone) {
      ...SessionSummaryFields
    }
  }
`;

// ============================================
// Queries
// ============================================

export const GET_SESSION_SUMMARY = gql`
  ${SESSION_SUMMARY_FIELDS}
  query GetSessionSummary($sessionId: ID!) {
    sessionSummary(sessionId: $sessionId) {
      ...SessionSummaryFields
    }
  }
`;

// ============================================
// Types
// ============================================

export type EndSessionVariables = {
  sessionId: string;
  /** IANA timezone of the ending device, for local-time export to platforms like Strava. */
  timezone?: string;
};

export type EndSessionResponse = {
  endSession: SessionSummary | null;
};

export type GetSessionSummaryVariables = {
  sessionId: string;
};

export type GetSessionSummaryResponse = {
  sessionSummary: SessionSummary | null;
};
