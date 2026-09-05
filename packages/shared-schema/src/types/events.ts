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

/**
 * Transient route-playback state carried by queue subscriptions. This shape is
 * shared by the server-side and client-side event unions and by the
 * renderer-agnostic subscription adapter; keep it canonical here so those
 * consumers cannot drift independently.
 */
export type PlaybackStateChangedEvent = {
  __typename: 'PlaybackStateChanged';
  sequence: number;
  climbUuid: string;
  frameIndex: number;
  /**
   * Frames the publisher's reader produced for this climb. Optional: publishers
   * that predate the field omit it, and legacy payloads must keep typechecking.
   * Receivers stop following the peer when it disagrees with their own frame
   * count rather than clamping the index into range.
   */
  frameCount?: number | null;
  isPlaying: boolean;
  speed: number;
  paceMs: number;
  anchorTimestamp: string;
  clientId: string | null;
};

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

// Server-side event type - uses actual GraphQL field names.
// `stateHashOrdered` is the optional order-sensitive (v2) hash, additive during
// the dual-hash rollout — the backend always sends it now; old clients ignore it.
export type QueueEvent =
  | { __typename: 'FullSync'; sequence: number; state: QueueState }
  | {
      __typename: 'QueueItemAdded';
      sequence: number;
      stateHash: string;
      stateHashOrdered?: string | null;
      item: ClimbQueueItem;
      position?: number | null;
      /** Connection id of the adding client; optional so legacy/replayed payloads still typecheck. */
      clientId?: string | null;
    }
  | {
      __typename: 'QueueItemRemoved';
      sequence: number;
      stateHash: string;
      stateHashOrdered?: string | null;
      uuid: string;
      /** Connection id of the removing client; optional so legacy/replayed payloads still typecheck. */
      clientId?: string | null;
    }
  | {
      __typename: 'QueueReordered';
      sequence: number;
      stateHash: string;
      stateHashOrdered?: string | null;
      uuid: string;
      oldIndex: number;
      newIndex: number;
    }
  | {
      __typename: 'CurrentClimbChanged';
      sequence: number;
      stateHash: string;
      stateHashOrdered?: string | null;
      item: ClimbQueueItem | null;
      frames?: string | null;
      clientId: string | null;
      correlationId: string | null;
    }
  | {
      __typename: 'ClimbMirrored';
      sequence: number;
      stateHash: string;
      stateHashOrdered?: string | null;
      uuid?: string | null;
      mirrored: boolean;
    }
  | PlaybackStateChangedEvent;

// Client-side subscription event type - uses aliased field names to avoid GraphQL union conflicts.
// `stateHashOrdered` mirrors the server type's optional order-sensitive (v2) hash.
export type SubscriptionQueueEvent =
  | { __typename: 'FullSync'; sequence: number; state: QueueState }
  | {
      __typename: 'QueueItemAdded';
      sequence: number;
      stateHash: string;
      stateHashOrdered?: string | null;
      addedItem: ClimbQueueItem;
      position?: number | null;
      /** Connection id of the adding client; optional so legacy/replayed payloads still typecheck. */
      clientId?: string | null;
    }
  | {
      __typename: 'QueueItemRemoved';
      sequence: number;
      stateHash: string;
      stateHashOrdered?: string | null;
      uuid: string;
      /** Connection id of the removing client; optional so legacy/replayed payloads still typecheck. */
      clientId?: string | null;
    }
  | {
      __typename: 'QueueReordered';
      sequence: number;
      stateHash: string;
      stateHashOrdered?: string | null;
      uuid: string;
      oldIndex: number;
      newIndex: number;
    }
  | {
      __typename: 'CurrentClimbChanged';
      sequence: number;
      stateHash: string;
      stateHashOrdered?: string | null;
      currentItem: ClimbQueueItem | null;
      frames?: string | null;
      clientId: string | null;
      correlationId: string | null;
    }
  | {
      __typename: 'ClimbMirrored';
      sequence: number;
      stateHash: string;
      stateHashOrdered?: string | null;
      mirroredUuid?: string | null;
      mirrored: boolean;
    }
  | PlaybackStateChangedEvent;

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
  // Set only by HTTP cron bearer authentication; never grants user access.
  isCronAuthenticated?: boolean;
  // Client IP for rate limiting anonymous callers on both transports: HTTP
  // sets it in graphql/yoga.ts, WebSocket in websocket/setup.ts via
  // resolveWebSocketClientIp (issue #2863).
  clientIp?: string;
  // Normalized address of the TCP peer for WebSocket upgrades. This is kept
  // separately from clientIp so a direct-origin caller cannot evade the
  // secondary rate-limit bucket by forging cf-connecting-ip (issue #4038).
  socketPeerIp?: string;
  // Controller-specific context (set when using API key auth)
  controllerId?: string;
  controllerApiKey?: string;
  controllerMac?: string; // Controller's MAC address (used as clientId for BLE disconnect logic)
};
