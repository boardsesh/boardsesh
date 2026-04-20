import { gql } from 'graphql-request';
import type { BoardConfigInput } from '@boardsesh/shared-schema';

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

export interface CreateSessionInput {
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
   * Extra board configs to attach beyond the primary board encoded in
   * `boardPath`. Back-compat: omit for single-board sessions.
   */
  boards?: BoardConfigInput[];
}

export interface CreateSessionResponse {
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
}
