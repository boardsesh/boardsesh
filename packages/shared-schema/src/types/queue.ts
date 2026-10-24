// Queue types

import type { UserId } from './user';
import type { Climb, ClimbInput } from './climb';

export type QueueItemUser = {
  id: string;
  username: string;
  avatarUrl?: string | null; // GraphQL nullable String
};

// Input type for QueueItemUser (matches GraphQL QueueItemUserInput)
export type QueueItemUserInput = {
  id: string;
  username: string;
  avatarUrl?: string | null;
};

export type ClimbQueueItem = {
  uuid: string;
  climb: Climb;
  addedBy?: UserId;
  addedByUser?: QueueItemUser;
  tickedBy?: UserId[];
  suggested?: boolean;
};

// Input type for ClimbQueueItem (matches GraphQL ClimbQueueItemInput)
export type ClimbQueueItemInput = {
  uuid: string;
  climb: ClimbInput;
  addedBy?: string | null;
  addedByUser?: QueueItemUserInput | null;
  tickedBy?: string[] | null;
  suggested?: boolean | null;
};

export type QueueState = {
  sequence: number;
  stateHash: string;
  /** Order-sensitive hash (v2). Optional during the dual-hash rollout: old
   *  backends omit it, new backends always send it. See
   *  `computeQueueStateHashOrdered` in `@boardsesh/queue`. */
  stateHashOrdered?: string | null;
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  /** Entries before Up next (F3, docs/current-climb-outside-queue.md). Equals the
   *  current index while a climb is current. Absent or null from a pre-F3 server. */
  historyCount?: number | null;
  /** When the current climb last changed to a different climb, ISO 8601. Absent
   *  or null from a pre-F3 server. */
  currentChangedAt?: string | null;
};
