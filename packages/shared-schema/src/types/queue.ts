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

/**
 * Full board configuration a queue item is meant to render + send against.
 * Denormalized onto the queue item so multi-board queues don't need a
 * per-render DB lookup to resolve a saved `UserBoard`.
 */
export type BoardConfig = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: number[];
  angle: number;
};

export type BoardConfigInput = BoardConfig;

export type ClimbQueueItem = {
  uuid: string;
  climb: Climb;
  addedBy?: UserId;
  addedByUser?: QueueItemUser;
  tickedBy?: UserId[];
  suggested?: boolean;
  boardConfig?: BoardConfig | null;
  boardId?: string | null;
};

// Input type for ClimbQueueItem (matches GraphQL ClimbQueueItemInput)
export type ClimbQueueItemInput = {
  uuid: string;
  climb: ClimbInput;
  addedBy?: string | null;
  addedByUser?: QueueItemUserInput | null;
  tickedBy?: string[] | null;
  suggested?: boolean | null;
  boardConfig?: BoardConfigInput | null;
  boardId?: string | null;
};

export type QueueState = {
  sequence: number;
  stateHash: string;
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
};
