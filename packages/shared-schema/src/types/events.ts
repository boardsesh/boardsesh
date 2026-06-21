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

// Re-export the canonical SessionEvent union from codegen so this file
// never drifts from the GraphQL schema. The hand-written union previously
// duplicated here was already going stale (it predated the addition of
// queueItemUuid on WallConfirmedClimb).
export type { SessionEvent } from '../generated/types';

// Response for delta sync event replay (Phase 2). Backend resolvers publish
// QueueEvent objects, while GraphQL clients receive aliased subscription-shaped
// payloads from the EVENTS_REPLAY operation.
export type EventsReplayResponse = {
  events: ReplayQueueEvent[];
  currentSequence: number;
};

export type ReplayQueueEvent = QueueEvent | SubscriptionQueueEvent;

// Server-side event type - uses actual GraphQL field names
export type QueueEvent =
  | { __typename: 'FullSync'; sequence: number; state: QueueState }
  | {
      __typename: 'QueueItemAdded';
      sequence: number;
      stateHash: string;
      item: ClimbQueueItem;
      position?: number | null;
    }
  | { __typename: 'QueueItemRemoved'; sequence: number; stateHash: string; uuid: string }
  | {
      __typename: 'QueueReordered';
      sequence: number;
      stateHash: string;
      uuid: string;
      oldIndex: number;
      newIndex: number;
    }
  | {
      __typename: 'CurrentClimbChanged';
      sequence: number;
      stateHash: string;
      item: ClimbQueueItem | null;
      frames?: string | null;
      clientId: string | null;
      correlationId: string | null;
    }
  | { __typename: 'ClimbMirrored'; sequence: number; stateHash: string; uuid?: string | null; mirrored: boolean }
  | {
      __typename: 'PlaybackStateChanged';
      sequence: number;
      climbUuid: string;
      frameIndex: number;
      isPlaying: boolean;
      speed: number;
      paceMs: number;
      anchorTimestamp: string;
      clientId: string | null;
    };

// Client-side subscription event type - uses aliased field names to avoid GraphQL union conflicts
export type SubscriptionQueueEvent =
  | { __typename: 'FullSync'; sequence: number; state: QueueState }
  | {
      __typename: 'QueueItemAdded';
      sequence: number;
      stateHash: string;
      addedItem: ClimbQueueItem;
      position?: number | null;
    }
  | { __typename: 'QueueItemRemoved'; sequence: number; stateHash: string; uuid: string }
  | {
      __typename: 'QueueReordered';
      sequence: number;
      stateHash: string;
      uuid: string;
      oldIndex: number;
      newIndex: number;
    }
  | {
      __typename: 'CurrentClimbChanged';
      sequence: number;
      stateHash: string;
      currentItem: ClimbQueueItem | null;
      frames?: string | null;
      clientId: string | null;
      correlationId: string | null;
    }
  | {
      __typename: 'ClimbMirrored';
      sequence: number;
      stateHash: string;
      mirroredUuid?: string | null;
      mirrored: boolean;
    }
  | {
      __typename: 'PlaybackStateChanged';
      sequence: number;
      climbUuid: string;
      frameIndex: number;
      isPlaying: boolean;
      speed: number;
      paceMs: number;
      anchorTimestamp: string;
      clientId: string | null;
    };

export type ConnectionContext = {
  connectionId: string;
  // Transport that produced this context. Resolvers branch on this for
  // HTTP-vs-WebSocket behaviour; avoid grepping `connectionId.startsWith(...)`
  // which is fragile to id-format changes. Optional for test contexts that
  // don't care which transport they emulate; production paths always set it.
  transport?: 'http' | 'ws';
  sessionId?: string;
  participantId?: string;
  userId?: string;
  isAuthenticated?: boolean;
  // Client IP for rate limiting anonymous HTTP requests
  clientIp?: string;
  // Controller-specific context (set when using API key auth)
  controllerId?: string;
  controllerApiKey?: string;
  controllerMac?: string; // Controller's MAC address (used as clientId for BLE disconnect logic)
};
