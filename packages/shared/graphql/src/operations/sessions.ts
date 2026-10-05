import { gql } from 'graphql-request';
import type { SessionInvitePreview, SessionSummary } from '@boardsesh/shared-schema';

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
      isPublic
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

// What a session invite link points at, for someone who may have neither an
// account nor the app (#6004). Unauthenticated and rate limited. It answers for
// a dormant session (running, nobody connected), which `session` cannot: that
// query returns null for any empty roster.
export const GET_SESSION_INVITE_PREVIEW = gql`
  query GetSessionInvitePreview($sessionId: ID!) {
    sessionInvitePreview(sessionId: $sessionId) {
      sessionId
      state
      hostName
      boardName
      boardPath
      gymName
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

export type GetSessionInvitePreviewVariables = {
  sessionId: string;
};

export type GetSessionInvitePreviewResponse = {
  sessionInvitePreview: SessionInvitePreview;
};
