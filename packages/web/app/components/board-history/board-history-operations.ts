import { gql } from 'graphql-request';
import type {
  BoardHistoryEntry,
  BoardHistoryEvent,
  RecordBoardSendInput,
  BoardSession,
} from '@boardsesh/shared-schema';

// ============================================
// Fragments
// ============================================

const BOARD_HISTORY_ENTRY_FIELDS = `
  id
  uuid
  boardSerial
  boardId
  climbUuid
  angle
  isMirror
  source
  userId
  username
  sessionId
  sentAt
  sequence
`;

// ============================================
// Queries
// ============================================

/**
 * Seed query for the BoardHistoryProvider. Fetches only the most recent
 * entry — MVP only consumes `latestEntry`, so there is no point pulling
 * the full reverse-chronological window over the wire.
 */
export const BOARD_HISTORY_LATEST_QUERY = gql`
  query BoardHistoryLatest($boardSerial: String!) {
    boardHistory(boardSerial: $boardSerial, limit: 1) {
      ${BOARD_HISTORY_ENTRY_FIELDS}
    }
  }
`;

export type BoardHistoryLatestVariables = {
  boardSerial: string;
};

export type BoardHistoryLatestResponse = {
  boardHistory: BoardHistoryEntry[];
};

// ============================================
// Subscriptions
// ============================================

/**
 * Live board-history stream. The first event is always a
 * `BoardHistoryFullSync` (the backend's snapshot); subsequent events are
 * `BoardHistoryEntryAdded`. Both shapes flow through the same union.
 */
export const BOARD_HISTORY_EVENTS_SUBSCRIPTION = gql`
  subscription BoardHistoryEvents($boardSerial: String!) {
    boardHistoryEvents(boardSerial: $boardSerial) {
      __typename
      ... on BoardHistoryFullSync {
        sequence
        entries {
          ${BOARD_HISTORY_ENTRY_FIELDS}
        }
      }
      ... on BoardHistoryEntryAdded {
        sequence
        entry {
          ${BOARD_HISTORY_ENTRY_FIELDS}
        }
      }
    }
  }
`;

export type BoardHistoryEventsVariables = {
  boardSerial: string;
};

export type BoardHistoryEventsPayload = {
  boardHistoryEvents: BoardHistoryEvent;
};

// ============================================
// Mutations
// ============================================

/**
 * Record a successful BLE send. Idempotent on `input.uuid` — the server
 * deduplicates via `ON CONFLICT (uuid) DO NOTHING`, so repeated calls
 * with the same client-generated uuid are safe.
 */
export const RECORD_BOARD_SEND_MUTATION = gql`
  mutation RecordBoardSend($input: RecordBoardSendInput!) {
    recordBoardSend(input: $input) {
      ${BOARD_HISTORY_ENTRY_FIELDS}
    }
  }
`;

export type RecordBoardSendVariables = {
  input: RecordBoardSendInput;
};

export type RecordBoardSendResponse = {
  recordBoardSend: BoardHistoryEntry;
};

/**
 * Flip the shared-playlist queue flag for a session. Leader-only on the
 * server; clients pre-flight with optimistic UI and roll back on error.
 */
export const SET_SHARED_PLAYLIST_ENABLED_MUTATION = gql`
  mutation SetSharedPlaylistEnabled($sessionId: ID!, $enabled: Boolean!) {
    setSharedPlaylistEnabled(sessionId: $sessionId, enabled: $enabled) {
      id
      boardPath
      name
      sharedPlaylistEnabled
      startedAt
      endedAt
    }
  }
`;

export type SetSharedPlaylistEnabledVariables = {
  sessionId: string;
  enabled: boolean;
};

export type SetSharedPlaylistEnabledResponse = {
  setSharedPlaylistEnabled: BoardSession;
};
