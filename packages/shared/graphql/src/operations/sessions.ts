import { gql } from 'graphql-request';
import type { SessionSummary } from '@boardsesh/shared-schema';

// ============================================
// Field lists
// ============================================

// Interpolated as a plain string, not a GraphQL fragment, and the field ORDER
// is load-bearing: `GetSessionSummary` is replayed from recorded fixtures keyed
// on the query text (docs/mobile-screenshot-fixtures.md), and that set cannot
// be re-recorded.
const SESSION_SUMMARY_FIELDS = `
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
    renderBoard {
      layoutId
      sizeId
      setIds
    }
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
`;

// ============================================
// Mutations
// ============================================

export const END_SESSION = gql`
  mutation EndSession($sessionId: ID!, $timezone: String, $notes: String) {
    endSession(sessionId: $sessionId, timezone: $timezone, notes: $notes) {
      ${SESSION_SUMMARY_FIELDS}
    }
  }
`;

export const UPDATE_SESSION = gql`
  mutation UpdateSession($input: UpdateSessionInput!) {
    updateSession(input: $input) {
      sessionId
      name
      notes
      isPublic
    }
  }
`;

// ============================================
// Queries
// ============================================

export const GET_SESSION_SUMMARY = gql`
  query GetSessionSummary($sessionId: ID!) {
    sessionSummary(sessionId: $sessionId) {
      ${SESSION_SUMMARY_FIELDS}
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
    /** Omit or null to leave visibility unchanged. */
    isPublic?: boolean | null;
  };
};

export type UpdateSessionResponse = {
  updateSession: { sessionId: string; name: string | null; notes: string | null; isPublic: boolean };
};

export type GetSessionSummaryVariables = {
  sessionId: string;
};

export type GetSessionSummaryResponse = {
  sessionSummary: SessionSummary | null;
};
