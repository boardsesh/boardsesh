// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

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
    notes
  }
`;

// ============================================
// Mutations
// ============================================

export const END_SESSION = gql`
  ${SESSION_SUMMARY_FIELDS}
  mutation EndSession($sessionId: ID!, $timezone: String, $notes: String) {
    endSession(sessionId: $sessionId, timezone: $timezone, notes: $notes) {
      ...SessionSummaryFields
    }
  }
`;

export const UPDATE_SESSION = gql`
  mutation UpdateSession($input: UpdateSessionInput!) {
    updateSession(input: $input) {
      sessionId
      name
      notes
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
  /** Optional free-text end-of-session recap persisted on the session. */
  notes?: string;
};

export type EndSessionResponse = {
  endSession: SessionSummary | null;
};

export type UpdateSessionVariables = {
  input: {
    sessionId: string;
    name?: string | null;
    notes?: string | null;
  };
};

export type UpdateSessionResponse = {
  updateSession: { sessionId: string; name: string | null; notes: string | null };
};

export type GetSessionSummaryVariables = {
  sessionId: string;
};

export type GetSessionSummaryResponse = {
  sessionSummary: SessionSummary | null;
};
