import { gql } from 'graphql-request';

// ============================================
// Mutations
// ============================================

export const CREATE_SESSION = gql`
  mutation CreateSession($input: CreateSessionInput!) {
    createSession(input: $input) {
      id
      name
      boardPath
      goal
      isPublic
      isPermanent
      color
      startedAt
    }
  }
`;

// ============================================
// Types
// ============================================

export type CreateSessionInput = {
  audience?: 'public' | 'followers' | 'invite_only';
  boardPath: string;
  latitude: number;
  longitude: number;
  name?: string;
  discoverable: boolean;
  goal?: string;
  isPermanent?: boolean;
  boardIds?: number[];
  color?: string;
  /**
   * Whether the session shows up in live-session listings. Absent means public
   * server-side, so callers send it only to make a session private.
   */
  isPublic?: boolean;
};

export type CreateSessionVariables = {
  input: CreateSessionInput;
};

export type CreateSessionResponse = {
  createSession: {
    id: string;
    name: string | null;
    boardPath: string;
    goal: string | null;
    isPublic: boolean;
    isPermanent: boolean;
    color: string | null;
    startedAt: string;
  };
};
