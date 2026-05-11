/**
 * Event types for GraphQL subscriptions
 *
 * ## Type Aliasing Strategy
 *
 * There are TWO event types due to GraphQL union type constraints:
 *
 * 1. `QueueEvent` - Server-side type using `item` field. Used by backend PubSub
 *    and for eventsReplay query responses.
 *
 * 2. `SubscriptionQueueEvent` - Client-side type using aliased fields (`addedItem`,
 *    `currentItem`). Required because GraphQL doesn't allow the same field name
 *    with different nullability in a union (QueueItemAdded.item is non-null,
 *    CurrentClimbChanged.item is nullable).
 */

import type { ClimbQueueItem, QueueState } from './queue';
import type { SessionUser } from './session';
import type { SessionFeedParticipant, SessionGradeDistributionItem, SessionDetailTick } from './activity-feed';

// Response for delta sync event replay (Phase 2)
// Uses QueueEvent since this is a query returning buffered events with standard field names
export type EventsReplayResponse = {
  events: QueueEvent[];
  currentSequence: number;
};

// Server-side event type - uses actual GraphQL field names
export type QueueEvent =
  | { __typename: 'FullSync'; sequence: number; state: QueueState }
  | { __typename: 'QueueItemAdded'; sequence: number; item: ClimbQueueItem; position?: number }
  | { __typename: 'QueueItemRemoved'; sequence: number; uuid: string }
  | {
      __typename: 'QueueReordered';
      sequence: number;
      uuid: string;
      oldIndex: number;
      newIndex: number;
    }
  | {
      __typename: 'CurrentClimbChanged';
      sequence: number;
      item: ClimbQueueItem | null;
      clientId: string | null;
      correlationId: string | null;
    }
  | { __typename: 'ClimbMirrored'; sequence: number; mirrored: boolean };

// Client-side subscription event type - uses aliased field names to avoid GraphQL union conflicts
export type SubscriptionQueueEvent =
  | { __typename: 'FullSync'; sequence: number; state: QueueState }
  | { __typename: 'QueueItemAdded'; sequence: number; addedItem: ClimbQueueItem; position?: number }
  | { __typename: 'QueueItemRemoved'; sequence: number; uuid: string }
  | {
      __typename: 'QueueReordered';
      sequence: number;
      uuid: string;
      oldIndex: number;
      newIndex: number;
    }
  | {
      __typename: 'CurrentClimbChanged';
      sequence: number;
      currentItem: ClimbQueueItem | null;
      clientId: string | null;
      correlationId: string | null;
    }
  | { __typename: 'ClimbMirrored'; sequence: number; mirrored: boolean };

export type SessionEvent =
  | { __typename: 'UserJoined'; user: SessionUser }
  | { __typename: 'UserLeft'; userId: string }
  | { __typename: 'LeaderChanged'; leaderId: string }
  | { __typename: 'SessionEnded'; reason: string; newPath?: string }
  | {
      __typename: 'SessionStatsUpdated';
      sessionId: string;
      totalSends: number;
      totalFlashes: number;
      totalAttempts: number;
      tickCount: number;
      participants: SessionFeedParticipant[];
      gradeDistribution: SessionGradeDistributionItem[];
      boardTypes: string[];
      hardestGrade?: string | null;
      durationMinutes?: number | null;
      goal?: string | null;
      ticks: SessionDetailTick[];
    };

export type ConnectionContext = {
  connectionId: string;
  sessionId?: string;
  userId?: string;
  isAuthenticated?: boolean;
  // Client IP for rate limiting anonymous HTTP requests
  clientIp?: string;
  // Anonymous distinct id propagated from the client (IndexedDB partyProfile UUID).
  // Used for PostHog server-side attribution when no NextAuth session is present.
  distinctId?: string;
  // Controller-specific context (set when using API key auth)
  controllerId?: string;
  controllerApiKey?: string;
  controllerMac?: string; // Controller's MAC address (used as clientId for BLE disconnect logic)
};
