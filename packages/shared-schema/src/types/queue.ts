// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

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
};
